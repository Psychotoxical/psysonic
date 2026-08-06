//! Navidrome's 2026 canonical-ID transition.
//!
//! The server migration is deterministic, but applying it merely because an ID
//! looks old is unsafe. We first prove the active server namespace by probing one
//! locally-known entity under both its old and computed canonical ID. Detection
//! only records durable evidence. An explicit migration command later drains
//! sync work and moves all library references in one deferred-FK transaction.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use psysonic_integration::subsonic::{SubsonicClient, SubsonicError};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::store::LibraryStore;

pub const CANONICAL_ID_VERSION: i64 = 1;

#[derive(Debug, Clone, serde::Serialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdentityTransitionDto {
    pub server_id: String,
    pub state: String,
    pub canonical_version: i64,
    pub probe_old_id: Option<String>,
    pub probe_new_id: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdentityProbeCandidateDto {
    pub entity_kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntityKind {
    Track,
    Album,
}

#[derive(Debug, Clone)]
struct ProbeCandidate {
    kind: EntityKind,
    old_id: String,
    new_id: String,
}

#[derive(Debug, Clone)]
struct IdMap {
    old_id: String,
    new_id: String,
}

#[derive(Debug, Clone, Default)]
struct LibraryIdMaps {
    artists: Vec<IdMap>,
    albums: Vec<IdMap>,
    tracks: Vec<IdMap>,
    folders: Vec<IdMap>,
    global: Vec<IdMap>,
}

pub fn transition_status(
    store: &LibraryStore,
    server_id: &str,
) -> Result<IdentityTransitionDto, String> {
    let server_id = server_id.trim();
    if server_id.is_empty() {
        return Err("server id is required".to_string());
    }
    store.with_read_conn(|conn| {
        conn.query_row(
            "SELECT state, canonical_version, probe_old_id, probe_new_id, last_error \
             FROM server_identity_transition WHERE server_id = ?1",
            params![server_id],
            |row| {
                Ok(IdentityTransitionDto {
                    server_id: server_id.to_string(),
                    state: row.get(0)?,
                    canonical_version: row.get(1)?,
                    probe_old_id: row.get(2)?,
                    probe_new_id: row.get(3)?,
                    last_error: row.get(4)?,
                })
            },
        )
        .optional()
        .map(|status| {
            status.unwrap_or(IdentityTransitionDto {
                server_id: server_id.to_string(),
                state: "unseen".to_string(),
                canonical_version: CANONICAL_ID_VERSION,
                probe_old_id: None,
                probe_new_id: None,
                last_error: None,
            })
        })
    })
}

pub fn assert_sync_ready(store: &LibraryStore, server_id: &str) -> Result<(), String> {
    let status = transition_status(store, server_id)?;
    match status.state.as_str() {
        "awaiting_supplemental_probe" => Err(format!(
            "server `{server_id}` canonical-ID readiness is waiting for persisted frontend candidates"
        )),
        "transition_detected" => Err(format!(
            "server `{server_id}` canonical-ID migration is ready to run"
        )),
        "pending_frontend" => Err(format!(
            "server `{server_id}` canonical-ID migration is waiting for frontend reconciliation"
        )),
        "retryable" | "blocked" => Err(format!(
            "server `{server_id}` canonical-ID migration is blocked: {}",
            status.last_error.as_deref().unwrap_or("unknown reason")
        )),
        _ => Ok(()),
    }
}

pub fn resolve_remapped_id(
    store: &LibraryStore,
    server_id: &str,
    entity_kind: &str,
    id: &str,
) -> Result<String, String> {
    store.with_read_conn(|conn| {
        conn.query_row(
            "SELECT new_id FROM entity_id_remap \
             WHERE server_id = ?1 AND entity_kind = ?2 AND old_id = ?3 AND active = 1",
            params![server_id, entity_kind, id],
            |row| row.get(0),
        )
        .optional()
        .map(|mapped| mapped.unwrap_or_else(|| id.to_string()))
    })
}

pub(crate) fn resolve_remapped_id_with_conn(
    conn: &Connection,
    server_id: &str,
    entity_kind: &str,
    id: &str,
) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT new_id FROM entity_id_remap \
         WHERE server_id = ?1 AND entity_kind = ?2 AND old_id = ?3 AND active = 1",
        params![server_id, entity_kind, id],
        |row| row.get(0),
    )
    .optional()
    .map(|mapped| mapped.unwrap_or_else(|| id.to_string()))
}

pub fn acknowledge_frontend(store: &LibraryStore, server_id: &str) -> Result<(), String> {
    let now = now_unix_ms();
    store
        .with_conn("navidrome_identity.ack_frontend", |conn| {
            let changed = conn.execute(
                "UPDATE server_identity_transition \
             SET state = 'ready', frontend_acked_at = ?2, last_error = NULL \
             WHERE server_id = ?1 AND canonical_version = ?3 AND state = 'pending_frontend'",
                params![server_id.trim(), now, CANONICAL_ID_VERSION],
            )?;
            if changed == 0 {
                let state: Option<String> = conn
                    .query_row(
                        "SELECT state FROM server_identity_transition WHERE server_id = ?1",
                        params![server_id.trim()],
                        |row| row.get(0),
                    )
                    .optional()?;
                if !matches!(state.as_deref(), Some("ready")) {
                    return Err(rusqlite::Error::InvalidQuery);
                }
            }
            Ok(())
        })
        .map_err(|error| {
            if error.contains("Invalid query") {
                format!(
                    "server `{}` has no pending canonical-ID transition",
                    server_id.trim()
                )
            } else {
                error
            }
        })
}

/// Canonicalize only documented entity-ID fields in a Subsonic song payload.
/// Metadata identifiers such as MusicBrainz IDs must remain untouched.
pub fn canonicalize_song_payload(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                canonicalize_song_payload(value);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if is_entity_id_field(key) {
                    if let Value::String(id) = value {
                        *id = canonical_id(id);
                        continue;
                    }
                }
                canonicalize_song_payload(value);
            }
        }
        _ => {}
    }
}

fn is_entity_id_field(key: &str) -> bool {
    matches!(
        key,
        "id" | "parent" | "albumId" | "artistId" | "coverArt" | "musicFolderId"
    )
}

/// Re-check a Navidrome server at bind time. Native candidate absence waits for
/// the supplemental frontend probe; legacy and previously blocked states are
/// probed again so an upgrade or transient failure can converge on the next bind.
pub async fn ensure_transition(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
) -> Result<IdentityTransitionDto, String> {
    let candidates = probe_candidates(store, server_id)?;
    ensure_transition_with_candidates(
        store,
        subsonic,
        server_id,
        candidates,
        EmptyCandidateOutcome::AwaitSupplemental,
    )
    .await
}

