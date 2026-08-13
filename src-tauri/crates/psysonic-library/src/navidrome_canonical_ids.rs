//! Strict stop-the-world migration for Navidrome's uniform canonical IDs.

use std::collections::{HashMap, HashSet};
use std::io;

use psysonic_integration::subsonic::{SubsonicClient, SubsonicError};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;

use crate::navidrome_id_codec::{canonical_artwork_id, canonical_id};
use crate::store::LibraryStore;

pub const CANONICAL_VERSION: i64 = 1;
const MAX_PROBE_CANDIDATES: usize = 20;

#[derive(Debug, Clone, serde::Serialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalIdMappingDto {
    pub entity_kind: String,
    pub old_id: String,
    pub new_id: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalMigrationDto {
    pub server_id: String,
    pub state: String,
    pub canonical_version: i64,
    pub probe_kind: Option<String>,
    pub probe_old_id: Option<String>,
    pub probe_new_id: Option<String>,
    pub last_error: Option<String>,
    pub mappings: Vec<CanonicalIdMappingDto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntityKind {
    Artist,
    Album,
    Track,
    Folder,
}

impl EntityKind {
    fn label(self) -> &'static str {
        match self {
            Self::Artist => "artist",
            Self::Album => "album",
            Self::Track => "track",
            Self::Folder => "folder",
        }
    }
}

#[derive(Debug, Default)]
struct IdSets {
    artist: HashSet<String>,
    album: HashSet<String>,
    track: HashSet<String>,
    folder: HashSet<String>,
}

impl IdSets {
    fn values_mut(&mut self, kind: EntityKind) -> &mut HashSet<String> {
        match kind {
            EntityKind::Artist => &mut self.artist,
            EntityKind::Album => &mut self.album,
            EntityKind::Track => &mut self.track,
            EntityKind::Folder => &mut self.folder,
        }
    }
}

#[derive(Debug, Default)]
struct IdMaps {
    artist: HashMap<String, String>,
    album: HashMap<String, String>,
    track: HashMap<String, String>,
    folder: HashMap<String, String>,
}

impl IdMaps {
    fn get(&self, kind: EntityKind, value: &str) -> Option<&str> {
        match kind {
            EntityKind::Artist => self.artist.get(value),
            EntityKind::Album => self.album.get(value),
            EntityKind::Track => self.track.get(value),
            EntityKind::Folder => self.folder.get(value),
        }
        .map(String::as_str)
    }
}

#[derive(Debug, Clone)]
struct ProbeCandidate {
    kind: EntityKind,
    old_id: String,
    new_id: String,
}

pub fn status(store: &LibraryStore, server_id: &str) -> Result<CanonicalMigrationDto, String> {
    let server_id = server_id.trim();
    if server_id.is_empty() {
        return Err("server id is required".to_string());
    }
    store.with_read_conn(|conn| read_status(conn, server_id))
}

pub async fn inspect(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
) -> Result<CanonicalMigrationDto, String> {
    let server_id = server_id.trim();
    if server_id.is_empty() {
        return Err("server id is required".to_string());
    }
    let current = status(store, server_id)?;
    if matches!(
        current.state.as_str(),
        "required" | "rewriting" | "frontend" | "ready"
    ) {
        return Ok(current);
    }
    let info = subsonic.server_info().await.map_err(|error| {
        let message = format!("Navidrome identity preflight failed: {error}");
        let _ = record_state(store, server_id, "retryable", None, None, None, Some(&message));
        message
    })?;
    if !matches!(info.server_type.as_deref(), Some(kind) if kind.eq_ignore_ascii_case("navidrome")) {
        record_state(store, server_id, "not_applicable", None, None, None, None)?;
        return status(store, server_id);
    }

    let candidates = collect_probe_candidates(store, server_id)?;
    if candidates.is_empty() {
        if current.state == "resyncing" {
            return Ok(current);
        }
        let sets = store.with_read_conn(|conn| collect_id_sets(conn, server_id))?;
        let legacy = [sets.artist, sets.album, sets.track, sets.folder]
            .into_iter()
            .flatten()
            .find(|value| canonical_id(value) != *value);
        if let Some(value) = legacy {
            let message = format!(
                "legacy ID `{value}` remains, but no live track or album can establish the active namespace"
            );
            record_state(store, server_id, "retryable", None, None, None, Some(&message))?;
            return status(store, server_id);
        }
        prepare_resync_without_rewrite(store, server_id)?;
        return status(store, server_id);
    }

    record_state(store, server_id, "checking", None, None, None, None)?;
    let mut first_failure = None;
    for candidate in candidates {
        let (old, new) = tokio::join!(
            probe_entity(subsonic, candidate.kind, &candidate.old_id),
            probe_entity(subsonic, candidate.kind, &candidate.new_id),
        );
        match (&old, &new) {
            (Ok(()), Err(SubsonicError::NotFound)) => {
                record_state(
                    store,
                    server_id,
                    "legacy",
                    Some(candidate.kind.label()),
                    Some(&candidate.old_id),
                    Some(&candidate.new_id),
                    None,
                )?;
                return status(store, server_id);
            }
            (Err(SubsonicError::NotFound), Ok(())) => {
                populate_journal(store, server_id)?;
                record_state(
                    store,
                    server_id,
                    "required",
                    Some(candidate.kind.label()),
                    Some(&candidate.old_id),
                    Some(&candidate.new_id),
                    None,
                )?;
                return status(store, server_id);
            }
            (Err(SubsonicError::NotFound), Err(SubsonicError::NotFound)) => {}
            (Ok(()), Ok(())) => {
                let message = "legacy and canonical IDs both resolve; refusing ambiguous migration";
                record_state(
                    store,
                    server_id,
                    "blocked",
                    Some(candidate.kind.label()),
                    Some(&candidate.old_id),
                    Some(&candidate.new_id),
                    Some(message),
                )?;
                return status(store, server_id);
            }
            _ => {
                first_failure.get_or_insert_with(|| {
                    format!(
                        "canonical-ID probe failed (legacy: {}; canonical: {})",
                        probe_label(&old),
                        probe_label(&new)
                    )
                });
            }
        }
    }
    let message = first_failure.unwrap_or_else(|| {
        "no live entity established the active Navidrome ID namespace".to_string()
    });
    record_state(store, server_id, "retryable", None, None, None, Some(&message))?;
    status(store, server_id)
}

