use rusqlite::{params, OptionalExtension, Transaction};

use super::{
    migration_error, record_mapping, retarget_entity_rating, stable_json_identity_matches,
    BatchMutationStats,
};
use crate::navidrome_id_codec::{canonical_id, is_lossless_legacy_id};
use crate::navidrome_payload_codec::{
    canonical_payload, merge_canonical_payloads, NavidromePayloadKind,
};

#[derive(Debug, Clone)]
struct ArtistOwner {
    rowid: i64,
    id: String,
    name: String,
    album_count: Option<i64>,
    synced_at: i64,
    raw_json: Option<String>,
    name_sort: Option<String>,
    name_fold: Option<String>,
}

pub(super) fn preflight(tx: &Transaction<'_>, server_id: &str) -> rusqlite::Result<u64> {
    let upper_rowid: i64 = tx.query_row(
        "SELECT COALESCE(MAX(rowid), 0) FROM artist WHERE server_id = ?1",
        params![server_id],
        |row| row.get(0),
    )?;
    let mut cursor_rowid = 0;
    let mut scanned = 0u64;
    loop {
        let rows = load_batch(tx, server_id, cursor_rowid, upper_rowid, super::MAX_BATCH_LIMIT)?;
        let Some(last_rowid) = rows.last().map(|row| row.rowid) else {
            break;
        };
        for source in &rows {
            canonical_payload(source.raw_json.as_deref(), NavidromePayloadKind::Artist)
                .map_err(migration_error)?;
            let destination_id = canonical_id(&source.id);
            if source.id != destination_id {
                if let Some(destination) = load_owner(tx, server_id, &destination_id)? {
                    ensure_equivalent(&destination, source)?;
                }
            }
        }
        scanned = scanned.saturating_add(rows.len() as u64);
        cursor_rowid = last_rowid;
        if cursor_rowid >= upper_rowid {
            break;
        }
    }
    Ok(scanned)
}

pub(super) fn run_batch(
    tx: &Transaction<'_>,
    server_id: &str,
    cursor_rowid: i64,
    upper_rowid: i64,
    limit: u32,
) -> rusqlite::Result<BatchMutationStats> {
    let rows = load_batch(tx, server_id, cursor_rowid, upper_rowid, limit)?;
    for row in &rows {
        record_mapping(tx, "artist", row.rowid, &row.id, &canonical_id(&row.id))?;
        canonical_payload(row.raw_json.as_deref(), NavidromePayloadKind::Artist)
            .map_err(migration_error)?;
    }

    let mut stats = BatchMutationStats::default();
    for selected in rows {
        stats.processed += 1;
        stats.last_rowid = selected.rowid;
        let Some(source) = load_owner(tx, server_id, &selected.id)? else {
            continue;
        };
        let old_id = source.id.clone();
        let destination_id = canonical_id(&source.id);
        if source.id == destination_id {
            let raw_json = canonical_payload(
                source.raw_json.as_deref(),
                NavidromePayloadKind::Artist,
            )
            .map_err(migration_error)?;
            tx.execute(
                "UPDATE artist SET raw_json = ?1 WHERE server_id = ?2 AND id = ?3",
                params![raw_json, server_id, source.id],
            )?;
            continue;
        }

        let destination = load_owner(tx, server_id, &destination_id)?;
        if let Some(destination) = destination.as_ref() {
            ensure_equivalent(destination, &source)?;
        }
        let merged = match destination {
            Some(destination) => {
                stats.merged += 1;
                merge_owner(destination, source, destination_id.clone())?
            }
            None => {
                stats.moved += 1;
                canonicalize_owner(source, destination_id.clone())?
            }
        };
        write_owner(tx, server_id, &merged)?;
        tx.execute(
            "UPDATE album SET artist_id = ?1 WHERE server_id = ?2 AND artist_id = ?3",
            params![destination_id, server_id, old_id],
        )?;
        tx.execute(
            "UPDATE track SET artist_id = ?1 WHERE server_id = ?2 AND artist_id = ?3",
            params![destination_id, server_id, old_id],
        )?;

        retarget_entity_rating(tx, server_id, "artist", &old_id, &destination_id)?;
        tx.execute(
            "DELETE FROM artist WHERE server_id = ?1 AND id = ?2",
            params![server_id, old_id],
        )?;
        verify_retarget(tx, server_id, &old_id, &destination_id)?;
    }
    Ok(stats)
}

fn load_batch(
    tx: &Transaction<'_>,
    server_id: &str,
    cursor_rowid: i64,
    upper_rowid: i64,
    limit: u32,
) -> rusqlite::Result<Vec<ArtistOwner>> {
    let mut statement = tx.prepare(
        "SELECT rowid, id, name, album_count, synced_at, raw_json, name_sort, name_fold \
         FROM artist WHERE server_id = ?1 AND rowid > ?2 AND rowid <= ?3 \
         ORDER BY rowid LIMIT ?4",
    )?;
    let rows = statement
        .query_map(
            params![server_id, cursor_rowid, upper_rowid, i64::from(limit)],
            row_to_owner,
        )?
        .collect();
    rows
}