pub async fn ensure_transition_with_probe_candidates(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
    supplied: Vec<IdentityProbeCandidateDto>,
) -> Result<IdentityTransitionDto, String> {
    let mut candidates = probe_candidates(store, server_id)?;
    for candidate in supplied {
        let kind = match candidate.entity_kind.as_str() {
            "track" => EntityKind::Track,
            "album" => EntityKind::Album,
            _ => continue,
        };
        let old_id = candidate.id.trim().to_string();
        let new_id = canonical_id(&old_id);
        if old_id.is_empty()
            || old_id == new_id
            || candidates
                .iter()
                .any(|existing| existing.kind == kind && existing.old_id == old_id)
        {
            continue;
        }
        candidates.push(ProbeCandidate {
            kind,
            old_id,
            new_id,
        });
        if candidates.len() >= 8 {
            break;
        }
    }
    ensure_transition_with_candidates(
        store,
        subsonic,
        server_id,
        candidates,
        EmptyCandidateOutcome::NoLegacyIds,
    )
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EmptyCandidateOutcome {
    AwaitSupplemental,
    NoLegacyIds,
}

async fn ensure_transition_with_candidates(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
    candidates: Vec<ProbeCandidate>,
    empty_candidate_outcome: EmptyCandidateOutcome,
) -> Result<IdentityTransitionDto, String> {
    let existing = transition_status(store, server_id)?;
    if matches!(
        existing.state.as_str(),
        "transition_detected" | "pending_frontend" | "ready"
    ) {
        return Ok(existing);
    }

    if candidates.is_empty() {
        let state = match empty_candidate_outcome {
            EmptyCandidateOutcome::AwaitSupplemental => "awaiting_supplemental_probe",
            EmptyCandidateOutcome::NoLegacyIds => "no_legacy_ids",
        };
        record_state(store, server_id, state, None, None, None, false)?;
        return transition_status(store, server_id);
    }

    for candidate in &candidates {
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
                    Some(&candidate.old_id),
                    Some(&candidate.new_id),
                    None,
                    false,
                )?;
                return transition_status(store, server_id);
            }
            (Err(SubsonicError::NotFound), Ok(())) => {
                record_transition_detected(
                    store,
                    server_id,
                    candidate,
                    &candidates,
                )?;
                return transition_status(store, server_id);
            }
            (Err(SubsonicError::NotFound), Err(SubsonicError::NotFound)) => {}
            (Ok(()), Ok(())) => {
                let error = "legacy and canonical forms both resolved; refusing ambiguous identity evidence";
                record_state(
                    store,
                    server_id,
                    "blocked",
                    Some(&candidate.old_id),
                    Some(&candidate.new_id),
                    Some(error),
                    false,
                )?;
                return transition_status(store, server_id);
            }
            _ => {
                let error = format!(
                    "canonical-ID probe failed (legacy: {}; canonical: {})",
                    probe_result_label(&old),
                    probe_result_label(&new)
                );
                record_state(
                    store,
                    server_id,
                    "retryable",
                    Some(&candidate.old_id),
                    Some(&candidate.new_id),
                    Some(&error),
                    false,
                )?;
                return transition_status(store, server_id);
            }
        }
    }
    let error = "no live probe candidate established the active Navidrome ID namespace";
    record_state(
        store,
        server_id,
        "retryable",
        None,
        None,
        Some(error),
        false,
    )?;
    transition_status(store, server_id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TargetedNotFoundOutcome {
    ConfirmedMissing,
    TransitionDetected,
}

/// A locally live legacy-shaped entity unexpectedly disappeared under its old
/// ID. The caller already observed that NotFound, so issue exactly one bounded
/// request for the canonical form before allowing a tombstone.
pub(crate) async fn resolve_unexpected_not_found(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
    kind: EntityKind,
    old_id: &str,
) -> Result<TargetedNotFoundOutcome, String> {
    const TARGETED_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

    let new_id = canonical_id(old_id);
    if new_id == old_id {
        return Ok(TargetedNotFoundOutcome::ConfirmedMissing);
    }
    let lock = targeted_probe_lock(server_id, kind, old_id);
    let _guard = lock.lock().await;
    let existing = transition_status(store, server_id)?;
    match existing.state.as_str() {
        "transition_detected" | "pending_frontend" => {
            return Ok(TargetedNotFoundOutcome::TransitionDetected);
        }
        "awaiting_supplemental_probe" | "retryable" | "blocked" => {
            return Err(format!(
                "canonical-ID state `{}` prevents destructive reconciliation",
                existing.state
            ));
        }
        "legacy"
            if existing.probe_old_id.as_deref() == Some(old_id)
                && existing.probe_new_id.as_deref() == Some(new_id.as_str()) =>
        {
            return Ok(TargetedNotFoundOutcome::ConfirmedMissing);
        }
        _ => {}
    }

    let result = tokio::time::timeout(
        TARGETED_PROBE_TIMEOUT,
        probe_entity(subsonic, kind, &new_id),
    )
    .await;
    match result {
        Ok(Ok(())) => {
            let candidate = ProbeCandidate {
                kind,
                old_id: old_id.to_string(),
                new_id: new_id.clone(),
            };
            record_transition_detected(
                store,
                server_id,
                &candidate,
                std::slice::from_ref(&candidate),
            )?;
            Ok(TargetedNotFoundOutcome::TransitionDetected)
        }
        Ok(Err(SubsonicError::NotFound)) => {
            record_state(
                store,
                server_id,
                "legacy",
                Some(old_id),
                Some(&new_id),
                None,
                false,
            )?;
            Ok(TargetedNotFoundOutcome::ConfirmedMissing)
        }
        Ok(Err(error)) => {
            let message = format!("targeted canonical-ID probe failed: {error}");
            record_state(
                store,
                server_id,
                "retryable",
                Some(old_id),
                Some(&new_id),
                Some(&message),
                false,
            )?;
            Err(message)
        }
        Err(_) => {
            let message = "targeted canonical-ID probe timed out";
            record_state(
                store,
                server_id,
                "retryable",
                Some(old_id),
                Some(&new_id),
                Some(message),
                false,
            )?;
            Err(message.to_string())
        }
    }
}

fn targeted_probe_lock(server_id: &str, kind: EntityKind, old_id: &str) -> Arc<AsyncMutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> = OnceLock::new();
    let key = format!("{server_id}:{kind:?}:{old_id}");
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

async fn probe_entity(
    subsonic: &SubsonicClient,
    kind: EntityKind,
    id: &str,
) -> Result<(), SubsonicError> {
    match kind {
        EntityKind::Track => subsonic.get_song(id).await.map(|_| ()),
        EntityKind::Album => subsonic.get_album(id).await.map(|_| ()),
    }
}

fn probe_result_label(result: &Result<(), SubsonicError>) -> String {
    match result {
        Ok(()) => "ok".to_string(),
        Err(error) => error.to_string(),
    }
}

fn probe_candidates(store: &LibraryStore, server_id: &str) -> Result<Vec<ProbeCandidate>, String> {
    const MAX_CANDIDATES: usize = 8;
    store.with_read_conn(|conn| {
        let mut candidates = Vec::new();
        for (kind, table) in [(EntityKind::Track, "track"), (EntityKind::Album, "album")] {
            let live_filter = if table == "track" {
                " AND deleted = 0"
            } else {
                ""
            };
            let mut statement = conn.prepare(&format!(
                "SELECT id FROM {table} WHERE server_id = ?1{live_filter} ORDER BY id LIMIT 64"
            ))?;
            let mut rows = statement.query(params![server_id])?;
            while let Some(row) = rows.next()? {
                let old_id = row.get::<_, String>(0)?;
                let new_id = canonical_id(&old_id);
                if new_id != old_id {
                    candidates.push(ProbeCandidate {
                        kind,
                        old_id,
                        new_id,
                    });
                    if candidates.len() >= MAX_CANDIDATES {
                        return Ok(candidates);
                    }
                }
            }
        }
        Ok(candidates)
    })
}

pub fn run_native_migration(store: &LibraryStore, server_id: &str) -> Result<(), String> {
    let status = transition_status(store, server_id)?;
    match status.state.as_str() {
        "pending_frontend" | "ready" => return Ok(()),
        "transition_detected" => {}
        other => {
            return Err(format!(
                "server `{server_id}` canonical-ID migration cannot run from state `{other}`"
            ));
        }
    }
    let result = store.with_conn_mut("navidrome_identity.migrate", |conn| {
        let maps = collect_library_maps(conn, server_id)?;
        let now = now_unix_ms();
        let tx = conn.transaction()?;
        tx.execute_batch(
            "PRAGMA defer_foreign_keys = ON;
             DROP TABLE IF EXISTS temp.canonical_artist_map;
             DROP TABLE IF EXISTS temp.canonical_album_map;
             DROP TABLE IF EXISTS temp.canonical_track_map;
             DROP TABLE IF EXISTS temp.canonical_folder_map;
             DROP TABLE IF EXISTS temp.canonical_global_map;
             CREATE TEMP TABLE canonical_artist_map(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
             CREATE TEMP TABLE canonical_album_map(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
             CREATE TEMP TABLE canonical_track_map(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
             CREATE TEMP TABLE canonical_folder_map(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);
             CREATE TEMP TABLE canonical_global_map(old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL);",
        )?;
        insert_temp_map(&tx, "canonical_artist_map", &maps.artists)?;
        insert_temp_map(&tx, "canonical_album_map", &maps.albums)?;
        insert_temp_map(&tx, "canonical_track_map", &maps.tracks)?;
        insert_temp_map(&tx, "canonical_folder_map", &maps.folders)?;
        insert_temp_map(&tx, "canonical_global_map", &maps.global)?;
        reject_collisions(&tx, server_id)?;

        tx.execute_batch(&format!(
            "UPDATE artist SET id = (SELECT new_id FROM canonical_artist_map WHERE old_id = artist.id)
               WHERE server_id = {sid} AND id IN (SELECT old_id FROM canonical_artist_map);
             UPDATE artist_artwork_lookup SET artist_id = (SELECT new_id FROM canonical_artist_map WHERE old_id = artist_artwork_lookup.artist_id)
               WHERE server_id = {sid} AND artist_id IN (SELECT old_id FROM canonical_artist_map);
             UPDATE album SET
               id = COALESCE((SELECT new_id FROM canonical_album_map WHERE old_id = album.id), id),
               artist_id = COALESCE((SELECT new_id FROM canonical_artist_map WHERE old_id = album.artist_id), artist_id),
               cover_art_id = COALESCE((SELECT new_id FROM canonical_global_map WHERE old_id = album.cover_art_id), cover_art_id)
               WHERE server_id = {sid};
             UPDATE track SET
               id = COALESCE((SELECT new_id FROM canonical_track_map WHERE old_id = track.id), id),
               artist_id = COALESCE((SELECT new_id FROM canonical_artist_map WHERE old_id = track.artist_id), artist_id),
               album_id = COALESCE((SELECT new_id FROM canonical_album_map WHERE old_id = track.album_id), album_id),
               library_id = COALESCE((SELECT new_id FROM canonical_folder_map WHERE old_id = track.library_id), library_id),
               cover_art_id = COALESCE((SELECT new_id FROM canonical_global_map WHERE old_id = track.cover_art_id), cover_art_id)
               WHERE server_id = {sid};
             UPDATE track_extension SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = track_extension.track_id)
               WHERE server_id = {sid} AND track_id IN (SELECT old_id FROM canonical_track_map);
             UPDATE track_offline SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = track_offline.track_id)
               WHERE server_id = {sid} AND track_id IN (SELECT old_id FROM canonical_track_map);
             UPDATE track_fact SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = track_fact.track_id)
               WHERE server_id = {sid} AND track_id IN (SELECT old_id FROM canonical_track_map);
             UPDATE track_artifact SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = track_artifact.track_id)
               WHERE server_id = {sid} AND track_id IN (SELECT old_id FROM canonical_track_map);
             UPDATE track_canonical_link SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = track_canonical_link.track_id)
               WHERE server_id = {sid} AND track_id IN (SELECT old_id FROM canonical_track_map);
             UPDATE canonical_enrichment_link SET owner_track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = canonical_enrichment_link.owner_track_id)
               WHERE owner_server_id = {sid} AND owner_track_id IN (SELECT old_id FROM canonical_track_map);
             UPDATE play_session SET track_id = (SELECT new_id FROM canonical_track_map WHERE old_id = play_session.track_id)
               WHERE server_id = {sid} AND track_id IN (SELECT old_id FROM canonical_track_map);
             UPDATE track_genre SET
                track_id = COALESCE((SELECT new_id FROM canonical_track_map WHERE old_id = track_genre.track_id), track_id),
                album_id = COALESCE((SELECT new_id FROM canonical_album_map WHERE old_id = track_genre.album_id), album_id),
                library_id = COALESCE((SELECT new_id FROM canonical_folder_map WHERE old_id = track_genre.library_id), library_id)
                WHERE server_id = {sid};
             UPDATE entity_user_rating SET entity_id = CASE entity_kind
               WHEN 'artist' THEN COALESCE((SELECT new_id FROM canonical_artist_map WHERE old_id = entity_user_rating.entity_id), entity_id)
               WHEN 'album' THEN COALESCE((SELECT new_id FROM canonical_album_map WHERE old_id = entity_user_rating.entity_id), entity_id)
               WHEN 'track' THEN COALESCE((SELECT new_id FROM canonical_track_map WHERE old_id = entity_user_rating.entity_id), entity_id)
               ELSE entity_id END
               WHERE server_id = {sid};
             UPDATE track_id_history SET new_id = COALESCE((SELECT new_id FROM canonical_track_map WHERE old_id = track_id_history.new_id), new_id)
               WHERE server_id = {sid};
             UPDATE sync_state SET library_scope = (SELECT new_id FROM canonical_folder_map WHERE old_id = sync_state.library_scope)
               WHERE server_id = {sid} AND library_scope IN (SELECT old_id FROM canonical_folder_map);
             DELETE FROM library_tag_state WHERE server_id = {sid};
             DELETE FROM library_tag_cursor WHERE server_id = {sid};
             DELETE FROM cluster.track_cluster_key WHERE server_id = {sid};
             DELETE FROM identity_invalidation WHERE server_id = {sid};
             INSERT INTO identity_invalidation(server_id, kind, entity_id) VALUES ({sid}, 'server', '');
             UPDATE sync_state SET initial_sync_cursor_json = '{{}}' WHERE server_id = {sid};",
            sid = sql_string(server_id),
        ))?;

        rewrite_raw_json(&tx, server_id, &maps.global)?;
        crate::browse_projection::rebuild_server(&tx, server_id)?;
        record_remaps(&tx, server_id, "artist", &maps.artists, now)?;
        record_remaps(&tx, server_id, "album", &maps.albums, now)?;
        record_remaps(&tx, server_id, "track", &maps.tracks, now)?;
        record_remaps(&tx, server_id, "folder", &maps.folders, now)?;
        tx.execute(
            "UPDATE entity_id_remap SET active = 1 WHERE server_id = ?1",
            params![server_id],
        )?;
        for mapping in &maps.tracks {
            tx.execute(
                "INSERT INTO track_id_history \
                 (server_id, old_id, new_id, content_hash, server_path, remapped_at) \
                 VALUES (?1, ?2, ?3, NULL, NULL, ?4) \
                 ON CONFLICT(server_id, old_id) DO UPDATE SET \
                   new_id = excluded.new_id, remapped_at = excluded.remapped_at",
                params![server_id, mapping.old_id, mapping.new_id, now],
            )?;
        }
        tx.execute(
            "INSERT INTO server_identity_transition \
             (server_id, canonical_version, state, detected_at, native_migrated_at) \
             VALUES (?1, ?2, 'pending_frontend', ?3, ?3) \
             ON CONFLICT(server_id) DO UPDATE SET \
               canonical_version = excluded.canonical_version, state = excluded.state, \
               detected_at = excluded.detected_at, native_migrated_at = excluded.native_migrated_at, \
               frontend_acked_at = NULL, last_error = NULL",
            params![server_id, CANONICAL_ID_VERSION, now],
        )?;

        let fk_error: Option<String> = tx
            .query_row("PRAGMA foreign_key_check", [], |row| {
                let table: String = row.get(0)?;
                let rowid: i64 = row.get(1)?;
                Ok(format!("{table} row {rowid}"))
            })
            .optional()?;
        if let Some(error) = fk_error {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                io::Error::other(format!("foreign key check failed: {error}")),
            )));
        }
        tx.commit()
    });
    if let Err(error) = result {
        record_state(
            store,
            server_id,
            "blocked",
            status.probe_old_id.as_deref(),
            status.probe_new_id.as_deref(),
            Some(&error),
            false,
        )?;
        return Err(error);
    }
    Ok(())
}