pub fn rewrite(store: &LibraryStore, server_id: &str) -> Result<CanonicalMigrationDto, String> {
    let current = status(store, server_id)?;
    match current.state.as_str() {
        "frontend" | "resyncing" | "ready" => return Ok(current),
        "required" | "rewriting" => {}
        other => return Err(format!("canonical-ID rewrite cannot run from state `{other}`")),
    }

    if current.mappings.is_empty() {
        populate_journal(store, server_id)?;
    }
    record_state(store, server_id, "rewriting", None, None, None, None)?;
    let result = store.with_conn_mut("navidrome_canonical_ids.rewrite", |conn| {
        let tx = conn.transaction()?;
        let maps = load_maps(&tx, server_id)?;
        create_temp_maps(&tx, &maps)?;
        reject_collisions(&tx, server_id)?;
        apply_rewrite(&tx, server_id, &maps)?;
        verify_native_tx(&tx, server_id, false)?;
        tx.execute(
            "UPDATE navidrome_canonical_journal SET status = 'applied', error = NULL WHERE server_id = ?1",
            params![server_id],
        )?;
        tx.execute(
            "UPDATE navidrome_canonical_migration SET state = 'frontend', native_migrated_at = ?2, last_error = NULL WHERE server_id = ?1",
            params![server_id, now_unix_ms()],
        )?;
        tx.commit()
    });
    if let Err(error) = result {
        let _ = record_state(store, server_id, "blocked", None, None, None, Some(&error));
        return Err(error);
    }
    status(store, server_id)
}

pub fn acknowledge_frontend(
    store: &LibraryStore,
    server_id: &str,
) -> Result<CanonicalMigrationDto, String> {
    clear_cluster_sidecar(store, server_id)?;
    store.with_conn("navidrome_canonical_ids.ack_frontend", |conn| {
        let state: Option<String> = conn
            .query_row(
                "SELECT state FROM navidrome_canonical_migration WHERE server_id = ?1",
                params![server_id],
                |row| row.get(0),
            )
            .optional()?;
        if !matches!(state.as_deref(), Some("frontend") | Some("resyncing")) {
            return Err(invalid_query(format!(
                "canonical-ID frontend acknowledgement cannot run from `{}`",
                state.as_deref().unwrap_or("unseen")
            )));
        }
        conn.execute(
            "UPDATE navidrome_canonical_migration SET state = 'resyncing', frontend_migrated_at = COALESCE(frontend_migrated_at, ?2), full_sync_started_at = COALESCE(full_sync_started_at, ?2), last_error = NULL WHERE server_id = ?1",
            params![server_id, now_unix_ms()],
        )?;
        Ok(())
    })?;
    status(store, server_id)
}

pub fn finalize(store: &LibraryStore, server_id: &str) -> Result<CanonicalMigrationDto, String> {
    clear_cluster_sidecar(store, server_id)?;
    store.with_conn_mut("navidrome_canonical_ids.finalize", |conn| {
        let tx = conn.transaction()?;
        let state: Option<String> = tx
            .query_row(
                "SELECT state FROM navidrome_canonical_migration WHERE server_id = ?1",
                params![server_id],
                |row| row.get(0),
            )
            .optional()?;
        if state.as_deref() == Some("ready") {
            tx.commit()?;
            return Ok(());
        }
        if state.as_deref() != Some("resyncing") {
            return Err(invalid_query(format!(
                "canonical-ID final verification cannot run from `{}`",
                state.as_deref().unwrap_or("unseen")
            )));
        }
        let full_sync_started_at: i64 = tx.query_row(
            "SELECT full_sync_started_at FROM navidrome_canonical_migration WHERE server_id = ?1",
            params![server_id],
            |row| row.get(0),
        )?;
        let full_sync_complete: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_state WHERE server_id = ?1 AND library_scope = '' AND sync_phase = 'ready' AND last_full_sync_at >= ?2)",
            params![server_id, full_sync_started_at],
            |row| row.get(0),
        )?;
        if !full_sync_complete {
            return Err(invalid_query("the required full sync has not completed"));
        }
        verify_native_tx(&tx, server_id, true)?;
        tx.execute(
            "DELETE FROM navidrome_canonical_journal WHERE server_id = ?1",
            params![server_id],
        )?;
        tx.execute(
            "UPDATE navidrome_canonical_migration SET state = 'ready', verified_at = ?2, last_error = NULL WHERE server_id = ?1",
            params![server_id, now_unix_ms()],
        )?;
        tx.commit()
    })?;
    status(store, server_id)
}

