//! Bounded, resumable library-owner rewrite for Navidrome canonical IDs.

use std::path::{Path, PathBuf};

mod album;
mod artist;
mod track;

use rusqlite::{params, Connection, OptionalExtension, Transaction};

use crate::navidrome_payload_codec::NavidromePayloadKind;
use crate::store::LibraryStore;

const MAX_BATCH_LIMIT: u32 = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum NavidromeNativeMigrationStep {
    Artist,
    Album,
    Track,
}

impl NavidromeNativeMigrationStep {
    fn table(self) -> &'static str {
        match self {
            Self::Artist => "artist",
            Self::Album => "album",
            Self::Track => "track",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NavidromeNativeMigrationBatchDto {
    pub step: NavidromeNativeMigrationStep,
    pub cursor_rowid: i64,
    pub upper_rowid: i64,
    pub processed: u32,
    pub moved: u32,
    pub merged: u32,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NavidromeNativeMigrationFinalizeDto {
    pub derived_rows_removed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NavidromeNativeMigrationPreflightDto {
    pub artists_scanned: u64,
    pub albums_scanned: u64,
    pub tracks_scanned: u64,
}

#[derive(Debug, Default)]
pub(super) struct BatchMutationStats {
    pub processed: u32,
    pub moved: u32,
    pub merged: u32,
    pub last_rowid: i64,
}

pub fn upper_rowid(
    store: &LibraryStore,
    server_id: &str,
    step: NavidromeNativeMigrationStep,
) -> Result<i64, String> {
    validate_server_id(server_id)?;
    let sql = format!(
        "SELECT COALESCE(MAX(rowid), 0) FROM {} WHERE server_id = ?1",
        step.table()
    );
    store
        .with_read_conn(|conn| conn.query_row(&sql, params![server_id], |row| row.get(0)))
        .map_err(|error| error.to_string())
}

pub fn run_batch(
    store: &LibraryStore,
    server_id: &str,
    step: NavidromeNativeMigrationStep,
    cursor_rowid: i64,
    upper_rowid: i64,
    limit: u32,
) -> Result<NavidromeNativeMigrationBatchDto, String> {
    validate_server_id(server_id)?;
    if cursor_rowid < 0 || upper_rowid < 0 || cursor_rowid > upper_rowid {
        return Err(format!(
            "invalid native migration rowid range {cursor_rowid}..={upper_rowid}"
        ));
    }
    if limit == 0 || limit > MAX_BATCH_LIMIT {
        return Err(format!(
            "native migration batch limit must be between 1 and {MAX_BATCH_LIMIT}"
        ));
    }

    let stats = store.with_conn_mut("navidrome_native_migration.batch", |conn| {
        let tx = conn.transaction()?;
        prepare_batch_mapping(&tx, step)?;
        let stats = match step {
            NavidromeNativeMigrationStep::Artist => {
                artist::run_batch(&tx, server_id, cursor_rowid, upper_rowid, limit)?
            }
            NavidromeNativeMigrationStep::Album => {
                album::run_batch(&tx, server_id, cursor_rowid, upper_rowid, limit)?
            }
            NavidromeNativeMigrationStep::Track => {
                track::run_batch(&tx, server_id, cursor_rowid, upper_rowid, limit)?
            }
        };
        tx.commit()?;
        Ok(stats)
    })?;

    let cursor_rowid = if stats.processed < limit {
        upper_rowid
    } else {
        stats.last_rowid
    };
    Ok(NavidromeNativeMigrationBatchDto {
        step,
        cursor_rowid,
        upper_rowid,
        processed: stats.processed,
        moved: stats.moved,
        merged: stats.merged,
        done: cursor_rowid >= upper_rowid,
    })
}

pub fn preflight(
    store: &LibraryStore,
    server_id: &str,
) -> Result<NavidromeNativeMigrationPreflightDto, String> {
    validate_server_id(server_id)?;
    store.with_conn_mut("navidrome_native_migration.preflight", |conn| {
        let tx = conn.transaction()?;
        let result = NavidromeNativeMigrationPreflightDto {
            artists_scanned: artist::preflight(&tx, server_id)?,
            albums_scanned: album::preflight(&tx, server_id)?,
            tracks_scanned: track::preflight(&tx, server_id)?,
        };
        tx.commit()?;
        Ok(result)
    })
}

pub fn finalize(
    store: &LibraryStore,
    server_id: &str,
) -> Result<NavidromeNativeMigrationFinalizeDto, String> {
    validate_server_id(server_id)?;
    store.with_conn_mut("navidrome_native_migration.finalize", |conn| {
        let tx = conn.transaction()?;
        let mut removed = 0u64;
        for (table, column) in [
            ("track_genre", "server_id"),
            ("album_browse_projection", "server_id"),
            ("composer_album_projection", "server_id"),
            ("artist_artwork_lookup", "server_id"),
            ("identity_invalidation", "server_id"),
            ("library_tag_state", "server_id"),
            ("library_tag_cursor", "server_id"),
            ("sync_state", "server_id"),
        ] {
            removed = removed.saturating_add(tx.execute(
                &format!("DELETE FROM {table} WHERE {column} = ?1"),
                params![server_id],
            )? as u64);
        }
        removed = removed.saturating_add(tx.execute(
            "DELETE FROM cluster.track_cluster_key WHERE server_id = ?1",
            params![server_id],
        )? as u64);
        tx.execute(
            "DELETE FROM cluster.cluster_meta WHERE key = ?1",
            params![format!("dirty_server:{server_id}")],
        )?;
        tx.execute(
            "INSERT INTO identity_invalidation (server_id, kind, entity_id) \
             VALUES (?1, 'server', '') \
             ON CONFLICT(server_id, kind, entity_id) DO NOTHING",
            params![server_id],
        )?;
        tx.execute(
            "DELETE FROM library_data_migration WHERE id IN (?1, ?2, ?3)",
            params![
                crate::genre_tags_backfill::GENRE_TAGS_MIGRATION_ID,
                crate::browse_projection::MIGRATION_ID,
                crate::composer_projection::MIGRATION_ID
            ],
        )?;
        verify_no_legacy_library_ids(&tx, server_id)?;
        crate::track_fts::rebuild_track_fts_from_content(&tx)?;
        tx.commit()?;
        Ok(NavidromeNativeMigrationFinalizeDto {
            derived_rows_removed: removed,
        })
    })
}

pub fn retarget_offline_paths(
    store: &LibraryStore,
    server_id: &str,
    path_changes: &[(String, String)],
) -> Result<u64, String> {
    validate_server_id(server_id)?;
    store.with_conn_mut(
        "navidrome_native_migration.retarget_offline_paths",
        |conn| {
            let tx = conn.transaction()?;
            let mut updated = 0u64;
            for (old_path, new_path) in path_changes {
                updated = updated.saturating_add(tx.execute(
                    "UPDATE track_offline SET local_path = ?1 \
                     WHERE server_id = ?2 AND local_path = ?3",
                    params![new_path, server_id, old_path],
                )? as u64);
            }
            tx.commit()?;
            Ok(updated)
        },
    )
}

pub fn reconcile_offline_paths(
    store: &LibraryStore,
    server_id: &str,
    offline_dir: &Path,
    path_changes: &[(String, String)],
) -> Result<u64, String> {
    validate_server_id(server_id)?;
    store.with_conn_mut(
        "navidrome_native_migration.reconcile_offline_paths",
        |conn| {
            let tx = conn.transaction()?;
            let mut changes = path_changes.to_vec();
            let local_paths = {
                let mut statement =
                    tx.prepare("SELECT local_path FROM track_offline WHERE server_id = ?1")?;
                let rows = statement
                    .query_map(params![server_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            for local_path in local_paths {
                let source = PathBuf::from(&local_path);
                let Some(destination) = canonical_flat_cache_destination(&source, offline_dir)
                else {
                    continue;
                };
                if source.exists()
                    || !destination.is_file()
                    || changes.iter().any(|(old_path, _)| old_path == &local_path)
                {
                    continue;
                }
                changes.push((local_path, destination.to_string_lossy().to_string()));
            }

            let mut updated = 0u64;
            for (old_path, new_path) in changes {
                updated = updated.saturating_add(tx.execute(
                    "UPDATE track_offline SET local_path = ?1 \
                     WHERE server_id = ?2 AND local_path = ?3",
                    params![new_path, server_id, old_path],
                )? as u64);
            }
            tx.commit()?;
            Ok(updated)
        },
    )
}

pub fn verify_offline_paths(
    store: &LibraryStore,
    server_id: &str,
    offline_dir: &Path,
) -> Result<(), String> {
    validate_server_id(server_id)?;
    store.with_read_conn(|conn| {
        let mut statement =
            conn.prepare("SELECT local_path FROM track_offline WHERE server_id = ?1")?;
        let local_paths = statement
            .query_map(params![server_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for local_path in local_paths {
            let source = PathBuf::from(local_path);
            if let Some(destination) = canonical_flat_cache_destination(&source, offline_dir) {
                return Err(migration_error(format!(
                    "native migration residue in track_offline.local_path: `{}` -> `{}`",
                    source.display(),
                    destination.display()
                )));
            }
        }
        Ok(())
    })
}

fn canonical_flat_cache_destination(path: &Path, offline_dir: &Path) -> Option<PathBuf> {
    if path.parent() != Some(offline_dir) {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    if name.ends_with(".part") {
        return None;
    }
    let (old_id, suffix) = name.split_once('.')?;
    let new_id = crate::navidrome_id_codec::canonical_id(old_id);
    (new_id != old_id).then(|| offline_dir.join(format!("{new_id}.{suffix}")))
}

pub fn verify(store: &LibraryStore, server_id: &str) -> Result<(), String> {
    validate_server_id(server_id)?;
    store
        .with_read_conn(|conn| verify_no_legacy_library_ids(conn, server_id))
        .map_err(|error| error.to_string())
}

fn verify_no_legacy_library_ids(tx: &Connection, server_id: &str) -> rusqlite::Result<()> {
    for (table, server_column, column, condition, artwork) in [
        ("artist", "server_id", "id", "", false),
        ("album", "server_id", "id", "", false),
        (
            "album",
            "server_id",
            "artist_id",
            "artist_id IS NOT NULL",
            false,
        ),
        (
            "album",
            "server_id",
            "cover_art_id",
            "cover_art_id IS NOT NULL",
            true,
        ),
        ("track", "server_id", "id", "", false),
        (
            "track",
            "server_id",
            "artist_id",
            "artist_id IS NOT NULL",
            false,
        ),
        (
            "track",
            "server_id",
            "album_id",
            "album_id IS NOT NULL",
            false,
        ),
        (
            "track",
            "server_id",
            "library_id",
            "library_id IS NOT NULL",
            false,
        ),
        (
            "track",
            "server_id",
            "cover_art_id",
            "cover_art_id IS NOT NULL",
            true,
        ),
        ("track_offline", "server_id", "track_id", "", false),
        ("track_extension", "server_id", "track_id", "", false),
        ("track_fact", "server_id", "track_id", "", false),
        ("track_artifact", "server_id", "track_id", "", false),
        ("track_canonical_link", "server_id", "track_id", "", false),
        (
            "canonical_enrichment_link",
            "owner_server_id",
            "owner_track_id",
            "",
            false,
        ),
        ("play_session", "server_id", "track_id", "", false),
        (
            "entity_user_rating",
            "server_id",
            "entity_id",
            "entity_kind IN ('artist', 'album', 'track')",
            false,
        ),
        ("track_id_history", "server_id", "new_id", "", false),
    ] {
        let where_suffix = if condition.is_empty() {
            String::new()
        } else {
            format!(" AND {condition}")
        };
        let sql = format!("SELECT {column} FROM {table} WHERE {server_column} = ?1{where_suffix}");
        let mut statement = tx.prepare(&sql)?;
        let values = statement
            .query_map(params![server_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if let Some(value) = values.into_iter().find(|value| {
            let canonical = if artwork {
                crate::navidrome_id_codec::canonical_artwork_id(value)
            } else {
                crate::navidrome_id_codec::canonical_id(value)
            };
            canonical != *value
        }) {
            return Err(migration_error(format!(
                "native migration residue in {table}.{column}: `{value}`"
            )));
        }
    }

    for (table, kind) in [
        ("artist", NavidromePayloadKind::Artist),
        ("album", NavidromePayloadKind::Album),
        ("track", NavidromePayloadKind::Track),
    ] {
        let sql = format!("SELECT raw_json FROM {table} WHERE server_id = ?1");
        let mut statement = tx.prepare(&sql)?;
        let payloads = statement
            .query_map(params![server_id], |row| row.get::<_, Option<String>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for payload in payloads {
            let canonical =
                crate::navidrome_payload_codec::canonical_payload(payload.as_deref(), kind)
                    .map_err(migration_error)?;
            if canonical != payload {
                return Err(migration_error(format!(
                    "native migration JSON residue in {table}.raw_json"
                )));
            }
        }
    }
    Ok(())
}

fn validate_server_id(server_id: &str) -> Result<(), String> {
    if server_id.trim().is_empty() {
        Err("native migration server id must not be empty".to_string())
    } else {
        Ok(())
    }
}

fn prepare_batch_mapping(
    tx: &Transaction<'_>,
    step: NavidromeNativeMigrationStep,
) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS navidrome_id_batch_mapping (
           entity_kind TEXT NOT NULL,
           source_rowid INTEGER NOT NULL,
           old_id TEXT NOT NULL,
           new_id TEXT NOT NULL,
           PRIMARY KEY (entity_kind, old_id)
         ) WITHOUT ROWID;
         DELETE FROM navidrome_id_batch_mapping;",
    )?;
    tx.execute(
        "DELETE FROM navidrome_id_batch_mapping WHERE entity_kind != ?1",
        params![step.table()],
    )?;
    Ok(())
}

pub(super) fn record_mapping(
    tx: &Transaction<'_>,
    entity_kind: &str,
    source_rowid: i64,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO navidrome_id_batch_mapping (entity_kind, source_rowid, old_id, new_id) \
         VALUES (?1, ?2, ?3, ?4)",
        params![entity_kind, source_rowid, old_id, new_id],
    )?;
    Ok(())
}

pub(super) fn retarget_entity_rating(
    tx: &Transaction<'_>,
    server_id: &str,
    entity_kind: &str,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<()> {
    if old_id == new_id {
        return Ok(());
    }
    let source: Option<(i64, i64)> = tx
        .query_row(
            "SELECT rating, fetched_at FROM entity_user_rating \
             WHERE server_id = ?1 AND entity_kind = ?2 AND entity_id = ?3",
            params![server_id, entity_kind, old_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((source_rating, source_fetched_at)) = source else {
        return Ok(());
    };
    let destination: Option<(i64, i64)> = tx
        .query_row(
            "SELECT rating, fetched_at FROM entity_user_rating \
             WHERE server_id = ?1 AND entity_kind = ?2 AND entity_id = ?3",
            params![server_id, entity_kind, new_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match destination {
        None => {
            tx.execute(
                "UPDATE entity_user_rating SET entity_id = ?1 \
                 WHERE server_id = ?2 AND entity_kind = ?3 AND entity_id = ?4",
                params![new_id, server_id, entity_kind, old_id],
            )?;
        }
        Some((_, destination_fetched_at)) => {
            if source_fetched_at > destination_fetched_at {
                tx.execute(
                    "UPDATE entity_user_rating SET rating = ?1, fetched_at = ?2 \
                     WHERE server_id = ?3 AND entity_kind = ?4 AND entity_id = ?5",
                    params![
                        source_rating,
                        source_fetched_at,
                        server_id,
                        entity_kind,
                        new_id
                    ],
                )?;
            }
            tx.execute(
                "DELETE FROM entity_user_rating \
                 WHERE server_id = ?1 AND entity_kind = ?2 AND entity_id = ?3",
                params![server_id, entity_kind, old_id],
            )?;
        }
    }
    Ok(())
}

pub(super) fn canonical_optional_id(value: Option<String>) -> Option<String> {
    value.map(|value| crate::navidrome_id_codec::canonical_id(&value))
}

pub(super) fn canonical_optional_artwork(value: Option<String>) -> Option<String> {
    value.map(|value| crate::navidrome_id_codec::canonical_artwork_id(&value))
}

pub(super) fn migration_error(message: impl Into<String>) -> rusqlite::Error {
    #[derive(Debug)]
    struct MigrationError(String);

    impl std::fmt::Display for MigrationError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str(&self.0)
        }
    }

    impl std::error::Error for MigrationError {}

    rusqlite::Error::UserFunctionError(Box::new(MigrationError(message.into())))
}

pub(super) fn stable_json_identity_matches(
    destination: Option<&str>,
    source: Option<&str>,
    keys: &[&str],
) -> Result<bool, String> {
    let Some(destination) = destination.filter(|value| !value.trim().is_empty()) else {
        return Ok(false);
    };
    let Some(source) = source.filter(|value| !value.trim().is_empty()) else {
        return Ok(false);
    };
    let destination: serde_json::Value = serde_json::from_str(destination)
        .map_err(|error| format!("invalid destination identity payload: {error}"))?;
    let source: serde_json::Value = serde_json::from_str(source)
        .map_err(|error| format!("invalid source identity payload: {error}"))?;
    let mut matched = false;
    for key in keys {
        let destination = destination.get(key).and_then(serde_json::Value::as_str);
        let source = source.get(key).and_then(serde_json::Value::as_str);
        if let (Some(destination), Some(source)) = (destination, source) {
            if destination != source {
                return Err(format!("contradictory payload identity field `{key}`"));
            }
            if !destination.is_empty() {
                matched = true;
            }
        }
    }
    Ok(matched)
}

#[cfg(test)]
mod tests;