fn collect_library_maps(conn: &Connection, server_id: &str) -> rusqlite::Result<LibraryIdMaps> {
    let artists = collect_entity_map(conn, "artist", server_id)?;
    let albums = collect_entity_map(conn, "album", server_id)?;
    let tracks = collect_entity_map(conn, "track", server_id)?;
    let mut folder_values = collect_column_values(conn, "track", "library_id", server_id)?;
    folder_values.extend(collect_column_values(
        conn,
        "sync_state",
        "library_scope",
        server_id,
    )?);
    folder_values.sort();
    folder_values.dedup();
    let folders = folder_values
        .into_iter()
        .filter_map(|old_id| {
            let new_id = canonical_id(&old_id);
            (new_id != old_id).then_some(IdMap { old_id, new_id })
        })
        .collect::<Vec<_>>();
    let mut global_by_old = HashMap::<String, String>::new();
    for mapping in artists
        .iter()
        .chain(albums.iter())
        .chain(tracks.iter())
        .chain(folders.iter())
    {
        global_by_old.insert(mapping.old_id.clone(), mapping.new_id.clone());
    }
    for (table, column) in [
        ("album", "artist_id"),
        ("album", "cover_art_id"),
        ("track", "artist_id"),
        ("track", "album_id"),
        ("track", "cover_art_id"),
    ] {
        for value in collect_column_values(conn, table, column, server_id)? {
            let canonical = canonical_id(&value);
            if canonical != value {
                global_by_old.insert(value, canonical);
            }
        }
    }
    let mut global = global_by_old
        .into_iter()
        .map(|(old_id, new_id)| IdMap { old_id, new_id })
        .collect::<Vec<_>>();
    global.sort_by(|a, b| a.old_id.cmp(&b.old_id));
    Ok(LibraryIdMaps {
        artists,
        albums,
        tracks,
        folders,
        global,
    })
}