fn load_owner(
    tx: &Transaction<'_>,
    server_id: &str,
    id: &str,
) -> rusqlite::Result<Option<ArtistOwner>> {
    tx.query_row(
        "SELECT rowid, id, name, album_count, synced_at, raw_json, name_sort, name_fold \
         FROM artist WHERE server_id = ?1 AND id = ?2",
        params![server_id, id],
        row_to_owner,
    )
    .optional()
}

fn row_to_owner(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtistOwner> {
    Ok(ArtistOwner {
        rowid: row.get(0)?,
        id: row.get(1)?,
        name: row.get(2)?,
        album_count: row.get(3)?,
        synced_at: row.get(4)?,
        raw_json: row.get(5)?,
        name_sort: row.get(6)?,
        name_fold: row.get(7)?,
    })
}

fn ensure_equivalent(destination: &ArtistOwner, source: &ArtistOwner) -> rusqlite::Result<()> {
    if is_lossless_legacy_id(&source.id) {
        return Ok(());
    }
    let matches = stable_json_identity_matches(
        destination.raw_json.as_deref(),
        source.raw_json.as_deref(),
        &["musicBrainzId", "mbzArtistId"],
    )
    .map_err(migration_error)?;
    if matches {
        Ok(())
    } else {
        Err(migration_error(format!(
            "unproven Navidrome artist collision `{}` -> `{}`",
            source.id, destination.id
        )))
    }
}

fn canonicalize_owner(
    mut source: ArtistOwner,
    destination_id: String,
) -> rusqlite::Result<ArtistOwner> {
    source.id = destination_id;
    source.raw_json = canonical_payload(
        source.raw_json.as_deref(),
        NavidromePayloadKind::Artist,
    )
    .map_err(migration_error)?;
    Ok(source)
}

fn merge_owner(
    destination: ArtistOwner,
    source: ArtistOwner,
    destination_id: String,
) -> rusqlite::Result<ArtistOwner> {
    Ok(ArtistOwner {
        rowid: destination.rowid,
        id: destination_id,
        name: prefer_text(destination.name, source.name),
        album_count: max_optional(destination.album_count, source.album_count),
        synced_at: destination.synced_at.max(source.synced_at),
        raw_json: merge_canonical_payloads(
            destination.raw_json.as_deref(),
            source.raw_json.as_deref(),
            NavidromePayloadKind::Artist,
        )
        .map_err(migration_error)?,
        name_sort: destination.name_sort.or(source.name_sort),
        name_fold: destination.name_fold.or(source.name_fold),
    })
}

fn write_owner(
    tx: &Transaction<'_>,
    server_id: &str,
    owner: &ArtistOwner,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO artist \
           (server_id, id, name, album_count, synced_at, raw_json, name_sort, name_fold) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(server_id, id) DO UPDATE SET \
           name = excluded.name, album_count = excluded.album_count, \
           synced_at = excluded.synced_at, raw_json = excluded.raw_json, \
           name_sort = excluded.name_sort, name_fold = excluded.name_fold",
        params![
            server_id,
            owner.id,
            owner.name,
            owner.album_count,
            owner.synced_at,
            owner.raw_json,
            owner.name_sort,
            owner.name_fold
        ],
    )?;
    Ok(())
}

fn verify_retarget(
    tx: &Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<()> {
    let destination_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM artist WHERE server_id = ?1 AND id = ?2)",
        params![server_id, new_id],
        |row| row.get(0),
    )?;
    let residue: i64 = tx.query_row(
        "SELECT \
           (SELECT COUNT(*) FROM artist WHERE server_id = ?1 AND id = ?2) + \
           (SELECT COUNT(*) FROM album WHERE server_id = ?1 AND artist_id = ?2) + \
           (SELECT COUNT(*) FROM track WHERE server_id = ?1 AND artist_id = ?2) + \
           (SELECT COUNT(*) FROM entity_user_rating \
              WHERE server_id = ?1 AND entity_kind = 'artist' AND entity_id = ?2)",
        params![server_id, old_id],
        |row| row.get(0),
    )?;
    if destination_exists && residue == 0 {
        Ok(())
    } else {
        Err(migration_error(format!(
            "artist retarget verification failed `{old_id}` -> `{new_id}`"
        )))
    }
}

fn prefer_text(destination: String, source: String) -> String {
    if destination.trim().is_empty() {
        source
    } else {
        destination
    }
}

fn max_optional(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}