fn prepare_resync_without_rewrite(store: &LibraryStore, server_id: &str) -> Result<(), String> {
    store.with_conn_mut("navidrome_canonical_ids.prepare_resync", |conn| {
        let tx = conn.transaction()?;
        reset_sync_and_derived(&tx, server_id)?;
        tx.execute(
            "INSERT INTO navidrome_canonical_migration(server_id, canonical_version, state, detected_at, frontend_migrated_at, full_sync_started_at) VALUES (?1, ?2, 'resyncing', ?3, ?3, ?3) ON CONFLICT(server_id) DO UPDATE SET canonical_version = excluded.canonical_version, state = excluded.state, detected_at = excluded.detected_at, frontend_migrated_at = excluded.frontend_migrated_at, full_sync_started_at = excluded.full_sync_started_at, last_error = NULL",
            params![server_id, CANONICAL_VERSION, now_unix_ms()],
        )?;
        tx.commit()
    })
}

fn collect_probe_candidates(
    store: &LibraryStore,
    server_id: &str,
) -> Result<Vec<ProbeCandidate>, String> {
    store.with_read_conn(|conn| {
        let mut candidates = Vec::new();
        for (kind, table) in [(EntityKind::Track, "track"), (EntityKind::Album, "album")] {
            let sql = format!(
                "SELECT id FROM {table} WHERE server_id = ?1{} ORDER BY id LIMIT ?2",
                if table == "track" { " AND deleted = 0" } else { "" }
            );
            let ids = conn
                .prepare(&sql)?
                .query_map(params![server_id, (MAX_PROBE_CANDIDATES * 8) as i64], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for old_id in ids {
                let new_id = canonical_id(&old_id);
                if new_id != old_id {
                    candidates.push(ProbeCandidate { kind, old_id, new_id });
                    if candidates.len() >= MAX_PROBE_CANDIDATES {
                        return Ok(candidates);
                    }
                }
            }
        }
        Ok(candidates)
    })
}

async fn probe_entity(
    subsonic: &SubsonicClient,
    kind: EntityKind,
    id: &str,
) -> Result<(), SubsonicError> {
    match kind {
        EntityKind::Track => subsonic.get_song(id).await.map(|_| ()),
        EntityKind::Album => subsonic.get_album(id).await.map(|_| ()),
        _ => unreachable!("only track and album candidates are probed"),
    }
}

fn probe_label(result: &Result<(), SubsonicError>) -> String {
    match result {
        Ok(()) => "found".to_string(),
        Err(SubsonicError::NotFound) => "not_found".to_string(),
        Err(error) => error.to_string(),
    }
}

fn populate_journal(store: &LibraryStore, server_id: &str) -> Result<(), String> {
    store.with_conn_mut("navidrome_canonical_ids.populate_journal", |conn| {
        let sets = collect_id_sets(conn, server_id)?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM navidrome_canonical_journal WHERE server_id = ?1",
            params![server_id],
        )?;
        let mut insert = tx.prepare(
            "INSERT INTO navidrome_canonical_journal(server_id, entity_kind, old_id, new_id) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for (kind, values) in [
            (EntityKind::Artist, sets.artist),
            (EntityKind::Album, sets.album),
            (EntityKind::Track, sets.track),
            (EntityKind::Folder, sets.folder),
        ] {
            for old_id in values {
                let new_id = canonical_id(&old_id);
                if new_id != old_id {
                    insert.execute(params![server_id, kind.label(), old_id, new_id])?;
                }
            }
        }
        drop(insert);
        let duplicate: Option<(String, String)> = tx
            .query_row(
                "SELECT entity_kind, new_id FROM navidrome_canonical_journal WHERE server_id = ?1 GROUP BY entity_kind, new_id HAVING COUNT(*) > 1 LIMIT 1",
                params![server_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((kind, id)) = duplicate {
            return Err(invalid_query(format!("multiple legacy {kind} IDs map to `{id}`")));
        }
        tx.commit()
    })
}

fn collect_id_sets(conn: &Connection, server_id: &str) -> rusqlite::Result<IdSets> {
    let mut sets = IdSets::default();
    for (kind, table, column, owner_column) in [
        (EntityKind::Artist, "artist", "id", "server_id"),
        (EntityKind::Artist, "album", "artist_id", "server_id"),
        (EntityKind::Artist, "track", "artist_id", "server_id"),
        (EntityKind::Artist, "artist_artwork_lookup", "artist_id", "server_id"),
        (EntityKind::Album, "album", "id", "server_id"),
        (EntityKind::Album, "track", "album_id", "server_id"),
        (EntityKind::Album, "track_genre", "album_id", "server_id"),
        (EntityKind::Track, "track", "id", "server_id"),
        (EntityKind::Track, "track_extension", "track_id", "server_id"),
        (EntityKind::Track, "track_offline", "track_id", "server_id"),
        (EntityKind::Track, "track_fact", "track_id", "server_id"),
        (EntityKind::Track, "track_artifact", "track_id", "server_id"),
        (EntityKind::Track, "track_canonical_link", "track_id", "server_id"),
        (EntityKind::Track, "canonical_enrichment_link", "owner_track_id", "owner_server_id"),
        (EntityKind::Track, "play_session", "track_id", "server_id"),
        (EntityKind::Track, "track_genre", "track_id", "server_id"),
        (EntityKind::Track, "track_id_history", "new_id", "server_id"),
        (EntityKind::Folder, "track", "library_id", "server_id"),
        (EntityKind::Folder, "track_genre", "library_id", "server_id"),
        (EntityKind::Folder, "sync_state", "library_scope", "server_id"),
    ] {
        collect_column(conn, server_id, kind, table, column, owner_column, &mut sets)?;
    }
    let mut ratings = conn.prepare(
        "SELECT entity_kind, entity_id FROM entity_user_rating WHERE server_id = ?1 AND entity_id <> ''",
    )?;
    for row in ratings.query_map(params![server_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })? {
        let (kind, value) = row?;
        let kind = match kind.as_str() {
            "artist" => EntityKind::Artist,
            "album" => EntityKind::Album,
            "track" => EntityKind::Track,
            _ => continue,
        };
        sets.values_mut(kind).insert(value);
    }
    for (table, root_kind) in [
        ("artist", EntityKind::Artist),
        ("album", EntityKind::Album),
        ("track", EntityKind::Track),
    ] {
        let sql = format!("SELECT raw_json FROM {table} WHERE server_id = ?1 AND raw_json IS NOT NULL");
        let rows = conn
            .prepare(&sql)?
            .query_map(params![server_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for raw in rows {
            let value: Value = serde_json::from_str(&raw).map_err(json_error)?;
            collect_json_ids(&value, root_kind, &mut sets);
        }
    }
    Ok(sets)
}

fn collect_column(
    conn: &Connection,
    server_id: &str,
    kind: EntityKind,
    table: &str,
    column: &str,
    owner_column: &str,
    sets: &mut IdSets,
) -> rusqlite::Result<()> {
    let sql = format!(
        "SELECT DISTINCT {column} FROM {table} WHERE {owner_column} = ?1 AND {column} IS NOT NULL AND {column} <> ''"
    );
    let values = conn
        .prepare(&sql)?
        .query_map(params![server_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    sets.values_mut(kind).extend(values);
    Ok(())
}

fn collect_json_ids(value: &Value, context: EntityKind, sets: &mut IdSets) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_json_ids(value, context, sets);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                let explicit = match key.as_str() {
                    "albumId" => Some(EntityKind::Album),
                    "artistId" | "albumArtistId" => Some(EntityKind::Artist),
                    "libraryId" | "library_id" | "musicFolderId" => Some(EntityKind::Folder),
                    "artists" | "albumArtists" => Some(EntityKind::Artist),
                    "song" | "songs" => Some(EntityKind::Track),
                    _ => None,
                };
                if key == "id" {
                    if let Value::String(id) = value {
                        sets.values_mut(context).insert(id.clone());
                    }
                } else if let Some(kind) = explicit {
                    if let Value::String(id) = value {
                        sets.values_mut(kind).insert(id.clone());
                    } else {
                        collect_json_ids(value, kind, sets);
                    }
                } else if key == "contributors" || (key == "artist" && !value.is_string()) {
                    collect_json_ids(value, EntityKind::Artist, sets);
                }
            }
        }
        _ => {}
    }
}

fn load_maps(conn: &Connection, server_id: &str) -> rusqlite::Result<IdMaps> {
    let mut maps = IdMaps::default();
    let mut statement = conn.prepare(
        "SELECT entity_kind, old_id, new_id FROM navidrome_canonical_journal WHERE server_id = ?1 ORDER BY entity_kind, old_id",
    )?;
    for row in statement.query_map(params![server_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    })? {
        let (kind, old_id, new_id) = row?;
        match kind.as_str() {
            "artist" => { maps.artist.insert(old_id, new_id); }
            "album" => { maps.album.insert(old_id, new_id); }
            "track" => { maps.track.insert(old_id, new_id); }
            "folder" => { maps.folder.insert(old_id, new_id); }
            _ => {}
        }
    }
    Ok(maps)
}

fn create_temp_maps(tx: &Transaction<'_>, maps: &IdMaps) -> rusqlite::Result<()> {
    tx.execute_batch(
        "PRAGMA defer_foreign_keys = ON;
         DROP TABLE IF EXISTS temp.canonical_artist_map;
         DROP TABLE IF EXISTS temp.canonical_album_map;
         DROP TABLE IF EXISTS temp.canonical_track_map;
         DROP TABLE IF EXISTS temp.canonical_folder_map;
         CREATE TEMP TABLE canonical_artist_map(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
         CREATE TEMP TABLE canonical_album_map(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
         CREATE TEMP TABLE canonical_track_map(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
         CREATE TEMP TABLE canonical_folder_map(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);",
    )?;
    for (table, map) in [
        ("canonical_artist_map", &maps.artist),
        ("canonical_album_map", &maps.album),
        ("canonical_track_map", &maps.track),
        ("canonical_folder_map", &maps.folder),
    ] {
        let mut insert = tx.prepare(&format!("INSERT INTO {table}(old_id, new_id) VALUES (?1, ?2)"))?;
        for (old_id, new_id) in map {
            insert.execute(params![old_id, new_id])?;
        }
    }
    Ok(())
}

fn reject_collisions(tx: &Transaction<'_>, server_id: &str) -> rusqlite::Result<()> {
    for (label, query) in [
        ("artist", "SELECT entity.id FROM artist entity JOIN canonical_artist_map mapping ON mapping.new_id = entity.id WHERE entity.server_id = ?1 LIMIT 1"),
        ("album", "SELECT entity.id FROM album entity JOIN canonical_album_map mapping ON mapping.new_id = entity.id WHERE entity.server_id = ?1 LIMIT 1"),
        ("track", "SELECT entity.id FROM track entity JOIN canonical_track_map mapping ON mapping.new_id = entity.id WHERE entity.server_id = ?1 LIMIT 1"),
        ("sync scope", "SELECT old.library_scope FROM sync_state old JOIN canonical_folder_map mapping ON mapping.old_id = old.library_scope JOIN sync_state destination ON destination.server_id = old.server_id AND destination.library_scope = mapping.new_id WHERE old.server_id = ?1 LIMIT 1"),
        ("artist artwork", "SELECT old.artist_id FROM artist_artwork_lookup old JOIN canonical_artist_map mapping ON mapping.old_id = old.artist_id JOIN artist_artwork_lookup destination ON destination.server_id = old.server_id AND destination.artist_id = mapping.new_id AND destination.surface_kind = old.surface_kind WHERE old.server_id = ?1 LIMIT 1"),
        ("offline track", "SELECT old.track_id FROM track_offline old JOIN canonical_track_map mapping ON mapping.old_id = old.track_id JOIN track_offline destination ON destination.server_id = old.server_id AND destination.track_id = mapping.new_id WHERE old.server_id = ?1 LIMIT 1"),
        ("canonical enrichment", "SELECT old.owner_track_id FROM canonical_enrichment_link old JOIN canonical_track_map mapping ON mapping.old_id = old.owner_track_id JOIN canonical_enrichment_link destination ON destination.canonical_id = old.canonical_id AND destination.enrichment_kind = old.enrichment_kind AND destination.owner_server_id = old.owner_server_id AND destination.owner_track_id = mapping.new_id WHERE old.owner_server_id = ?1 LIMIT 1"),
        ("entity rating", "SELECT old.entity_id FROM entity_user_rating old JOIN navidrome_canonical_journal mapping ON mapping.server_id = old.server_id AND mapping.entity_kind = old.entity_kind AND mapping.old_id = old.entity_id JOIN entity_user_rating destination ON destination.server_id = old.server_id AND destination.entity_kind = old.entity_kind AND destination.entity_id = mapping.new_id WHERE old.server_id = ?1 LIMIT 1"),
    ] {
        let collision = tx
            .query_row(query, params![server_id], |row| row.get::<_, String>(0))
            .optional()?;
        if let Some(id) = collision {
            return Err(invalid_query(format!("canonical {label} collision at `{id}`")));
        }
    }
    Ok(())
}

fn apply_rewrite(tx: &Transaction<'_>, server_id: &str, maps: &IdMaps) -> rusqlite::Result<()> {
    for statement in [
        "UPDATE artist SET id = (SELECT new_id FROM canonical_artist_map WHERE old_id = artist.id) WHERE server_id = ?1 AND id IN (SELECT old_id FROM canonical_artist_map)",
        "UPDATE artist_artwork_lookup SET artist_id = (SELECT new_id FROM canonical_artist_map WHERE old_id = artist_artwork_lookup.artist_id) WHERE server_id = ?1 AND artist_id IN (SELECT old_id FROM canonical_artist_map)",
        "UPDATE album SET id = COALESCE((SELECT new_id FROM canonical_album_map WHERE old_id = album.id), id), artist_id = COALESCE((SELECT new_id FROM canonical_artist_map WHERE old_id = album.artist_id), artist_id) WHERE server_id = ?1",
        "UPDATE track SET id = COALESCE((SELECT new_id FROM canonical_track_map WHERE old_id = track.id), id), artist_id = COALESCE((SELECT new_id FROM canonical_artist_map WHERE old_id = track.artist_id), artist_id), album_id = COALESCE((SELECT new_id FROM canonical_album_map WHERE old_id = track.album_id), album_id), library_id = COALESCE((SELECT new_id FROM canonical_folder_map WHERE old_id = track.library_id), library_id) WHERE server_id = ?1",
        "UPDATE track_extension SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = track_extension.track_id) WHERE server_id = ?1 AND track_id IN (SELECT old_id FROM canonical_track_map)",
        "UPDATE track_offline SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = track_offline.track_id) WHERE server_id = ?1 AND track_id IN (SELECT old_id FROM canonical_track_map)",
        "UPDATE track_fact SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = track_fact.track_id) WHERE server_id = ?1 AND track_id IN (SELECT old_id FROM canonical_track_map)",
        "UPDATE track_artifact SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = track_artifact.track_id) WHERE server_id = ?1 AND track_id IN (SELECT old_id FROM canonical_track_map)",
        "UPDATE track_canonical_link SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = track_canonical_link.track_id) WHERE server_id = ?1 AND track_id IN (SELECT old_id FROM canonical_track_map)",
        "UPDATE canonical_enrichment_link SET owner_track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = canonical_enrichment_link.owner_track_id) WHERE owner_server_id = ?1 AND owner_track_id IN (SELECT old_id FROM canonical_track_map)",
        "UPDATE play_session SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = play_session.track_id) WHERE server_id = ?1 AND track_id IN (SELECT old_id FROM canonical_track_map)",
        "UPDATE track_genre SET track_id = COALESCE((SELECT new_id FROM canonical_track_map WHERE old_id = track_genre.track_id), track_id), album_id = COALESCE((SELECT new_id FROM canonical_album_map WHERE old_id = track_genre.album_id), album_id), library_id = COALESCE((SELECT new_id FROM canonical_folder_map WHERE old_id = track_genre.library_id), library_id) WHERE server_id = ?1",
        "UPDATE track_id_history SET new_id = COALESCE((SELECT new_id FROM canonical_track_map WHERE old_id = track_id_history.new_id), new_id) WHERE server_id = ?1",
        "UPDATE sync_state SET library_scope = COALESCE((SELECT new_id FROM canonical_folder_map WHERE old_id = sync_state.library_scope), library_scope) WHERE server_id = ?1",
    ] {
        tx.execute(statement, params![server_id])?;
    }
    for kind in ["artist", "album", "track"] {
        tx.execute(
            "UPDATE entity_user_rating SET entity_id = (SELECT new_id FROM navidrome_canonical_journal WHERE server_id = ?1 AND entity_kind = ?2 AND old_id = entity_user_rating.entity_id) WHERE server_id = ?1 AND entity_kind = ?2 AND entity_id IN (SELECT old_id FROM navidrome_canonical_journal WHERE server_id = ?1 AND entity_kind = ?2)",
            params![server_id, kind],
        )?;
    }
    rewrite_artwork_columns(tx, server_id)?;
    rewrite_raw_json(tx, server_id, maps)?;
    reset_sync_and_derived(tx, server_id)?;
    Ok(())
}

fn rewrite_artwork_columns(tx: &Transaction<'_>, server_id: &str) -> rusqlite::Result<()> {
    for table in ["album", "track"] {
        let sql = format!("SELECT rowid, cover_art_id FROM {table} WHERE server_id = ?1 AND cover_art_id IS NOT NULL AND cover_art_id <> ''");
        let rows = tx
            .prepare(&sql)?
            .query_map(params![server_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut update = tx.prepare(&format!("UPDATE {table} SET cover_art_id = ?1 WHERE rowid = ?2"))?;
        for (rowid, value) in rows {
            let rewritten = canonical_artwork_id(&value);
            if rewritten != value {
                update.execute(params![rewritten, rowid])?;
            }
        }
    }
    Ok(())
}

fn rewrite_raw_json(tx: &Transaction<'_>, server_id: &str, maps: &IdMaps) -> rusqlite::Result<()> {
    for (table, root_kind) in [
        ("artist", EntityKind::Artist),
        ("album", EntityKind::Album),
        ("track", EntityKind::Track),
    ] {
        let sql = format!("SELECT rowid, raw_json FROM {table} WHERE server_id = ?1 AND raw_json IS NOT NULL");
        let rows = tx
            .prepare(&sql)?
            .query_map(params![server_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut update = tx.prepare(&format!("UPDATE {table} SET raw_json = ?1 WHERE rowid = ?2"))?;
        for (rowid, raw) in rows {
            let mut value: Value = serde_json::from_str(&raw).map_err(json_error)?;
            if rewrite_json_ids(&mut value, root_kind, maps) {
                update.execute(params![value.to_string(), rowid])?;
            }
        }
    }
    Ok(())
}

fn rewrite_json_ids(value: &mut Value, context: EntityKind, maps: &IdMaps) -> bool {
    match value {
        Value::Array(values) => {
            let mut changed = false;
            for value in values {
                changed |= rewrite_json_ids(value, context, maps);
            }
            changed
        }
        Value::Object(values) => {
            let mut changed = false;
            for (key, value) in values {
                let explicit = match key.as_str() {
                    "albumId" => Some(EntityKind::Album),
                    "artistId" | "albumArtistId" => Some(EntityKind::Artist),
                    "libraryId" | "library_id" | "musicFolderId" => Some(EntityKind::Folder),
                    "artists" | "albumArtists" => Some(EntityKind::Artist),
                    "song" | "songs" => Some(EntityKind::Track),
                    _ => None,
                };
                if key == "id" {
                    changed |= rewrite_string(value, maps.get(context, value.as_str().unwrap_or_default()));
                } else if matches!(key.as_str(), "coverArt" | "coverArtId") {
                    if let Value::String(text) = value {
                        let rewritten = canonical_artwork_id(text);
                        if rewritten != *text {
                            *text = rewritten;
                            changed = true;
                        }
                    }
                } else if let Some(kind) = explicit {
                    if value.is_string() {
                        changed |= rewrite_string(value, maps.get(kind, value.as_str().unwrap_or_default()));
                    } else {
                        changed |= rewrite_json_ids(value, kind, maps);
                    }
                } else if key == "contributors" || (key == "artist" && !value.is_string()) {
                    changed |= rewrite_json_ids(value, EntityKind::Artist, maps);
                }
            }
            changed
        }
        _ => false,
    }
}

fn rewrite_string(value: &mut Value, replacement: Option<&str>) -> bool {
    let Some(replacement) = replacement else { return false; };
    *value = Value::String(replacement.to_string());
    true
}

fn reset_sync_and_derived(tx: &Transaction<'_>, server_id: &str) -> rusqlite::Result<()> {
    for statement in [
        "DELETE FROM album_browse_projection WHERE server_id = ?1",
        "DELETE FROM composer_album_projection WHERE server_id = ?1",
        "DELETE FROM library_tag_state WHERE server_id = ?1",
        "DELETE FROM library_tag_cursor WHERE server_id = ?1",
        "DELETE FROM identity_invalidation WHERE server_id = ?1",
    ] {
        tx.execute(statement, params![server_id])?;
    }
    tx.execute(
        "DELETE FROM cluster.cluster_meta WHERE key = ?1",
        params![format!("dirty_server:{server_id}")],
    )?;
    tx.execute(
        "INSERT INTO identity_invalidation(server_id, kind, entity_id) VALUES (?1, 'server', '')",
        params![server_id],
    )?;
    tx.execute(
        "UPDATE sync_state SET initial_sync_cursor_json = '{}', sync_phase = 'idle', last_full_sync_at = NULL, last_delta_sync_at = NULL, last_error = NULL WHERE server_id = ?1",
        params![server_id],
    )?;
    Ok(())
}

fn clear_cluster_sidecar(store: &LibraryStore, server_id: &str) -> Result<(), String> {
    store.with_conn("navidrome_canonical_ids.clear_cluster_sidecar", |conn| {
        conn.execute(
            "DELETE FROM cluster.track_cluster_key WHERE server_id = ?1",
            params![server_id],
        )?;
        Ok(())
    })
}

fn verify_native_tx(
    tx: &Transaction<'_>,
    server_id: &str,
    require_applied_journal: bool,
) -> rusqlite::Result<()> {
    let sets = collect_id_sets(tx, server_id)?;
    for (kind, values) in [
        ("artist", sets.artist),
        ("album", sets.album),
        ("track", sets.track),
        ("folder", sets.folder),
    ] {
        if let Some(value) = values.into_iter().find(|value| canonical_id(value) != *value) {
            return Err(invalid_query(format!("legacy {kind} ID remains at `{value}`")));
        }
    }
    for table in ["album", "track"] {
        let sql = format!("SELECT cover_art_id FROM {table} WHERE server_id = ?1 AND cover_art_id IS NOT NULL AND cover_art_id <> ''");
        let values = tx
            .prepare(&sql)?
            .query_map(params![server_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if let Some(value) = values
            .into_iter()
            .find(|value| canonical_artwork_id(value) != *value)
        {
            return Err(invalid_query(format!("legacy structured artwork ID remains at `{value}`")));
        }
    }
    let pending: i64 = tx.query_row(
        if require_applied_journal {
            "SELECT COUNT(*) FROM navidrome_canonical_journal WHERE server_id = ?1 AND status <> 'applied'"
        } else {
            "SELECT COUNT(*) FROM navidrome_canonical_journal WHERE server_id = ?1 AND status = 'failed'"
        },
        params![server_id],
        |row| row.get(0),
    )?;
    if pending > 0 {
        return Err(invalid_query("canonical-ID journal contains incomplete rows"));
    }
    let fk_error: Option<String> = tx
        .query_row("PRAGMA foreign_key_check", [], |row| {
            Ok(format!("{} row {}", row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .optional()?;
    if let Some(error) = fk_error {
        return Err(invalid_query(format!("foreign key check failed: {error}")));
    }
    Ok(())
}

fn read_status(conn: &Connection, server_id: &str) -> rusqlite::Result<CanonicalMigrationDto> {
    let row = conn
        .query_row(
            "SELECT state, canonical_version, probe_kind, probe_old_id, probe_new_id, last_error FROM navidrome_canonical_migration WHERE server_id = ?1",
            params![server_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()?;
    let mappings = conn
        .prepare(
            "SELECT entity_kind, old_id, new_id FROM navidrome_canonical_journal WHERE server_id = ?1 ORDER BY entity_kind, old_id",
        )?
        .query_map(params![server_id], |row| {
            Ok(CanonicalIdMappingDto {
                entity_kind: row.get(0)?,
                old_id: row.get(1)?,
                new_id: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let (state, canonical_version, probe_kind, probe_old_id, probe_new_id, last_error) = row
        .unwrap_or_else(|| ("unseen".to_string(), CANONICAL_VERSION, None, None, None, None));
    Ok(CanonicalMigrationDto {
        server_id: server_id.to_string(),
        state,
        canonical_version,
        probe_kind,
        probe_old_id,
        probe_new_id,
        last_error,
        mappings,
    })
}

#[allow(clippy::too_many_arguments)]
fn record_state(
    store: &LibraryStore,
    server_id: &str,
    state: &str,
    probe_kind: Option<&str>,
    probe_old_id: Option<&str>,
    probe_new_id: Option<&str>,
    last_error: Option<&str>,
) -> Result<(), String> {
    store.with_conn("navidrome_canonical_ids.record_state", |conn| {
        conn.execute(
            "INSERT INTO navidrome_canonical_migration(server_id, canonical_version, state, probe_kind, probe_old_id, probe_new_id, detected_at, last_error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(server_id) DO UPDATE SET canonical_version = excluded.canonical_version, state = excluded.state, probe_kind = COALESCE(excluded.probe_kind, navidrome_canonical_migration.probe_kind), probe_old_id = COALESCE(excluded.probe_old_id, navidrome_canonical_migration.probe_old_id), probe_new_id = COALESCE(excluded.probe_new_id, navidrome_canonical_migration.probe_new_id), detected_at = excluded.detected_at, last_error = excluded.last_error",
            params![server_id, CANONICAL_VERSION, state, probe_kind, probe_old_id, probe_new_id, now_unix_ms(), last_error],
        )?;
        Ok(())
    })
}

fn json_error(error: serde_json::Error) -> rusqlite::Error {
    invalid_query(format!("malformed persisted library JSON: {error}"))
}

fn invalid_query(message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(io::Error::other(message.into())))
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    fn identity_shaped_columns(conn: &Connection, schema: &str) -> BTreeSet<String> {
        let mut tables = conn
            .prepare(&format!(
                "SELECT name FROM {schema}.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'track_fts%' ORDER BY name"
            ))
            .unwrap();
        let table_names = tables
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let mut columns = BTreeSet::new();
        for table in table_names {
            let mut statement = conn
                .prepare(&format!("PRAGMA {schema}.table_info('{table}')"))
                .unwrap();
            for column in statement
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
            {
                let column = column.unwrap();
                if column == "id" || column.ends_with("_id") || column == "library_scope" {
                    columns.insert(format!("{table}.{column}"));
                }
            }
        }
        columns
    }

    #[test]
    fn schema_identity_inventory_has_no_unclassified_columns() {
        let store = LibraryStore::open_in_memory();
        store
            .with_read_conn(|conn| {
                let actual = identity_shaped_columns(conn, "main");
                let expected = [
                    "album.artist_id",
                    "album.cover_art_id",
                    "album.id",
                    "album.server_id",
                    "album_browse_projection.album_id",
                    "album_browse_projection.artist_id",
                    "album_browse_projection.cover_art_id",
                    "album_browse_projection.library_id",
                    "album_browse_projection.representative_track_id",
                    "album_browse_projection.server_id",
                    "artist.id",
                    "artist.server_id",
                    "artist_artwork_lookup.artist_id",
                    "artist_artwork_lookup.server_id",
                    "canonical_enrichment_link.canonical_id",
                    "canonical_enrichment_link.owner_server_id",
                    "canonical_enrichment_link.owner_track_id",
                    "canonical_identity.canonical_id",
                    "canonical_track.id",
                    "composer_album_projection.album_id",
                    "composer_album_projection.composer_id",
                    "composer_album_projection.library_id",
                    "composer_album_projection.representative_track_id",
                    "composer_album_projection.server_id",
                    "entity_user_rating.entity_id",
                    "entity_user_rating.server_id",
                    "identity_invalidation.entity_id",
                    "identity_invalidation.server_id",
                    "library_data_migration.id",
                    "library_tag_cursor.next_folder_id",
                    "library_tag_cursor.server_id",
                    "library_tag_state.server_id",
                    "navidrome_canonical_journal.new_id",
                    "navidrome_canonical_journal.old_id",
                    "navidrome_canonical_journal.server_id",
                    "navidrome_canonical_migration.probe_new_id",
                    "navidrome_canonical_migration.probe_old_id",
                    "navidrome_canonical_migration.server_id",
                    "play_session.id",
                    "play_session.server_id",
                    "play_session.track_id",
                    "sync_state.library_scope",
                    "sync_state.server_id",
                    "track.album_id",
                    "track.artist_id",
                    "track.cover_art_id",
                    "track.id",
                    "track.library_id",
                    "track.server_id",
                    "track_artifact.server_id",
                    "track_artifact.source_id",
                    "track_artifact.track_id",
                    "track_canonical_link.canonical_id",
                    "track_canonical_link.server_id",
                    "track_canonical_link.track_id",
                    "track_extension.server_id",
                    "track_extension.track_id",
                    "track_fact.server_id",
                    "track_fact.source_id",
                    "track_fact.track_id",
                    "track_genre.album_id",
                    "track_genre.library_id",
                    "track_genre.server_id",
                    "track_genre.track_id",
                    "track_id_history.new_id",
                    "track_id_history.old_id",
                    "track_id_history.server_id",
                    "track_offline.server_id",
                    "track_offline.track_id",
                ]
                .into_iter()
                .map(str::to_string)
                .collect::<BTreeSet<_>>();
                assert_eq!(actual, expected, "classify new identity-shaped columns in the canonical migration inventory");

                let cluster_actual = identity_shaped_columns(conn, "cluster");
                let cluster_expected = [
                    "track_cluster_key.library_id",
                    "track_cluster_key.server_id",
                    "track_cluster_key.track_id",
                ]
                .into_iter()
                .map(str::to_string)
                .collect::<BTreeSet<_>>();
                assert_eq!(cluster_actual, cluster_expected, "classify new cluster-sidecar identity columns");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn raw_json_rewrites_album_artist_without_musicbrainz_ids() {
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        let mut maps = IdMaps::default();
        maps.artist.insert(old.to_string(), new.clone());
        let mut value = serde_json::json!({
            "albumArtistId": old,
            "artist": old,
            "albumArtists": [{"id": old}],
            "contributors": [{"artistId": old, "musicBrainzId": old}],
            "musicBrainzId": old,
        });
        assert!(rewrite_json_ids(&mut value, EntityKind::Album, &maps));
        assert_eq!(value["albumArtistId"], new);
        assert_eq!(value["artist"], old);
        assert_eq!(value["albumArtists"][0]["id"], canonical_id(old));
        assert_eq!(value["contributors"][0]["artistId"], canonical_id(old));
        assert_eq!(value["contributors"][0]["musicBrainzId"], old);
        assert_eq!(value["musicBrainzId"], old);
    }

    #[test]
    fn journal_precedes_id_rewrite_and_resume_is_idempotent() {
        let store = LibraryStore::open_in_memory();
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        store
            .with_conn("test.seed", |conn| {
                conn.execute(
                    "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) VALUES ('s1',?1,'Track','Album',1,?2)",
                    params![old, format!(r#"{{"id":"{old}","albumArtistId":"{old}","musicBrainzId":"{old}"}}"#)],
                )?;
                conn.execute(
                    "INSERT INTO artist(server_id,id,name,synced_at,raw_json) VALUES ('s1',?1,'Artist',1,'{}')",
                    params![old],
                )?;
                conn.execute(
                    "INSERT INTO navidrome_canonical_migration(server_id, canonical_version, state, detected_at) VALUES ('s1',1,'required',1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        populate_journal(&store, "s1").unwrap();
        assert!(!status(&store, "s1").unwrap().mappings.is_empty());
        let first = rewrite(&store, "s1").unwrap();
        assert_eq!(first.state, "frontend");
        let second = rewrite(&store, "s1").unwrap();
        assert_eq!(second.state, "frontend");
    }
}