fn collect_entity_map(
    conn: &Connection,
    table: &str,
    server_id: &str,
) -> rusqlite::Result<Vec<IdMap>> {
    let values = collect_column_values(conn, table, "id", server_id)?;
    Ok(values
        .into_iter()
        .filter_map(|old_id| {
            let new_id = canonical_id(&old_id);
            (new_id != old_id).then_some(IdMap { old_id, new_id })
        })
        .collect())
}

fn collect_column_values(
    conn: &Connection,
    table: &str,
    column: &str,
    server_id: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(&format!(
        "SELECT DISTINCT {column} FROM {table} \
         WHERE server_id = ?1 AND {column} IS NOT NULL AND {column} <> ''"
    ))?;
    let values = statement
        .query_map(params![server_id], |row| row.get(0))?
        .collect();
    values
}

fn insert_temp_map(tx: &Transaction<'_>, table: &str, mappings: &[IdMap]) -> rusqlite::Result<()> {
    let mut statement = tx.prepare(&format!(
        "INSERT INTO {table}(old_id, new_id) VALUES (?1, ?2)"
    ))?;
    for mapping in mappings {
        statement.execute(params![mapping.old_id, mapping.new_id])?;
    }
    Ok(())
}

fn reject_collisions(tx: &Transaction<'_>, server_id: &str) -> rusqlite::Result<()> {
    for (table, map) in [
        ("artist", "canonical_artist_map"),
        ("album", "canonical_album_map"),
        ("track", "canonical_track_map"),
    ] {
        let collision: Option<String> = tx
            .query_row(
                &format!(
                    "SELECT entity.id FROM {table} entity JOIN {map} mapping ON mapping.new_id = entity.id \
                     WHERE entity.server_id = ?1 LIMIT 1"
                ),
                params![server_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = collision {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                io::Error::other(format!("canonical {table} id collision at `{id}`")),
            )));
        }
        let duplicate: Option<String> = tx
            .query_row(
                &format!("SELECT new_id FROM {map} GROUP BY new_id HAVING COUNT(*) > 1 LIMIT 1"),
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = duplicate {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                io::Error::other(format!("multiple {table} ids map to `{id}`")),
            )));
        }
    }
    for (label, query) in [
        (
            "sync scope",
            "SELECT 1 FROM sync_state old \
             JOIN canonical_folder_map mapping ON mapping.old_id = old.library_scope \
             JOIN sync_state destination \
               ON destination.server_id = old.server_id \
              AND destination.library_scope = mapping.new_id \
             WHERE old.server_id = ?1 LIMIT 1",
        ),
        (
            "artist artwork",
            "SELECT 1 FROM artist_artwork_lookup old \
             JOIN canonical_artist_map mapping ON mapping.old_id = old.artist_id \
             JOIN artist_artwork_lookup destination \
               ON destination.server_id = old.server_id \
              AND destination.artist_id = mapping.new_id \
              AND destination.surface_kind = old.surface_kind \
             WHERE old.server_id = ?1 LIMIT 1",
        ),
        (
            "offline track",
            "SELECT 1 FROM track_offline old \
             JOIN canonical_track_map mapping ON mapping.old_id = old.track_id \
             JOIN track_offline destination \
               ON destination.server_id = old.server_id \
              AND destination.track_id = mapping.new_id \
             WHERE old.server_id = ?1 LIMIT 1",
        ),
        (
            "entity rating",
            "SELECT 1 FROM entity_user_rating old \
             JOIN canonical_global_map mapping ON mapping.old_id = old.entity_id \
             JOIN entity_user_rating destination \
               ON destination.server_id = old.server_id \
              AND destination.entity_kind = old.entity_kind \
              AND destination.entity_id = mapping.new_id \
             WHERE old.server_id = ?1 LIMIT 1",
        ),
        (
            "canonical enrichment owner",
            "SELECT 1 FROM canonical_enrichment_link old \
             JOIN canonical_track_map mapping ON mapping.old_id = old.owner_track_id \
             JOIN canonical_enrichment_link destination \
               ON destination.canonical_id = old.canonical_id \
              AND destination.enrichment_kind = old.enrichment_kind \
              AND destination.owner_server_id = old.owner_server_id \
              AND destination.owner_track_id = mapping.new_id \
             WHERE old.owner_server_id = ?1 LIMIT 1",
        ),
    ] {
        let collision = tx
            .query_row(query, params![server_id], |row| row.get::<_, i64>(0))
            .optional()?
            .is_some();
        if collision {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                io::Error::other(format!("canonical-ID migration found a {label} collision")),
            )));
        }
    }
    Ok(())
}

