use std::path::Path;

use rusqlite::{params, OptionalExtension, Transaction};

#[derive(Debug)]
struct TrackRetargetConflict(String);

impl std::fmt::Display for TrackRetargetConflict {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for TrackRetargetConflict {}

fn conflict(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::UserFunctionError(Box::new(TrackRetargetConflict(message.into())))
}

#[derive(Debug)]
struct OfflineRow {
    local_path: String,
    file_size_bytes: Option<i64>,
    suffix: Option<String>,
    content_hash: String,
    server_path: Option<String>,
    cached_at: i64,
    last_verified_at: Option<i64>,
}

pub(crate) fn retarget_track_references(
    tx: &Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
    content_hash: Option<&str>,
    server_path: Option<&str>,
    remapped_at: i64,
) -> rusqlite::Result<()> {
    if old_id == new_id {
        return Ok(());
    }

    retarget_offline(tx, server_id, old_id, new_id)?;
    retarget_extensions(tx, server_id, old_id, new_id)?;
    retarget_facts(tx, server_id, old_id, new_id, remapped_at)?;
    retarget_artifacts(tx, server_id, old_id, new_id)?;
    retarget_canonical_link(tx, server_id, old_id, new_id)?;
    retarget_enrichment_links(tx, server_id, old_id, new_id)?;
    retarget_rating(tx, server_id, old_id, new_id)?;

    tx.execute(
        "UPDATE play_session SET track_id = ?1 WHERE server_id = ?2 AND track_id = ?3",
        params![new_id, server_id, old_id],
    )?;
    tx.execute(
        "DELETE FROM track_genre WHERE server_id = ?1 AND track_id = ?2",
        params![server_id, old_id],
    )?;

    let existing_alias: Option<String> = tx
        .query_row(
            "SELECT new_id FROM track_id_history WHERE server_id = ?1 AND old_id = ?2",
            params![server_id, old_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing) = existing_alias.as_deref() {
        if crate::navidrome_id_codec::canonical_id(existing) != new_id {
            return Err(conflict(format!(
                "track alias conflict for server `{server_id}` old `{old_id}`: `{existing}` vs `{new_id}`"
            )));
        }
    }
    tx.execute(
        "UPDATE track_id_history SET new_id = ?1 WHERE server_id = ?2 AND new_id = ?3",
        params![new_id, server_id, old_id],
    )?;
    tx.execute(
        "INSERT INTO track_id_history \
         (server_id, old_id, new_id, content_hash, server_path, remapped_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(server_id, old_id) DO UPDATE SET \
           new_id = excluded.new_id, \
           content_hash = COALESCE(NULLIF(excluded.content_hash, ''), track_id_history.content_hash), \
           server_path = COALESCE(NULLIF(excluded.server_path, ''), track_id_history.server_path), \
           remapped_at = MAX(track_id_history.remapped_at, excluded.remapped_at)",
        params![
            server_id,
            old_id,
            new_id,
            content_hash,
            server_path,
            remapped_at
        ],
    )?;
    tx.execute(
        "DELETE FROM track WHERE server_id = ?1 AND id = ?2",
        params![server_id, old_id],
    )?;
    Ok(())
}

fn retarget_offline(
    tx: &Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<()> {
    let load = |track_id: &str| {
        tx.query_row(
            "SELECT local_path, file_size_bytes, suffix, content_hash, server_path, \
                    cached_at, last_verified_at \
             FROM track_offline WHERE server_id = ?1 AND track_id = ?2",
            params![server_id, track_id],
            |row| {
                Ok(OfflineRow {
                    local_path: row.get(0)?,
                    file_size_bytes: row.get(1)?,
                    suffix: row.get(2)?,
                    content_hash: row.get(3)?,
                    server_path: row.get(4)?,
                    cached_at: row.get(5)?,
                    last_verified_at: row.get(6)?,
                })
            },
        )
        .optional()
    };
    let Some(old) = load(old_id)? else {
        return Ok(());
    };
    let Some(destination) = load(new_id)? else {
        tx.execute(
            "UPDATE track_offline SET track_id = ?1 WHERE server_id = ?2 AND track_id = ?3",
            params![new_id, server_id, old_id],
        )?;
        return Ok(());
    };

    let old_exists = Path::new(&old.local_path).is_file();
    let destination_exists = Path::new(&destination.local_path).is_file();
    let same_hash = !old.content_hash.is_empty()
        && !destination.content_hash.is_empty()
        && old.content_hash == destination.content_hash;
    let same_path = old.local_path == destination.local_path;
    if old_exists && destination_exists && !same_hash && !same_path {
        return Err(conflict(format!(
            "offline cache conflict for server `{server_id}` tracks `{old_id}` and `{new_id}`"
        )));
    }

    let preferred = if old_exists && !destination_exists {
        &old
    } else {
        &destination
    };
    tx.execute(
        "UPDATE track_offline SET local_path = ?1, file_size_bytes = ?2, suffix = ?3, \
           content_hash = ?4, server_path = ?5, cached_at = ?6, last_verified_at = ?7 \
         WHERE server_id = ?8 AND track_id = ?9",
        params![
            preferred.local_path,
            preferred
                .file_size_bytes
                .or(old.file_size_bytes)
                .or(destination.file_size_bytes),
            preferred
                .suffix
                .as_ref()
                .or(old.suffix.as_ref())
                .or(destination.suffix.as_ref()),
            if preferred.content_hash.is_empty() {
                old.content_hash.as_str()
            } else {
                preferred.content_hash.as_str()
            },
            preferred
                .server_path
                .as_ref()
                .or(old.server_path.as_ref())
                .or(destination.server_path.as_ref()),
            old.cached_at.max(destination.cached_at),
            old.last_verified_at.max(destination.last_verified_at),
            server_id,
            new_id,
        ],
    )?;
    tx.execute(
        "DELETE FROM track_offline WHERE server_id = ?1 AND track_id = ?2",
        params![server_id, old_id],
    )?;
    Ok(())
}

fn retarget_extensions(
    tx: &Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<()> {
    let rows = {
        let mut statement = tx.prepare(
            "SELECT kind, version, payload, updated_at FROM track_extension \
             WHERE server_id = ?1 AND track_id = ?2",
        )?;
        let rows = statement
            .query_map(params![server_id, old_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (kind, version, payload, updated_at) in rows {
        let destination: Option<(i64, Vec<u8>, i64)> = tx
            .query_row(
                "SELECT version, payload, updated_at FROM track_extension \
                 WHERE server_id = ?1 AND track_id = ?2 AND kind = ?3",
                params![server_id, new_id, kind],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        match destination {
            None => {
                tx.execute(
                    "UPDATE track_extension SET track_id = ?1 \
                     WHERE server_id = ?2 AND track_id = ?3 AND kind = ?4",
                    params![new_id, server_id, old_id, kind],
                )?;
            }
            Some((destination_version, destination_payload, destination_updated_at)) => {
                if version == destination_version && payload != destination_payload {
                    return Err(conflict(format!(
                        "track extension conflict for server `{server_id}` kind `{kind}`"
                    )));
                }
                if version > destination_version
                    || (version == destination_version && updated_at > destination_updated_at)
                {
                    tx.execute(
                        "UPDATE track_extension SET version = ?1, payload = ?2, updated_at = ?3 \
                         WHERE server_id = ?4 AND track_id = ?5 AND kind = ?6",
                        params![version, payload, updated_at, server_id, new_id, kind],
                    )?;
                }
                tx.execute(
                    "DELETE FROM track_extension \
                     WHERE server_id = ?1 AND track_id = ?2 AND kind = ?3",
                    params![server_id, old_id, kind],
                )?;
            }
        }
    }
    Ok(())
}

fn retarget_facts(
    tx: &Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
    remapped_at: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO track_fact (server_id, track_id, fact_kind, value_real, value_int, \
           value_text, unit, source_kind, source_id, source_detail, confidence, content_hash, \
           fetched_at, expires_at) \
         SELECT server_id, ?1, fact_kind, value_real, value_int, value_text, unit, source_kind, \
           source_id, source_detail, confidence, content_hash, fetched_at, expires_at \
         FROM track_fact WHERE server_id = ?2 AND track_id = ?3 \
         ON CONFLICT(server_id, track_id, fact_kind, source_kind, source_id) DO UPDATE SET \
           value_real = excluded.value_real, \
           value_int = excluded.value_int, \
           value_text = excluded.value_text, \
           unit = excluded.unit, \
           source_detail = excluded.source_detail, \
           confidence = excluded.confidence, \
           content_hash = excluded.content_hash, \
           fetched_at = excluded.fetched_at, \
           expires_at = excluded.expires_at \
         WHERE \
           (excluded.expires_at IS NULL OR excluded.expires_at >= ?4) > \
             (track_fact.expires_at IS NULL OR track_fact.expires_at >= ?4) \
           OR ((excluded.expires_at IS NULL OR excluded.expires_at >= ?4) = \
                 (track_fact.expires_at IS NULL OR track_fact.expires_at >= ?4) \
               AND excluded.fetched_at > track_fact.fetched_at)",
        params![new_id, server_id, old_id, remapped_at],
    )?;
    tx.execute(
        "DELETE FROM track_fact WHERE server_id = ?1 AND track_id = ?2",
        params![server_id, old_id],
    )?;
    Ok(())
}

fn retarget_artifacts(
    tx: &Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO track_artifact (server_id, track_id, artifact_kind, format, language, \
           source_kind, source_id, content_text, content_blob, content_bytes, not_found, \
           content_hash, fetched_at, expires_at) \
         SELECT server_id, ?1, artifact_kind, format, language, source_kind, source_id, \
           content_text, content_blob, content_bytes, not_found, content_hash, fetched_at, expires_at \
         FROM track_artifact WHERE server_id = ?2 AND track_id = ?3 \
         ON CONFLICT(server_id, track_id, artifact_kind, source_kind, source_id, format) DO UPDATE SET \
           language = excluded.language, \
           content_text = excluded.content_text, \
           content_blob = excluded.content_blob, \
           content_bytes = excluded.content_bytes, \
           not_found = excluded.not_found, \
           content_hash = excluded.content_hash, \
           fetched_at = excluded.fetched_at, \
           expires_at = excluded.expires_at \
         WHERE \
           (excluded.not_found = 0 AND \
              (excluded.content_bytes > 0 OR excluded.content_text IS NOT NULL \
               OR excluded.content_blob IS NOT NULL)) > \
             (track_artifact.not_found = 0 AND \
                (track_artifact.content_bytes > 0 OR track_artifact.content_text IS NOT NULL \
                 OR track_artifact.content_blob IS NOT NULL)) \
           OR ((excluded.not_found = 0 AND \
                  (excluded.content_bytes > 0 OR excluded.content_text IS NOT NULL \
                   OR excluded.content_blob IS NOT NULL)) = \
                 (track_artifact.not_found = 0 AND \
                    (track_artifact.content_bytes > 0 OR track_artifact.content_text IS NOT NULL \
                     OR track_artifact.content_blob IS NOT NULL)) \
               AND excluded.fetched_at > track_artifact.fetched_at)",
        params![new_id, server_id, old_id],
    )?;
    tx.execute(
        "DELETE FROM track_artifact WHERE server_id = ?1 AND track_id = ?2",
        params![server_id, old_id],
    )?;
    Ok(())
}

fn retarget_canonical_link(
    tx: &Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<()> {
    let old: Option<(String, String, f64, i64)> = tx
        .query_row(
            "SELECT canonical_id, match_method, confidence, linked_at FROM track_canonical_link \
             WHERE server_id = ?1 AND track_id = ?2",
            params![server_id, old_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((canonical_id, match_method, confidence, linked_at)) = old else {
        return Ok(());
    };
    let destination: Option<(String, String, f64, i64)> = tx
        .query_row(
            "SELECT canonical_id, match_method, confidence, linked_at FROM track_canonical_link \
             WHERE server_id = ?1 AND track_id = ?2",
            params![server_id, new_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    match destination {
        None => {
            tx.execute(
                "UPDATE track_canonical_link SET track_id = ?1 \
                 WHERE server_id = ?2 AND track_id = ?3",
                params![new_id, server_id, old_id],
            )?;
        }
        Some((destination_id, _, destination_confidence, destination_linked_at)) => {
            if destination_id != canonical_id {
                return Err(conflict(format!(
                    "canonical track link conflict for server `{server_id}` tracks `{old_id}` and `{new_id}`"
                )));
            }
            if confidence > destination_confidence
                || (confidence == destination_confidence && linked_at > destination_linked_at)
            {
                tx.execute(
                    "UPDATE track_canonical_link SET match_method = ?1, confidence = ?2, linked_at = ?3 \
                     WHERE server_id = ?4 AND track_id = ?5",
                    params![match_method, confidence, linked_at, server_id, new_id],
                )?;
            }
            tx.execute(
                "DELETE FROM track_canonical_link WHERE server_id = ?1 AND track_id = ?2",
                params![server_id, old_id],
            )?;
        }
    }
    Ok(())
}

fn retarget_enrichment_links(
    tx: &Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO canonical_enrichment_link (canonical_id, enrichment_kind, owner_server_id, \
           owner_track_id, share_policy, linked_at) \
         SELECT canonical_id, enrichment_kind, owner_server_id, ?1, share_policy, linked_at \
         FROM canonical_enrichment_link WHERE owner_server_id = ?2 AND owner_track_id = ?3 \
         ON CONFLICT(canonical_id, enrichment_kind, owner_server_id, owner_track_id) DO UPDATE SET \
           share_policy = CASE WHEN excluded.linked_at > canonical_enrichment_link.linked_at \
             THEN excluded.share_policy ELSE canonical_enrichment_link.share_policy END, \
           linked_at = MAX(canonical_enrichment_link.linked_at, excluded.linked_at)",
        params![new_id, server_id, old_id],
    )?;
    tx.execute(
        "DELETE FROM canonical_enrichment_link \
         WHERE owner_server_id = ?1 AND owner_track_id = ?2",
        params![server_id, old_id],
    )?;
    Ok(())
}

fn retarget_rating(
    tx: &Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO entity_user_rating (server_id, entity_kind, entity_id, rating, fetched_at) \
         SELECT server_id, entity_kind, ?1, rating, fetched_at FROM entity_user_rating \
         WHERE server_id = ?2 AND entity_kind = 'track' AND entity_id = ?3 \
         ON CONFLICT(server_id, entity_kind, entity_id) DO UPDATE SET \
           rating = CASE WHEN excluded.fetched_at > entity_user_rating.fetched_at \
             THEN excluded.rating ELSE entity_user_rating.rating END, \
           fetched_at = MAX(entity_user_rating.fetched_at, excluded.fetched_at)",
        params![new_id, server_id, old_id],
    )?;
    tx.execute(
        "DELETE FROM entity_user_rating \
         WHERE server_id = ?1 AND entity_kind = 'track' AND entity_id = ?2",
        params![server_id, old_id],
    )?;
    Ok(())
}