fn record_remaps(
    tx: &Transaction<'_>,
    server_id: &str,
    kind: &str,
    mappings: &[IdMap],
    now: i64,
) -> rusqlite::Result<()> {
    let mut statement = tx.prepare(
        "INSERT INTO entity_id_remap(server_id, entity_kind, old_id, new_id, remapped_at, active) \
         VALUES (?1, ?2, ?3, ?4, ?5, 1) \
         ON CONFLICT(server_id, entity_kind, old_id) DO UPDATE SET \
            new_id = excluded.new_id, remapped_at = excluded.remapped_at, active = 1",
    )?;
    for mapping in mappings {
        statement.execute(params![
            server_id,
            kind,
            mapping.old_id,
            mapping.new_id,
            now
        ])?;
    }
    Ok(())
}

fn rewrite_raw_json(
    tx: &Transaction<'_>,
    server_id: &str,
    mappings: &[IdMap],
) -> rusqlite::Result<()> {
    let replacements = mappings
        .iter()
        .map(|mapping| (mapping.old_id.as_str(), mapping.new_id.as_str()))
        .collect::<HashMap<_, _>>();
    if replacements.is_empty() {
        return Ok(());
    }
    const BATCH_SIZE: i64 = 256;
    for table in ["artist", "album", "track"] {
        let mut cursor = 0_i64;
        let mut update = tx.prepare(&format!(
            "UPDATE {table} SET raw_json = ?1 WHERE rowid = ?2"
        ))?;
        loop {
            let rows = {
                let mut statement = tx.prepare(&format!(
                    "SELECT rowid, raw_json FROM {table} \
                     WHERE server_id = ?1 AND raw_json IS NOT NULL AND rowid > ?2 \
                     ORDER BY rowid LIMIT ?3"
                ))?;
                let rows = statement
                    .query_map(params![server_id, cursor, BATCH_SIZE], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            if rows.is_empty() {
                break;
            }
            for (rowid, raw) in rows {
                cursor = rowid;
                let Ok(mut value) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                if rewrite_entity_id_fields(&mut value, &replacements) {
                    update.execute(params![value.to_string(), rowid])?;
                }
            }
        }
    }
    Ok(())
}

fn rewrite_entity_id_fields(value: &mut Value, replacements: &HashMap<&str, &str>) -> bool {
    match value {
        Value::Array(values) => {
            let mut changed = false;
            for value in values {
                changed |= rewrite_entity_id_fields(value, replacements);
            }
            changed
        }
        Value::Object(values) => {
            let mut changed = false;
            for (key, value) in values {
                if is_entity_id_field(key) {
                    if let Value::String(text) = value {
                        if let Some(replacement) = replacements.get(text.as_str()) {
                            *text = (*replacement).to_string();
                            changed = true;
                            continue;
                        }
                    }
                }
                changed |= rewrite_entity_id_fields(value, replacements);
            }
            changed
        }
        _ => false,
    }
}

fn record_transition_detected(
    store: &LibraryStore,
    server_id: &str,
    evidence: &ProbeCandidate,
    mappings: &[ProbeCandidate],
) -> Result<(), String> {
    let now = now_unix_ms();
    store.with_conn("navidrome_identity.record_transition", |conn| {
        write_state(
            conn,
            server_id,
            "transition_detected",
            Some(&evidence.old_id),
            Some(&evidence.new_id),
            None,
            false,
            now,
        )?;
        let mut statement = conn.prepare(
            "INSERT INTO entity_id_remap(server_id, entity_kind, old_id, new_id, remapped_at, active) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0) \
             ON CONFLICT(server_id, entity_kind, old_id) DO UPDATE SET \
               new_id = excluded.new_id, remapped_at = excluded.remapped_at, active = 0",
        )?;
        for mapping in mappings {
            statement.execute(params![
                server_id,
                entity_kind_label(mapping.kind),
                mapping.old_id,
                mapping.new_id,
                now
            ])?;
        }
        Ok(())
    })
}

fn entity_kind_label(kind: EntityKind) -> &'static str {
    match kind {
        EntityKind::Track => "track",
        EntityKind::Album => "album",
    }
}

fn record_state(
    store: &LibraryStore,
    server_id: &str,
    state: &str,
    probe_old_id: Option<&str>,
    probe_new_id: Option<&str>,
    last_error: Option<&str>,
    migrated: bool,
) -> Result<(), String> {
    let now = now_unix_ms();
    store.with_conn("navidrome_identity.record_state", |conn| {
        write_state(
            conn,
            server_id,
            state,
            probe_old_id,
            probe_new_id,
            last_error,
            migrated,
            now,
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn write_state(
    conn: &Connection,
    server_id: &str,
    state: &str,
    probe_old_id: Option<&str>,
    probe_new_id: Option<&str>,
    last_error: Option<&str>,
    migrated: bool,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO server_identity_transition \
         (server_id, canonical_version, state, probe_old_id, probe_new_id, detected_at, native_migrated_at, last_error) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(server_id) DO UPDATE SET \
           canonical_version = excluded.canonical_version, state = excluded.state, \
           probe_old_id = excluded.probe_old_id, probe_new_id = excluded.probe_new_id, \
           detected_at = excluded.detected_at, \
           native_migrated_at = COALESCE(excluded.native_migrated_at, server_identity_transition.native_migrated_at), \
           frontend_acked_at = CASE WHEN excluded.state = 'pending_frontend' THEN NULL ELSE server_identity_transition.frontend_acked_at END, \
           last_error = excluded.last_error",
        params![
            server_id,
            CANONICAL_ID_VERSION,
            state,
            probe_old_id,
            probe_new_id,
            now,
            migrated.then_some(now),
            last_error,
        ],
    )?;
    Ok(())
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// Exact port of Navidrome's `canonicalID` migration helper.
pub fn canonical_id(value: &str) -> String {
    let bytes = match value.len() {
        22 => match decode_base62_u128(value) {
            Ok(_) => return value.to_string(),
            Err(Base62Error::Overflow) => md5::compute(value.as_bytes()).0,
            Err(Base62Error::Invalid) => return value.to_string(),
        },
        32 => match decode_hex_16(value) {
            Some(bytes) => bytes,
            None => return value.to_string(),
        },
        36 => {
            if value.as_bytes().get(8) != Some(&b'-')
                || value.as_bytes().get(13) != Some(&b'-')
                || value.as_bytes().get(18) != Some(&b'-')
                || value.as_bytes().get(23) != Some(&b'-')
            {
                return value.to_string();
            }
            let compact = value
                .chars()
                .filter(|character| *character != '-')
                .collect::<String>();
            match decode_hex_16(&compact) {
                Some(bytes) => bytes,
                None => return value.to_string(),
            }
        }
        _ => return value.to_string(),
    };
    encode_base62(bytes)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Base62Error {
    Invalid,
    Overflow,
}

fn decode_base62_u128(value: &str) -> Result<u128, Base62Error> {
    let mut out = 0u128;
    for byte in value.bytes() {
        let digit = match byte {
            b'0'..=b'9' => (byte - b'0') as u128,
            b'a'..=b'z' => (byte - b'a' + 10) as u128,
            b'A'..=b'Z' => (byte - b'A' + 36) as u128,
            _ => return Err(Base62Error::Invalid),
        };
        out = out
            .checked_mul(62)
            .and_then(|current| current.checked_add(digit))
            .ok_or(Base62Error::Overflow)?;
    }
    Ok(out)
}

fn decode_hex_16(value: &str) -> Option<[u8; 16]> {
    if value.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (index, slot) in out.iter_mut().enumerate() {
        let high = hex_digit(value.as_bytes()[index * 2])?;
        let low = hex_digit(value.as_bytes()[index * 2 + 1])?;
        *slot = (high << 4) | low;
    }
    Some(out)
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn encode_base62(bytes: [u8; 16]) -> String {
    const DIGITS: &[u8; 62] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let mut value = u128::from_be_bytes(bytes);
    let mut encoded = [b'0'; 22];
    let mut index = encoded.len();
    while value > 0 {
        index -= 1;
        encoded[index] = DIGITS[(value % 62) as usize];
        value /= 62;
    }
    String::from_utf8(encoded.to_vec()).expect("base62 alphabet is UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{ArtifactInputDto, FactInputDto, PlaySessionInputDto};
    use crate::repos::{ArtifactRepository, FactRepository, PlaySessionRepository};
    use psysonic_integration::subsonic::SubsonicCredentials;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_client(uri: &str) -> SubsonicClient {
        SubsonicClient::with_static_credentials(
            uri,
            SubsonicCredentials::with_static("user", "token", "salt"),
            reqwest::Client::new(),
        )
    }

    fn seed_legacy_track(store: &LibraryStore, id: &str) {
        store
            .with_conn("test.seed_legacy_track", |conn| {
                conn.execute(
                    "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) \
                     VALUES ('s1',?1,'Track','Album',1,'{}')",
                    params![id],
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn song_response(id: &str) -> serde_json::Value {
        serde_json::json!({
            "subsonic-response": {
                "status": "ok",
                "song": { "id": id, "title": "Track", "album": "Album" }
            }
        })
    }

    fn not_found_response() -> serde_json::Value {
        serde_json::json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 70, "message": "Song not found" }
            }
        })
    }

    #[test]
    fn matches_upstream_canonical_id_vectors() {
        for (input, expected) in [
            ("5cLJPkLA5DK2BADhoeotPk", "5cLJPkLA5DK2BADhoeotPk"),
            ("zzzzzzzzzzzzzzzzzzzzzz", "3LyqmwQBm5IRqlVjNYASwb"),
            ("e3b7fc2ae9447bbec37a13bf916e3cf6", "6VHl3uR4kss6sUPKA8Cwnk"),
            (
                "f47ac10b-58cc-4372-a567-0e02b2c3d479",
                "7rke2SAWaicSeSYzkhww6R",
            ),
        ] {
            assert_eq!(canonical_id(input), expected);
        }
    }

    #[test]
    fn canonical_id_preserves_valid_and_unrecognized_values() {
        assert_eq!(
            canonical_id("0000000000000000000001"),
            "0000000000000000000001"
        );
        assert_eq!(canonical_id("share-id"), "share-id");
        assert_eq!(
            canonical_id("not-a-uuid-----------------------"),
            "not-a-uuid-----------------------"
        );
    }

    #[test]
    fn overflowing_nanoid_is_hashed_deterministically() {
        let overflowing = "ZZZZZZZZZZZZZZZZZZZZZZ";
        let canonical = canonical_id(overflowing);
        assert_ne!(canonical, overflowing);
        assert_eq!(canonical.len(), 22);
        assert_eq!(canonical, canonical_id(overflowing));
    }

    #[test]
    fn song_payload_rewrites_entity_ids_without_touching_metadata_ids() {
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let mut payload = serde_json::json!({
            "id": old,
            "albumId": old,
            "artists": [{ "id": old, "musicBrainzId": old }],
            "musicBrainzId": old,
        });
        canonicalize_song_payload(&mut payload);
        assert_eq!(payload["id"], canonical_id(old));
        assert_eq!(payload["albumId"], canonical_id(old));
        assert_eq!(payload["artists"][0]["id"], canonical_id(old));
        assert_eq!(payload["artists"][0]["musicBrainzId"], old);
        assert_eq!(payload["musicBrainzId"], old);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn both_missing_candidates_remain_retryable_and_sync_blocked() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
            .expect(2)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        seed_legacy_track(&store, "e3b7fc2ae9447bbec37a13bf916e3cf6");

        let status = ensure_transition(&store, &test_client(&server.uri()), "s1")
            .await
            .unwrap();

        assert_eq!(status.state, "retryable");
        assert!(assert_sync_ready(&store, "s1").is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn legacy_evidence_stops_after_first_decisive_candidate() {
        let server = MockServer::start().await;
        let old = "00112233445566778899aabbccddeeff";
        let new = canonical_id(old);
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", old))
            .respond_with(ResponseTemplate::new(200).set_body_json(song_response(old)))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
            .expect(1)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        seed_legacy_track(&store, old);
        seed_legacy_track(&store, "11112222333344445555666677778888");

        let status = ensure_transition(&store, &test_client(&server.uri()), "s1")
            .await
            .unwrap();

        assert_eq!(status.state, "legacy");
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn canonical_evidence_records_transition_without_running_migration() {
        let server = MockServer::start().await;
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", old))
            .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(song_response(&new)))
            .expect(1)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        seed_legacy_track(&store, old);

        let status = ensure_transition(&store, &test_client(&server.uri()), "s1")
            .await
            .unwrap();

        assert_eq!(status.state, "transition_detected");
        let old_still_exists = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM track WHERE server_id = 's1' AND id = ?1)",
                    params![old],
                    |row| row.get::<_, bool>(0),
                )
            })
            .unwrap();
        assert!(old_still_exists);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn both_forms_resolving_is_blocked_as_ambiguous() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(song_response("track")))
            .expect(2)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        seed_legacy_track(&store, "e3b7fc2ae9447bbec37a13bf916e3cf6");

        let status = ensure_transition(&store, &test_client(&server.uri()), "s1")
            .await
            .unwrap();

        assert_eq!(status.state, "blocked");
        assert!(assert_sync_ready(&store, "s1").is_err());
    }

    #[tokio::test]
    async fn bind_without_native_candidates_waits_for_an_explicit_supplemental_probe() {
        let store = LibraryStore::open_in_memory();
        seed_legacy_track(&store, "already-canonical-or-custom");

        let client = test_client("http://127.0.0.1:9");
        let status = ensure_transition(&store, &client, "s1").await.unwrap();

        assert_eq!(status.state, "awaiting_supplemental_probe");
        assert!(assert_sync_ready(&store, "s1").is_err());

        let status = ensure_transition_with_probe_candidates(&store, &client, "s1", Vec::new())
            .await
            .unwrap();
        assert_eq!(status.state, "no_legacy_ids");
        assert!(assert_sync_ready(&store, "s1").is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_legacy_ids_state_is_rechecked_after_sync_adds_a_legacy_candidate() {
        let store = LibraryStore::open_in_memory();
        let unreachable = test_client("http://127.0.0.1:9");
        ensure_transition_with_probe_candidates(&store, &unreachable, "s1", Vec::new())
            .await
            .unwrap();

        let server = MockServer::start().await;
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", old))
            .respond_with(ResponseTemplate::new(200).set_body_json(song_response(old)))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
            .expect(1)
            .mount(&server)
            .await;
        seed_legacy_track(&store, old);

        let status = ensure_transition(&store, &test_client(&server.uri()), "s1")
            .await
            .unwrap();

        assert_eq!(status.state, "legacy");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn supplemental_frontend_only_candidate_can_detect_the_transition() {
        let server = MockServer::start().await;
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let second_old = "00112233445566778899aabbccddeeff";
        let new = canonical_id(old);
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", old))
            .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(song_response(&new)))
            .expect(1)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        let client = test_client(&server.uri());

        let bind_status = ensure_transition(&store, &client, "s1").await.unwrap();
        assert_eq!(bind_status.state, "awaiting_supplemental_probe");

        let status = ensure_transition_with_probe_candidates(
            &store,
            &client,
            "s1",
            vec![
                IdentityProbeCandidateDto {
                    entity_kind: "track".to_string(),
                    id: old.to_string(),
                },
                IdentityProbeCandidateDto {
                    entity_kind: "track".to_string(),
                    id: second_old.to_string(),
                },
            ],
        )
        .await
        .unwrap();

        assert_eq!(status.state, "transition_detected");
        assert_eq!(status.probe_old_id.as_deref(), Some(old));
        assert_eq!(status.probe_new_id.as_deref(), Some(new.as_str()));
        assert!(assert_sync_ready(&store, "s1").is_err());
        assert_eq!(resolve_remapped_id(&store, "s1", "track", old).unwrap(), old);

        run_native_migration(&store, "s1").unwrap();
        assert_eq!(resolve_remapped_id(&store, "s1", "track", old).unwrap(), new);
        assert_eq!(
            resolve_remapped_id(&store, "s1", "track", second_old).unwrap(),
            canonical_id(second_old)
        );
        store
            .with_conn("test.seed_canonical_track", |conn| {
                conn.execute(
                    "INSERT INTO track(server_id,id,title,album,duration_sec,synced_at,raw_json) \
                     VALUES ('s1',?1,'Track','Album',240,1,'{}')",
                    params![new],
                )?;
                Ok(())
            })
            .unwrap();
        PlaySessionRepository::new(&store)
            .insert(&PlaySessionInputDto {
                server_id: "s1".into(),
                track_id: old.into(),
                started_at_ms: 1_000,
                listened_sec: 30.0,
                position_max_sec: 20.0,
                end_reason: "ended".into(),
                duration_sec_hint: None,
            })
            .unwrap();
        let stored_id = store
            .with_read_conn(|conn| {
                conn.query_row("SELECT track_id FROM play_session", [], |row| row.get::<_, String>(0))
            })
            .unwrap();
        assert_eq!(stored_id, canonical_id(old));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn targeted_not_found_probe_is_single_flight() {
        let server = MockServer::start().await;
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
            .expect(1)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        let client = test_client(&server.uri());

        let (first, second) = tokio::join!(
            resolve_unexpected_not_found(&store, &client, "s1", EntityKind::Track, old),
            resolve_unexpected_not_found(&store, &client, "s1", EntityKind::Track, old),
        );

        assert_eq!(first.unwrap(), TargetedNotFoundOutcome::ConfirmedMissing);
        assert_eq!(second.unwrap(), TargetedNotFoundOutcome::ConfirmedMissing);
    }

    #[test]
    fn migration_records_pending_state_and_rewrites_primary_ids() {
        let store = LibraryStore::open_in_memory();
        let old_artist = "00112233445566778899aabbccddeeff";
        let old_album = "11112222333344445555666677778888";
        let old_track = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let old_folder = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        store
            .with_conn("test.seed", |conn| {
                conn.execute(
                    "INSERT INTO artist(server_id,id,name,synced_at,raw_json) VALUES ('s1',?1,'Artist',1,?2)",
                    params![old_artist, format!(r#"{{"id":"{old_artist}"}}"#)],
                )?;
                conn.execute(
                    "INSERT INTO album(server_id,id,name,artist_id,synced_at,raw_json) VALUES ('s1',?1,'Album',?2,1,?3)",
                    params![old_album, old_artist, format!(r#"{{"id":"{old_album}","artistId":"{old_artist}"}}"#)],
                )?;
                conn.execute(
                    "INSERT INTO track(server_id,id,title,artist_id,album,album_id,library_id,synced_at,raw_json) \
                     VALUES ('s1',?1,'Track',?2,'Album',?3,?4,1,?5)",
                    params![old_track, old_artist, old_album, old_folder, format!(r#"{{"id":"{old_track}","albumId":"{old_album}","artistId":"{old_artist}","musicFolderId":"{old_folder}","musicBrainzId":"{old_track}"}}"#)],
                )?;
                conn.execute(
                    "INSERT INTO sync_state(server_id,library_scope) VALUES ('s1',?1)",
                    params![old_folder],
                )?;
                conn.execute(
                    "INSERT INTO track_offline(server_id,track_id,local_path,cached_at) VALUES ('s1',?1,'/music/track.flac',1)",
                    params![old_track],
                )?;
                conn.execute(
                    "INSERT INTO play_session(server_id,track_id,started_at_ms,listened_sec,position_max_sec,completion,end_reason) \
                     VALUES ('s1',?1,1,10,10,'full','ended')",
                    params![old_track],
                )?;
                Ok(())
            })
            .unwrap();

        record_state(
            &store,
            "s1",
            "transition_detected",
            Some(old_track),
            Some(&canonical_id(old_track)),
            None,
            false,
        )
        .unwrap();
        run_native_migration(&store, "s1").unwrap();
        run_native_migration(&store, "s1").unwrap();
        let status = transition_status(&store, "s1").unwrap();
        assert_eq!(status.state, "pending_frontend");
        store
            .with_read_conn(|conn| {
                let ids: (String, String, String, String) = conn.query_row(
                    "SELECT artist_id, album_id, id, library_id FROM track WHERE server_id = 's1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
                assert_eq!(ids.0, canonical_id(old_artist));
                assert_eq!(ids.1, canonical_id(old_album));
                assert_eq!(ids.2, canonical_id(old_track));
                assert_eq!(ids.3, canonical_id(old_folder));
                let scope: String = conn.query_row(
                    "SELECT library_scope FROM sync_state WHERE server_id = 's1'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(scope, canonical_id(old_folder));
                let projection: (String, String, String) = conn.query_row(
                    "SELECT library_id, album_id, representative_track_id FROM album_browse_projection WHERE server_id = 's1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                assert_eq!(projection.0, canonical_id(old_folder));
                assert_eq!(projection.1, canonical_id(old_album));
                assert_eq!(projection.2, canonical_id(old_track));
                let offline_id: String = conn.query_row(
                    "SELECT track_id FROM track_offline WHERE server_id = 's1'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(offline_id, canonical_id(old_track));
                let session_id: String = conn.query_row(
                    "SELECT track_id FROM play_session WHERE server_id = 's1'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(session_id, canonical_id(old_track));
                let raw: String = conn.query_row(
                    "SELECT raw_json FROM track WHERE server_id = 's1'",
                    [],
                    |row| row.get(0),
                )?;
                let raw: Value = serde_json::from_str(&raw).unwrap();
                assert_eq!(raw["id"], canonical_id(old_track));
                assert_eq!(raw["albumId"], canonical_id(old_album));
                assert_eq!(raw["artistId"], canonical_id(old_artist));
                assert_eq!(raw["musicBrainzId"], old_track);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn late_play_fact_and_artifact_writes_resolve_through_durable_remaps() {
        let store = LibraryStore::open_in_memory();
        let old_track = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new_track = canonical_id(old_track);
        store
            .with_conn("test.seed", |conn| {
                conn.execute(
                    "INSERT INTO track(server_id,id,title,album,duration_sec,synced_at,raw_json) \
                     VALUES ('s1',?1,'Track','Album',240,1,'{}')",
                    params![old_track],
                )?;
                Ok(())
            })
            .unwrap();
        record_state(
            &store,
            "s1",
            "transition_detected",
            Some(old_track),
            Some(&new_track),
            None,
            false,
        )
        .unwrap();
        run_native_migration(&store, "s1").unwrap();

        PlaySessionRepository::new(&store)
            .insert(&PlaySessionInputDto {
                server_id: "s1".into(),
                track_id: old_track.into(),
                started_at_ms: 1_000,
                listened_sec: 30.0,
                position_max_sec: 20.0,
                end_reason: "ended".into(),
                duration_sec_hint: None,
            })
            .unwrap();
        FactRepository::new(&store)
            .put(
                "s1",
                old_track,
                &FactInputDto {
                    fact_kind: "bpm".into(),
                    value_real: None,
                    value_int: Some(120),
                    value_text: None,
                    unit: Some("bpm".into()),
                    source_kind: "user".into(),
                    source_id: "manual".into(),
                    confidence: 1.0,
                    content_hash: None,
                    expires_at: None,
                },
                2_000,
            )
            .unwrap();
        ArtifactRepository::new(&store)
            .put(
                "s1",
                old_track,
                &ArtifactInputDto {
                    artifact_kind: "lyrics".into(),
                    format: "text".into(),
                    source_kind: "user".into(),
                    source_id: "manual".into(),
                    language: None,
                    content_text: Some("late lyrics".into()),
                    content_blob: None,
                    content_bytes: 11,
                    not_found: false,
                    content_hash: None,
                    expires_at: None,
                },
                2_000,
            )
            .unwrap();

        store
            .with_read_conn(|conn| {
                for table in ["play_session", "track_fact", "track_artifact"] {
                    let id: String = conn.query_row(
                        &format!("SELECT track_id FROM {table} WHERE server_id = 's1'"),
                        [],
                        |row| row.get(0),
                    )?;
                    assert_eq!(id, new_track, "late write in {table}");
                }
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn migration_rolls_back_when_an_unowned_destination_row_would_collide() {
        let store = LibraryStore::open_in_memory();
        let old_track = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new_track = canonical_id(old_track);
        store
            .with_conn("test.seed", |conn| {
                conn.execute(
                    "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) \
                     VALUES ('s1',?1,'Track','Album',1,?2)",
                    params![old_track, format!(r#"{{"id":"{old_track}"}}"#)],
                )?;
                conn.execute(
                    "INSERT INTO track_offline(server_id,track_id,local_path,cached_at) VALUES ('s1',?1,'/old',1)",
                    params![old_track],
                )?;
                conn.execute(
                    "INSERT INTO track_offline(server_id,track_id,local_path,cached_at) VALUES ('s1',?1,'/new',2)",
                    params![new_track],
                )?;
                Ok(())
            })
            .unwrap();

        record_state(
            &store,
            "s1",
            "transition_detected",
            Some(old_track),
            Some(&new_track),
            None,
            false,
        )
        .unwrap();
        assert!(run_native_migration(&store, "s1").is_err());
        assert_eq!(transition_status(&store, "s1").unwrap().state, "blocked");
        store
            .with_read_conn(|conn| {
                let track_exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM track WHERE server_id = 's1' AND id = ?1)",
                    params![old_track],
                    |row| row.get(0),
                )?;
                assert!(track_exists);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn migration_reuses_one_connection_for_multiple_servers() {
        let store = LibraryStore::open_in_memory();
        for (server_id, old_track) in [
            ("s1", "e3b7fc2ae9447bbec37a13bf916e3cf6"),
            ("s2", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ] {
            store
                .with_conn("test.seed", |conn| {
                    conn.execute(
                        "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) \
                         VALUES (?1,?2,'Track','Album',1,?3)",
                        params![server_id, old_track, format!(r#"{{"id":"{old_track}"}}"#)],
                    )?;
                    Ok(())
                })
                .unwrap();
            record_state(
                &store,
                server_id,
                "transition_detected",
                Some(old_track),
                Some(&canonical_id(old_track)),
                None,
                false,
            )
            .unwrap();
            run_native_migration(&store, server_id).unwrap();
        }
        for (server_id, old_track) in [
            ("s1", "e3b7fc2ae9447bbec37a13bf916e3cf6"),
            ("s2", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        ] {
            let exists = store
                .with_read_conn(|conn| {
                    conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM track WHERE server_id = ?1 AND id = ?2)",
                        params![server_id, canonical_id(old_track)],
                        |row| row.get::<_, bool>(0),
                    )
                })
                .unwrap();
            assert!(exists);
        }
    }
}
