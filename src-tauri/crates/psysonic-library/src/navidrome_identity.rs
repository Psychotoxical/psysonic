//! Navidrome's 2026 canonical-ID transition.
//!
//! The server migration is deterministic, but applying it merely because an ID
//! looks old is unsafe. We first prove the active server namespace by probing one
//! locally-known entity under both its old and computed canonical ID. Detection
//! only records durable evidence. An explicit migration command later drains
//! sync work and moves all library references in one deferred-FK transaction.

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use psysonic_integration::subsonic::{SubsonicClient, SubsonicError};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::store::LibraryStore;

pub const CANONICAL_ID_VERSION: i64 = 2;
const MAX_PROBE_CANDIDATES: usize = 8;
const MAX_PROBE_ATTEMPT_CANDIDATES: usize = MAX_PROBE_CANDIDATES + 1;
const ALIAS_BASELINE_BATCH_SIZE: i64 = 256;
const ALIAS_BASELINE_BATCHES_PER_ATTEMPT: usize = 4;
const ALIAS_BASELINE_MIGRATION_PREFIX: &str = "navidrome_inactive_alias_baseline_v1";
const ALIAS_BASELINE_PROGRESS_ERROR: &str =
    "canonical-ID inactive alias baseline is still progressing";
const ALIAS_BASELINE_NO_LEGACY_PROGRESS_ERROR: &str =
    "canonical-ID inactive alias baseline is still progressing; resume no_legacy_ids";

pub(crate) fn delete_inactive_alias_baseline_markers(
    conn: &Connection,
    server_id: &str,
) -> rusqlite::Result<()> {
    let mut statement = conn.prepare_cached("DELETE FROM library_data_migration WHERE id = ?1")?;
    for source in ALIAS_BASELINE_SOURCES {
        statement.execute(params![alias_baseline_marker(server_id, source)])?;
    }
    Ok(())
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum EntityKind {
    Track,
    Album,
    Artist,
}

#[derive(Debug, Clone)]
struct ProbeCandidate {
    kind: EntityKind,
    old_id: String,
    new_id: String,
    cursor_after: Option<ProbeCursor>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct ProbeCursor {
    source: usize,
    after_id: Option<String>,
}

#[derive(Debug, Clone)]
struct ProbeCandidateBatch {
    candidates: Vec<ProbeCandidate>,
    next_cursor: ProbeCursor,
    exhausted: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DeterministicWriteGuard {
    enabled: bool,
    probe_old_id: Option<String>,
    probe_new_id: Option<String>,
}

impl DeterministicWriteGuard {
    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }

    pub(crate) fn hinted_old_id<'a>(&'a self, incoming_id: &str) -> Option<&'a str> {
        (self.probe_new_id.as_deref() == Some(incoming_id))
            .then_some(self.probe_old_id.as_deref())
            .flatten()
    }
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
    upgrade_completed_state_if_needed(store, server_id)?;
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
        _ if status.canonical_version != CANONICAL_ID_VERSION => Err(format!(
            "server `{server_id}` canonical-ID readiness version {} is stale",
            status.canonical_version
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
    upgrade_completed_state_if_needed(store, server_id)?;
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
    let lock = transition_probe_lock(server_id);
    let _guard = lock.lock().await;
    upgrade_completed_state_if_needed(store, server_id)?;
    let existing = transition_status(store, server_id)?;
    if matches!(
        existing.state.as_str(),
        "transition_detected" | "pending_frontend" | "ready"
    ) && existing.canonical_version == CANONICAL_ID_VERSION
    {
        return Ok(existing);
    }
    let resume_no_legacy = existing.state == "no_legacy_ids"
        || existing.last_error.as_deref() == Some(ALIAS_BASELINE_NO_LEGACY_PROGRESS_ERROR);
    if !ensure_inactive_alias_baseline(store, server_id)? {
        record_state(
            store,
            server_id,
            "retryable",
            existing.probe_old_id.as_deref(),
            existing.probe_new_id.as_deref(),
            Some(if resume_no_legacy {
                ALIAS_BASELINE_NO_LEGACY_PROGRESS_ERROR
            } else {
                ALIAS_BASELINE_PROGRESS_ERROR
            }),
            false,
        )?;
        return transition_status(store, server_id);
    }
    if resume_no_legacy {
        record_state(store, server_id, "no_legacy_ids", None, None, None, false)?;
        return transition_status(store, server_id);
    }
    if no_legacy_state_is_current(&existing) {
        return Ok(existing);
    }
    let candidates = probe_candidates_for_status(store, &existing)?;
    bounded_transition_probe(
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
    let lock = transition_probe_lock(server_id);
    let _guard = lock.lock().await;
    upgrade_completed_state_if_needed(store, server_id)?;
    let existing = transition_status(store, server_id)?;
    if matches!(
        existing.state.as_str(),
        "transition_detected" | "pending_frontend" | "ready"
    ) && existing.canonical_version == CANONICAL_ID_VERSION
    {
        return Ok(existing);
    }
    let resume_no_legacy = existing.state == "no_legacy_ids"
        || existing.last_error.as_deref() == Some(ALIAS_BASELINE_NO_LEGACY_PROGRESS_ERROR);
    if !ensure_inactive_alias_baseline(store, server_id)? {
        record_state(
            store,
            server_id,
            "retryable",
            existing.probe_old_id.as_deref(),
            existing.probe_new_id.as_deref(),
            Some(if resume_no_legacy {
                ALIAS_BASELINE_NO_LEGACY_PROGRESS_ERROR
            } else {
                ALIAS_BASELINE_PROGRESS_ERROR
            }),
            false,
        )?;
        return transition_status(store, server_id);
    }
    if resume_no_legacy {
        record_state(store, server_id, "no_legacy_ids", None, None, None, false)?;
        return transition_status(store, server_id);
    }
    if supplied.is_empty() && no_legacy_state_is_current(&existing) {
        return Ok(existing);
    }
    let retrying_persisted = matches!(existing.state.as_str(), "legacy" | "retryable")
        && existing.probe_old_id.is_some()
        && existing.probe_new_id.is_some();
    let mut batch = if supplied.is_empty() || retrying_persisted {
        probe_candidates_for_status(store, &existing)?
    } else {
        ProbeCandidateBatch {
            candidates: Vec::new(),
            next_cursor: ProbeCursor::default(),
            exhausted: true,
        }
    };
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
            || batch
                .candidates
                .iter()
                .any(|existing| existing.kind == kind && existing.old_id == old_id)
        {
            continue;
        }
        batch.candidates.push(ProbeCandidate {
            kind,
            old_id,
            new_id,
            cursor_after: None,
        });
        if batch.candidates.len() >= MAX_PROBE_ATTEMPT_CANDIDATES {
            break;
        }
    }
    bounded_transition_probe(
        store,
        subsonic,
        server_id,
        batch,
        EmptyCandidateOutcome::NoLegacyIds,
    )
    .await
}

/// Revalidate the active Navidrome namespace immediately before any sync ingest.
/// Stable terminal states avoid candidate scans, persisted legacy evidence probes
/// one old/new pair, and an empty `no_legacy_ids` catalog stays network-neutral.
pub(crate) async fn revalidate_before_ingest(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
) -> Result<IdentityTransitionDto, String> {
    let lock = transition_probe_lock(server_id);
    let _guard = lock.lock().await;
    upgrade_completed_state_if_needed(store, server_id)?;
    let existing = transition_status(store, server_id)?;
    match existing.state.as_str() {
        "transition_detected" | "pending_frontend" | "ready"
            if existing.canonical_version == CANONICAL_ID_VERSION =>
        {
            return Ok(existing);
        }
        "blocked" | "awaiting_supplemental_probe"
            if existing.canonical_version == CANONICAL_ID_VERSION =>
        {
            return Ok(existing);
        }
        _ => {}
    }
    let resume_no_legacy = existing.state == "no_legacy_ids"
        || existing.last_error.as_deref() == Some(ALIAS_BASELINE_NO_LEGACY_PROGRESS_ERROR);
    if !ensure_inactive_alias_baseline(store, server_id)? {
        record_state(
            store,
            server_id,
            "retryable",
            existing.probe_old_id.as_deref(),
            existing.probe_new_id.as_deref(),
            Some(if resume_no_legacy {
                ALIAS_BASELINE_NO_LEGACY_PROGRESS_ERROR
            } else {
                ALIAS_BASELINE_PROGRESS_ERROR
            }),
            false,
        )?;
        return transition_status(store, server_id);
    }
    if resume_no_legacy {
        record_state(store, server_id, "no_legacy_ids", None, None, None, false)?;
        return transition_status(store, server_id);
    }
    if no_legacy_state_is_current(&existing) {
        return Ok(existing);
    }
    let candidates = probe_candidates_for_status(store, &existing)?;
    bounded_transition_probe(
        store,
        subsonic,
        server_id,
        candidates,
        EmptyCandidateOutcome::NoLegacyIds,
    )
    .await
}

fn probe_candidates_for_status(
    store: &LibraryStore,
    status: &IdentityTransitionDto,
) -> Result<ProbeCandidateBatch, String> {
    let mut batch = probe_candidates(store, &status.server_id)?;
    if matches!(status.state.as_str(), "legacy" | "retryable") {
        if let (Some(old_id), Some(new_id)) =
            (status.probe_old_id.as_ref(), status.probe_new_id.as_ref())
        {
            if old_id != new_id {
                if let Some(kind) = persisted_probe_kind(store, &status.server_id, old_id)? {
                    if let Some(index) = batch
                        .candidates
                        .iter()
                        .position(|candidate| candidate.kind == kind && candidate.old_id == *old_id)
                    {
                        let persisted = batch.candidates.remove(index);
                        batch.candidates.insert(0, persisted);
                    } else {
                        batch.candidates.insert(
                            0,
                            ProbeCandidate {
                                kind,
                                old_id: old_id.clone(),
                                new_id: new_id.clone(),
                                cursor_after: None,
                            },
                        );
                    }
                }
            }
        }
    }
    batch
        .candidates
        .truncate(MAX_PROBE_ATTEMPT_CANDIDATES);
    Ok(batch)
}

fn persisted_probe_kind(
    store: &LibraryStore,
    server_id: &str,
    old_id: &str,
) -> Result<Option<EntityKind>, String> {
    store.with_read_conn(|conn| {
        let track_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM track WHERE server_id = ?1 AND id = ?2 AND deleted = 0) \
             OR EXISTS(SELECT 1 FROM track_offline WHERE server_id = ?1 AND track_id = ?2)",
            params![server_id, old_id],
            |row| row.get(0),
        )?;
        if track_exists {
            return Ok(Some(EntityKind::Track));
        }
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM album WHERE server_id = ?1 AND id = ?2)",
            params![server_id, old_id],
            |row| row.get::<_, bool>(0),
        )
        .map(|exists| exists.then_some(EntityKind::Album))
    })
}

fn no_legacy_state_is_current(status: &IdentityTransitionDto) -> bool {
    status.state == "no_legacy_ids" && status.canonical_version == CANONICAL_ID_VERSION
}

struct AliasBaselineSource {
    name: &'static str,
    kind: EntityKind,
    table: &'static str,
    column: &'static str,
    filter: &'static str,
}

const ALIAS_BASELINE_SOURCES: &[AliasBaselineSource] = &[
    AliasBaselineSource {
        name: "track",
        kind: EntityKind::Track,
        table: "track",
        column: "id",
        filter: "AND deleted = 0",
    },
    AliasBaselineSource {
        name: "offline",
        kind: EntityKind::Track,
        table: "track_offline",
        column: "track_id",
        filter: "",
    },
    AliasBaselineSource {
        name: "album",
        kind: EntityKind::Album,
        table: "album",
        column: "id",
        filter: "",
    },
    AliasBaselineSource {
        name: "artist",
        kind: EntityKind::Artist,
        table: "artist",
        column: "id",
        filter: "",
    },
    AliasBaselineSource {
        name: "track_album_ref",
        kind: EntityKind::Album,
        table: "track",
        column: "album_id",
        filter: "AND deleted = 0",
    },
    AliasBaselineSource {
        name: "track_artist_ref",
        kind: EntityKind::Artist,
        table: "track",
        column: "artist_id",
        filter: "AND deleted = 0",
    },
    AliasBaselineSource {
        name: "album_artist_ref",
        kind: EntityKind::Artist,
        table: "album",
        column: "artist_id",
        filter: "",
    },
];

fn alias_baseline_marker(server_id: &str, source: &AliasBaselineSource) -> String {
    format!("{ALIAS_BASELINE_MIGRATION_PREFIX}:{server_id}:{}", source.name)
}

fn ensure_inactive_alias_baseline(store: &LibraryStore, server_id: &str) -> Result<bool, String> {
    store.with_conn_mut("navidrome_identity.alias_baseline", |conn| {
        let mut batches = 0usize;
        for source in ALIAS_BASELINE_SOURCES {
            let marker = alias_baseline_marker(server_id, source);
            loop {
                let completed: Option<Option<i64>> = conn
                    .query_row(
                        "SELECT completed_at FROM library_data_migration WHERE id = ?1",
                        params![marker],
                        |row| row.get(0),
                    )
                    .optional()?;
                if completed.flatten().is_some() {
                    break;
                }
                conn.execute(
                    "INSERT INTO library_data_migration (id, cursor_rowid, started_at) \
                     VALUES (?1, 0, strftime('%s','now')) \
                     ON CONFLICT(id) DO UPDATE SET \
                       started_at = COALESCE(library_data_migration.started_at, excluded.started_at)",
                    params![marker],
                )?;
                let cursor: Option<String> = conn.query_row(
                    "SELECT cursor_text FROM library_data_migration WHERE id = ?1",
                    params![marker],
                    |row| row.get(0),
                )?;
                let sql = format!(
                    "SELECT DISTINCT {column} FROM {table} \
                     WHERE server_id = ?1 AND {column} > COALESCE(?2, '') \
                        AND {column} IS NOT NULL AND {column} != '' {filter} \
                     ORDER BY {column} LIMIT ?3",
                    column = source.column,
                    table = source.table,
                    filter = source.filter,
                );
                let rows = conn
                    .prepare(&sql)?
                    .query_map(
                        params![server_id, cursor, ALIAS_BASELINE_BATCH_SIZE],
                        |row| row.get::<_, String>(0),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                if rows.is_empty() {
                    conn.execute(
                        "UPDATE library_data_migration \
                         SET completed_at = strftime('%s','now') WHERE id = ?1",
                        params![marker],
                    )?;
                    break;
                }
                let last_value = rows.last().cloned().or(cursor);
                let tx = conn.unchecked_transaction()?;
                insert_inactive_legacy_aliases(
                    &tx,
                    server_id,
                    source.kind,
                    rows.iter().map(String::as_str),
                    now_unix_ms(),
                )?;
                tx.execute(
                    "UPDATE library_data_migration SET cursor_text = ?2 WHERE id = ?1",
                    params![marker, last_value],
                )?;
                tx.commit()?;
                batches += 1;
                if batches >= ALIAS_BASELINE_BATCHES_PER_ATTEMPT {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    })
}

fn load_probe_cursor(store: &LibraryStore, server_id: &str) -> Result<ProbeCursor, String> {
    store.with_read_conn(|conn| {
        let encoded: Option<String> = conn
            .query_row(
            "SELECT probe_cursor FROM server_identity_transition WHERE server_id = ?1",
            params![server_id],
            |row| row.get(0),
        )
            .optional()?
            .flatten();
        Ok(encoded
            .as_deref()
            .and_then(|value| serde_json::from_str(value).ok())
            .unwrap_or_default())
    })
}

fn store_probe_cursor(
    store: &LibraryStore,
    server_id: &str,
    cursor: &ProbeCursor,
) -> Result<(), String> {
    let encoded = (cursor != &ProbeCursor::default())
        .then(|| serde_json::to_string(cursor))
        .transpose()
        .map_err(|error| error.to_string())?;
    store.with_conn("navidrome_identity.store_probe_cursor", |conn| {
        conn.execute(
            "UPDATE server_identity_transition \
             SET probe_cursor = ?2 \
             WHERE server_id = ?1",
            params![server_id, encoded],
        )?;
        Ok(())
    })
}

fn clear_probe_cursor(store: &LibraryStore, server_id: &str) -> Result<(), String> {
    store_probe_cursor(store, server_id, &ProbeCursor::default())
}

async fn bounded_transition_probe(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
    candidates: ProbeCandidateBatch,
    empty_candidate_outcome: EmptyCandidateOutcome,
) -> Result<IdentityTransitionDto, String> {
    const REVALIDATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

    tokio::time::timeout(
        REVALIDATION_TIMEOUT,
        ensure_transition_with_candidates(
            store,
            subsonic,
            server_id,
            candidates,
            empty_candidate_outcome,
        ),
    )
    .await
    .map_err(|_| "canonical-ID namespace revalidation timed out".to_string())?
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
    batch: ProbeCandidateBatch,
    empty_candidate_outcome: EmptyCandidateOutcome,
) -> Result<IdentityTransitionDto, String> {
    let existing = transition_status(store, server_id)?;
    if matches!(
        existing.state.as_str(),
        "transition_detected" | "pending_frontend" | "ready"
    ) && existing.canonical_version == CANONICAL_ID_VERSION
    {
        return Ok(existing);
    }

    if batch.candidates.is_empty() {
        if !batch.exhausted {
            let error = "canonical-ID candidate scan has more catalog rows to inspect";
            record_state(store, server_id, "retryable", None, None, Some(error), false)?;
            store_probe_cursor(store, server_id, &batch.next_cursor)?;
            return transition_status(store, server_id);
        }
        let state = match empty_candidate_outcome {
            EmptyCandidateOutcome::AwaitSupplemental => "awaiting_supplemental_probe",
            EmptyCandidateOutcome::NoLegacyIds => "no_legacy_ids",
        };
        if state == "no_legacy_ids" {
            record_state(store, server_id, state, None, None, None, false)?;
            clear_probe_cursor(store, server_id)?;
        } else {
            record_state(store, server_id, state, None, None, None, false)?;
        }
        return transition_status(store, server_id);
    }

    let mut first_retryable: Option<(ProbeCandidate, String)> = None;
    let mut conclusive_cursor: Option<ProbeCursor> = None;
    for candidate in &batch.candidates {
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
                    &batch.candidates,
                )?;
                return transition_status(store, server_id);
            }
            (Err(SubsonicError::NotFound), Err(SubsonicError::NotFound)) => {
                if let Some(cursor) = &candidate.cursor_after {
                    store_probe_cursor(store, server_id, cursor)?;
                    conclusive_cursor = Some(cursor.clone());
                }
            }
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
                if first_retryable.is_none() {
                    first_retryable = Some((candidate.clone(), error));
                }
            }
        }
    }
    if let Some((candidate, error)) = first_retryable {
        record_state(
            store,
            server_id,
            "retryable",
            Some(&candidate.old_id),
            Some(&candidate.new_id),
            Some(&error),
            false,
        )?;
        if let Some(cursor) = &conclusive_cursor {
            store_probe_cursor(store, server_id, cursor)?;
        }
        return transition_status(store, server_id);
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
    store_probe_cursor(store, server_id, &batch.next_cursor)?;
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
    let transition_lock = transition_probe_lock(server_id);
    let _transition_guard = transition_lock.lock().await;
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
                cursor_after: None,
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

pub(crate) fn transition_probe_lock(server_id: &str) -> Arc<AsyncMutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(lock) = locks.get(server_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(server_id.to_string(), Arc::downgrade(&lock));
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
        EntityKind::Artist => Err(SubsonicError::Decode(
            "artist identity candidates are not directly probeable".to_string(),
        )),
    }
}

fn probe_result_label(result: &Result<(), SubsonicError>) -> String {
    match result {
        Ok(()) => "ok".to_string(),
        Err(error) => error.to_string(),
    }
}

fn probe_candidates(
    store: &LibraryStore,
    server_id: &str,
) -> Result<ProbeCandidateBatch, String> {
    const PAGE_SIZE: usize = 64;
    const MAX_SCANNED_ROWS: usize = 512;
    let cursor = load_probe_cursor(store, server_id)?;
    store.with_read_conn(|conn| {
        let mut candidates: Vec<ProbeCandidate> = Vec::new();
        let sources = [
            (EntityKind::Track, "track", "id"),
            (EntityKind::Track, "track_offline", "track_id"),
            (EntityKind::Album, "album", "id"),
        ];
        let mut scanned_rows = 0usize;
        for (source, (kind, table, column)) in sources.iter().copied().enumerate().skip(cursor.source)
        {
            let live_filter = if table == "track" {
                " AND deleted = 0"
            } else {
                ""
            };
            let mut after = (source == cursor.source)
                .then(|| cursor.after_id.clone())
                .flatten();
            loop {
                if scanned_rows >= MAX_SCANNED_ROWS
                    || candidates.len() >= MAX_PROBE_CANDIDATES
                {
                    return Ok(ProbeCandidateBatch {
                        candidates,
                        next_cursor: ProbeCursor {
                            source,
                            after_id: after,
                        },
                        exhausted: false,
                    });
                }
                let limit = PAGE_SIZE.min(MAX_SCANNED_ROWS - scanned_rows);
                let page = {
                    let (sql, binds): (String, Vec<&dyn rusqlite::ToSql>) = match after.as_ref() {
                        Some(after) => (
                            format!(
                                "SELECT {column} FROM {table} WHERE server_id = ?1{live_filter} \
                                 AND {column} > ?2 ORDER BY {column} LIMIT {limit}"
                            ),
                            vec![&server_id, after],
                        ),
                        None => (
                            format!(
                                "SELECT {column} FROM {table} WHERE server_id = ?1{live_filter} \
                                 ORDER BY {column} LIMIT {limit}"
                            ),
                            vec![&server_id],
                        ),
                    };
                    conn.prepare(&sql)?
                        .query_map(binds.as_slice(), |row| row.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                };
                if page.is_empty() {
                    break;
                }
                let page_len = page.len();
                for old_id in page {
                    scanned_rows += 1;
                    after = Some(old_id.clone());
                    let new_id = canonical_id(&old_id);
                    if new_id != old_id
                        && !candidates
                            .iter()
                            .any(|candidate| candidate.kind == kind && candidate.old_id == old_id)
                    {
                        candidates.push(ProbeCandidate {
                            kind,
                            old_id,
                            new_id,
                            cursor_after: Some(ProbeCursor {
                                source,
                                after_id: after.clone(),
                            }),
                        });
                        if candidates.len() >= MAX_PROBE_CANDIDATES {
                            return Ok(ProbeCandidateBatch {
                                candidates,
                                next_cursor: ProbeCursor {
                                    source,
                                    after_id: after,
                                },
                                exhausted: false,
                            });
                        }
                    }
                }
                if page_len < limit {
                    break;
                }
            }
        }
        Ok(ProbeCandidateBatch {
            candidates,
            next_cursor: ProbeCursor::default(),
            exhausted: true,
        })
    })
}

fn upgrade_completed_state_if_needed(
    store: &LibraryStore,
    server_id: &str,
) -> Result<(), String> {
    let status = transition_status(store, server_id)?;
    if status.canonical_version >= CANONICAL_ID_VERSION
        || !matches!(status.state.as_str(), "pending_frontend" | "ready")
    {
        return Ok(());
    }

    let result = store.with_conn_mut("navidrome_identity.upgrade_completed_state", |conn| {
        let tx = conn.transaction()?;
        reconcile_orphan_offline_ids(&tx, server_id, now_unix_ms())?;
        tx.execute(
            "UPDATE server_identity_transition \
             SET canonical_version = ?2, last_error = NULL \
             WHERE server_id = ?1 AND state IN ('pending_frontend', 'ready')",
            params![server_id, CANONICAL_ID_VERSION],
        )?;
        tx.commit()
    });
    if let Err(error) = result {
        record_state(
            store,
            server_id,
            "blocked",
            status.probe_old_id.as_deref(),
            status.probe_new_id.as_deref(),
            Some(&format!("canonical-ID version upgrade failed: {error}")),
            status.state == "pending_frontend" || status.state == "ready",
        )?;
        return Err(error);
    }
    Ok(())
}

fn reconcile_orphan_offline_ids(
    tx: &Transaction<'_>,
    server_id: &str,
    now: i64,
) -> rusqlite::Result<()> {
    let offline_ids = tx
        .prepare("SELECT track_id FROM track_offline WHERE server_id = ?1 ORDER BY track_id")?
        .query_map(params![server_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for old_id in offline_ids {
        let new_id = canonical_id(&old_id);
        if new_id == old_id {
            continue;
        }
        let destination_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM track_offline WHERE server_id = ?1 AND track_id = ?2)",
            params![server_id, new_id],
            |row| row.get(0),
        )?;
        if destination_exists {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                io::Error::other(format!(
                    "canonical offline track id collision at `{new_id}`"
                )),
            )));
        }
        tx.execute(
            "UPDATE track_offline SET track_id = ?3 \
             WHERE server_id = ?1 AND track_id = ?2",
            params![server_id, old_id, new_id],
        )?;
        tx.execute(
            "INSERT INTO track_id_history \
             (server_id, old_id, new_id, content_hash, server_path, remapped_at) \
             VALUES (?1, ?2, ?3, NULL, NULL, ?4) \
             ON CONFLICT(server_id, old_id) DO UPDATE SET \
               new_id = excluded.new_id, remapped_at = excluded.remapped_at",
            params![server_id, old_id, new_id, now],
        )?;
        tx.execute(
            "INSERT INTO entity_id_remap \
             (server_id, entity_kind, old_id, new_id, remapped_at, active) \
             VALUES (?1, 'track', ?2, ?3, ?4, 1) \
             ON CONFLICT(server_id, entity_kind, old_id) DO UPDATE SET \
               new_id = excluded.new_id, remapped_at = excluded.remapped_at, active = 1",
            params![server_id, old_id, new_id, now],
        )?;
    }
    Ok(())
}

pub fn run_native_migration(store: &LibraryStore, server_id: &str) -> Result<(), String> {
    upgrade_completed_state_if_needed(store, server_id)?;
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
        let now = now_unix_ms();
        store.with_conn("navidrome_identity.block_failed_migration", |conn| {
            conn.execute(
                "UPDATE server_identity_transition \
                 SET state = 'blocked', last_error = ?2, detected_at = ?3 \
                 WHERE server_id = ?1 AND state = 'transition_detected'",
                params![server_id, error, now],
            )?;
            Ok(())
        })?;
        return Err(error);
    }
    Ok(())
}

fn collect_library_maps(conn: &Connection, server_id: &str) -> rusqlite::Result<LibraryIdMaps> {
    let artists = collect_entity_map(conn, "artist", server_id)?;
    let albums = collect_entity_map(conn, "album", server_id)?;
    let mut track_values = collect_column_values(conn, "track", "id", server_id)?;
    track_values.extend(collect_column_values(
        conn,
        "track_offline",
        "track_id",
        server_id,
    )?);
    track_values.sort();
    track_values.dedup();
    let tracks = track_values
        .into_iter()
        .filter_map(|old_id| {
            let new_id = canonical_id(&old_id);
            (new_id != old_id).then_some(IdMap { old_id, new_id })
        })
        .collect::<Vec<_>>();
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
    for (table, map, require_old_entity) in [
        ("artist", "canonical_artist_map", false),
        ("album", "canonical_album_map", false),
        ("track", "canonical_track_map", true),
    ] {
        let old_entity_filter = if require_old_entity {
            format!(
                " AND EXISTS (SELECT 1 FROM {table} old_entity \
                   WHERE old_entity.server_id = entity.server_id \
                     AND old_entity.id = mapping.old_id)"
            )
        } else {
            String::new()
        };
        let collision: Option<String> = tx
            .query_row(
                &format!(
                    "SELECT entity.id FROM {table} entity JOIN {map} mapping ON mapping.new_id = entity.id \
                     WHERE entity.server_id = ?1{old_entity_filter} LIMIT 1"
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
    store.with_conn_mut("navidrome_identity.record_transition", |conn| {
        let tx = conn.transaction()?;
        let applied = write_state(
            &tx,
            server_id,
            "transition_detected",
            Some(&evidence.old_id),
            Some(&evidence.new_id),
            None,
            false,
            now,
        )?;
        if !applied {
            tx.rollback()?;
            return Ok(());
        }
        {
            let mut statement = tx.prepare(
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
        }
        tx.commit()
    })
}

pub(crate) fn record_deterministic_transition_if_legacy_state(
    conn: &Connection,
    server_id: &str,
    entity_kind: &str,
    old_id: &str,
    new_id: &str,
) -> rusqlite::Result<bool> {
    let state: Option<String> = conn
        .query_row(
            "SELECT state FROM server_identity_transition WHERE server_id = ?1",
            params![server_id],
            |row| row.get(0),
        )
        .optional()?;
    if !matches!(state.as_deref(), Some("legacy" | "no_legacy_ids")) {
        return Ok(false);
    }

    let now = now_unix_ms();
    let applied = write_state(
        conn,
        server_id,
        "transition_detected",
        Some(old_id),
        Some(new_id),
        None,
        false,
        now,
    )?;
    if !applied {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO entity_id_remap(server_id, entity_kind, old_id, new_id, remapped_at, active) \
         VALUES (?1, ?2, ?3, ?4, ?5, 0) \
         ON CONFLICT(server_id, entity_kind, old_id) DO UPDATE SET \
           new_id = excluded.new_id, remapped_at = excluded.remapped_at, active = 0",
        params![server_id, entity_kind, old_id, new_id, now],
    )?;
    Ok(true)
}

pub(crate) fn load_deterministic_write_guard(
    conn: &Connection,
    server_id: &str,
) -> rusqlite::Result<DeterministicWriteGuard> {
    conn.query_row(
        "SELECT state, probe_old_id, probe_new_id \
         FROM server_identity_transition WHERE server_id = ?1",
        params![server_id],
        |row| {
            let state: String = row.get(0)?;
            Ok(DeterministicWriteGuard {
                enabled: matches!(state.as_str(), "legacy" | "no_legacy_ids"),
                probe_old_id: row.get(1)?,
                probe_new_id: row.get(2)?,
            })
        },
    )
    .optional()
    .map(|guard| guard.unwrap_or_default())
}

pub(crate) fn register_inactive_legacy_aliases<'a>(
    conn: &Connection,
    server_id: &str,
    guard: &DeterministicWriteGuard,
    aliases: impl IntoIterator<Item = (EntityKind, &'a str)>,
    observed_at: i64,
) -> rusqlite::Result<usize> {
    if !guard.enabled() {
        return Ok(0);
    }
    let mut grouped = HashMap::<EntityKind, HashSet<&str>>::new();
    for (kind, observed_id) in aliases {
        grouped.entry(kind).or_default().insert(observed_id);
    }
    let mut inserted = 0usize;
    for (kind, ids) in grouped {
        inserted += insert_inactive_legacy_aliases(
            conn,
            server_id,
            kind,
            ids,
            observed_at,
        )?;
    }
    Ok(inserted)
}

fn insert_inactive_legacy_aliases<'a>(
    conn: &Connection,
    server_id: &str,
    kind: EntityKind,
    observed_ids: impl IntoIterator<Item = &'a str>,
    observed_at: i64,
) -> rusqlite::Result<usize> {
    let mut statement = conn.prepare_cached(
        "INSERT INTO entity_id_remap \
         (server_id, entity_kind, old_id, new_id, remapped_at, active) \
         VALUES (?1, ?2, ?3, ?4, ?5, 0) \
         ON CONFLICT(server_id, entity_kind, old_id) DO UPDATE SET \
           new_id = excluded.new_id, remapped_at = excluded.remapped_at, \
           active = entity_id_remap.active",
    )?;
    let mut inserted = 0usize;
    let entity_kind = entity_kind_label(kind);
    for observed_id in observed_ids {
        let canonical = canonical_id(observed_id);
        if canonical == observed_id {
            continue;
        }
        statement.execute(params![
            server_id,
            entity_kind,
            observed_id,
            canonical,
            observed_at
        ])?;
        inserted += 1;
    }
    Ok(inserted)
}

pub(crate) fn find_deterministic_legacy_id_with_guard(
    conn: &Connection,
    server_id: &str,
    guard: &DeterministicWriteGuard,
    kind: EntityKind,
    incoming_id: &str,
) -> rusqlite::Result<Option<String>> {
    if !guard.enabled() {
        return Ok(None);
    }
    find_deterministic_legacy_id(
        conn,
        server_id,
        kind,
        incoming_id,
        guard.hinted_old_id(incoming_id),
    )
}

pub(crate) fn find_deterministic_legacy_id(
    conn: &Connection,
    server_id: &str,
    kind: EntityKind,
    incoming_id: &str,
    hinted_old_id: Option<&str>,
) -> rusqlite::Result<Option<String>> {
    if let Some(old_id) = hinted_old_id {
        if old_id != incoming_id
            && canonical_id(old_id) == incoming_id
            && legacy_entity_exists(conn, server_id, kind, old_id)?
        {
            return Ok(Some(old_id.to_string()));
        }
    }

    let entity_kind = entity_kind_label(kind);
    let persisted: Option<String> = conn
        .query_row(
            "SELECT old_id FROM entity_id_remap \
             WHERE server_id = ?1 AND entity_kind = ?2 AND new_id = ?3 \
             ORDER BY active DESC, remapped_at DESC LIMIT 1",
            params![server_id, entity_kind, incoming_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(old_id) = persisted {
        if legacy_entity_exists(conn, server_id, kind, &old_id)? {
            return Ok(Some(old_id));
        }
    }

    for old_id in reversible_legacy_ids(incoming_id) {
        if old_id != incoming_id && legacy_entity_exists(conn, server_id, kind, &old_id)? {
            return Ok(Some(old_id));
        }
    }
    Ok(None)
}

fn legacy_entity_exists(
    conn: &Connection,
    server_id: &str,
    kind: EntityKind,
    old_id: &str,
) -> rusqlite::Result<bool> {
    match kind {
        EntityKind::Track => conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM track \
               WHERE server_id = ?1 AND id = ?2 AND deleted = 0) \
             OR EXISTS(SELECT 1 FROM track_offline \
               WHERE server_id = ?1 AND track_id = ?2)",
            params![server_id, old_id],
            |row| row.get(0),
        ),
        EntityKind::Album => conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM album WHERE server_id = ?1 AND id = ?2)",
            params![server_id, old_id],
            |row| row.get(0),
        ),
        EntityKind::Artist => conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM artist WHERE server_id = ?1 AND id = ?2)",
            params![server_id, old_id],
            |row| row.get(0),
        ),
    }
}

fn reversible_legacy_ids(canonical: &str) -> Vec<String> {
    if canonical.len() != 22 {
        return Vec::new();
    }
    let Ok(value) = decode_base62_u128(canonical) else {
        return Vec::new();
    };
    let bytes = value.to_be_bytes();
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let uuid = format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    );
    vec![hex.clone(), hex.to_uppercase(), uuid.clone(), uuid.to_uppercase()]
}

fn entity_kind_label(kind: EntityKind) -> &'static str {
    match kind {
        EntityKind::Track => "track",
        EntityKind::Album => "album",
        EntityKind::Artist => "artist",
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
        )?;
        Ok(())
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
) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "INSERT INTO server_identity_transition \
         (server_id, canonical_version, state, probe_old_id, probe_new_id, detected_at, native_migrated_at, last_error) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(server_id) DO UPDATE SET \
           canonical_version = excluded.canonical_version, state = excluded.state, \
           probe_old_id = excluded.probe_old_id, probe_new_id = excluded.probe_new_id, \
           detected_at = excluded.detected_at, \
           native_migrated_at = COALESCE(excluded.native_migrated_at, server_identity_transition.native_migrated_at), \
           frontend_acked_at = CASE WHEN excluded.state = 'pending_frontend' THEN NULL ELSE server_identity_transition.frontend_acked_at END, \
            last_error = excluded.last_error \
           WHERE server_identity_transition.canonical_version != excluded.canonical_version \
              OR server_identity_transition.state NOT IN ('transition_detected', 'pending_frontend', 'ready') \
              OR server_identity_transition.state = 'transition_detected' \
                 AND excluded.state IN ('transition_detected', 'pending_frontend') \
              OR server_identity_transition.state = 'pending_frontend' \
                 AND excluded.state IN ('pending_frontend', 'ready', 'blocked') \
              OR server_identity_transition.state = 'ready' AND excluded.state = 'ready'",
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
    Ok(changed > 0)
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

    fn incoming_track(id: &str) -> crate::repos::TrackRow {
        crate::repos::TrackRow {
            server_id: "s1".into(),
            id: id.into(),
            title: "Track".into(),
            title_sort: None,
            artist: None,
            artist_id: None,
            album: "Album".into(),
            album_id: None,
            album_artist: None,
            duration_sec: 0,
            track_number: None,
            disc_number: None,
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
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
    fn reversible_legacy_ids_round_trip_hex_and_uuid_forms() {
        for old in [
            "e3b7fc2ae9447bbec37a13bf916e3cf6",
            "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        ] {
            assert!(reversible_legacy_ids(&canonical_id(old))
                .into_iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(old)));
        }
    }

    #[test]
    fn album_guard_uses_bounded_primary_key_lookups() {
        let store = LibraryStore::open_in_memory();
        let old = "11112222333344445555666677778888";
        let new = canonical_id(old);
        store
            .with_conn("test.album_guard_plan", |conn| {
                conn.execute(
                    "INSERT INTO album(server_id,id,name,synced_at,raw_json) \
                     VALUES ('s1',?1,'Legacy',1,'{}')",
                    params![old],
                )?;
                let plan = conn
                    .prepare(
                        "EXPLAIN QUERY PLAN SELECT EXISTS(SELECT 1 FROM album \
                         WHERE server_id = ?1 AND id = ?2)",
                    )?
                    .query_map(params!["s1", old], |row| row.get::<_, String>(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert!(plan.iter().any(|detail| detail.contains("sqlite_autoindex_album_1")));
                assert!(!plan.iter().any(|detail| detail.contains("SCAN album")));
                assert_eq!(
                    find_deterministic_legacy_id(conn, "s1", EntityKind::Album, &new, None)?,
                    Some(old.to_string())
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn canonical_alias_reverse_lookup_uses_the_new_id_index() {
        let store = LibraryStore::open_in_memory();
        store
            .with_read_conn(|conn| {
                let plan = conn
                    .prepare(
                        "EXPLAIN QUERY PLAN SELECT old_id FROM entity_id_remap \
                         WHERE server_id = ?1 AND entity_kind = ?2 AND new_id = ?3 \
                         ORDER BY active DESC, remapped_at DESC LIMIT 1",
                    )?
                    .query_map(params!["s1", "artist", "canonical"], |row| {
                        row.get::<_, String>(3)
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert!(plan
                    .iter()
                    .any(|detail| detail.contains("idx_entity_id_remap_new")));
                assert!(!plan.iter().any(|detail| detail.contains("SCAN entity_id_remap")));
                Ok(())
            })
            .unwrap();
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
    async fn retries_advance_past_eight_dead_candidates_to_the_ninth() {
        let server = MockServer::start().await;
        let ids: Vec<String> = (0..9).map(|index| format!("{index:032x}")).collect();
        for old in &ids[..8] {
            let new = canonical_id(old);
            for id in [old.as_str(), new.as_str()] {
                Mock::given(method("GET"))
                    .and(path("/rest/getSong.view"))
                    .and(query_param("id", id))
                    .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
                    .expect(1)
                    .mount(&server)
                    .await;
            }
        }
        let decisive_old = &ids[8];
        let decisive_new = canonical_id(decisive_old);
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", decisive_old.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", decisive_new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(song_response(&decisive_new)))
            .expect(1)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        for id in &ids {
            seed_legacy_track(&store, id);
        }

        let client = test_client(&server.uri());
        let first = ensure_transition(&store, &client, "s1").await.unwrap();
        assert_eq!(first.state, "retryable");
        let cursor_after_first = load_probe_cursor(&store, "s1").unwrap();
        assert_eq!(cursor_after_first.after_id.as_deref(), Some(ids[7].as_str()));

        let second = ensure_transition(&store, &client, "s1").await.unwrap();
        assert_eq!(second.state, "transition_detected");
        assert_eq!(second.probe_old_id.as_deref(), Some(decisive_old.as_str()));
        assert_eq!(second.probe_new_id.as_deref(), Some(decisive_new.as_str()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn persisted_transient_is_probed_with_next_eight_and_ninth_is_decisive() {
        let server = MockServer::start().await;
        let ids: Vec<String> = (0..9).map(|index| format!("{index:032x}")).collect();
        let persisted_old = &ids[0];
        let persisted_new = canonical_id(persisted_old);
        for id in [persisted_old.as_str(), persisted_new.as_str()] {
            Mock::given(method("GET"))
                .and(path("/rest/getSong.view"))
                .and(query_param("id", id))
                .respond_with(ResponseTemplate::new(503))
                .expect(2)
                .mount(&server)
                .await;
        }
        for old in &ids[1..8] {
            let new = canonical_id(old);
            for id in [old.as_str(), new.as_str()] {
                Mock::given(method("GET"))
                    .and(path("/rest/getSong.view"))
                    .and(query_param("id", id))
                    .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
                    .expect(1)
                    .mount(&server)
                    .await;
            }
        }
        let decisive_old = &ids[8];
        let decisive_new = canonical_id(decisive_old);
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", decisive_old.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", decisive_new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(song_response(&decisive_new)))
            .expect(1)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        for id in &ids {
            seed_legacy_track(&store, id);
        }
        record_state(
            &store,
            "s1",
            "retryable",
            Some(persisted_old),
            Some(&persisted_new),
            Some("transient"),
            false,
        )
        .unwrap();

        let client = test_client(&server.uri());
        let first = ensure_transition(&store, &client, "s1").await.unwrap();
        assert_eq!(first.state, "retryable");
        assert_eq!(first.probe_old_id.as_deref(), Some(persisted_old.as_str()));
        assert_eq!(
            load_probe_cursor(&store, "s1").unwrap().after_id.as_deref(),
            Some(ids[7].as_str())
        );

        let second = ensure_transition(&store, &client, "s1").await.unwrap();
        assert_eq!(second.state, "transition_detected");
        assert_eq!(second.probe_old_id.as_deref(), Some(decisive_old.as_str()));
        assert_eq!(second.probe_new_id.as_deref(), Some(decisive_new.as_str()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn upgrade_baselines_existing_overflow_artist_before_no_legacy_readiness() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        let old = "ZZZZZZZZZZZZZZZZZZZZZZ";
        let new = canonical_id(old);
        store
            .with_conn("test.seed_existing_overflow_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist(server_id,id,name,synced_at) \
                     VALUES ('s1',?1,'Legacy Artist',1)",
                    params![old],
                )?;
                Ok(())
            })
            .unwrap();

        let status = ensure_transition_with_probe_candidates(
            &store,
            &test_client(&server.uri()),
            "s1",
            Vec::new(),
        )
        .await
        .unwrap();

        assert_eq!(status.state, "no_legacy_ids");
        let alias: (String, i64) = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT old_id, active FROM entity_id_remap \
                     WHERE server_id = 's1' AND entity_kind = 'artist' AND new_id = ?1",
                    params![new],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(alias, (old.into(), 0));
        let completed: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM library_data_migration \
                     WHERE id LIKE ?1 AND completed_at IS NOT NULL",
                    params![format!("{ALIAS_BASELINE_MIGRATION_PREFIX}:s1:%")],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(completed, ALIAS_BASELINE_SOURCES.len() as i64);

        let repo = crate::repos::ArtistRepository::new(&store);
        let index = psysonic_integration::subsonic::ArtistIndex {
            last_modified_ms: Some(1),
            ignored_articles: None,
            index: vec![psysonic_integration::subsonic::IndexBucket {
                name: "A".into(),
                artist: vec![psysonic_integration::subsonic::ArtistRef {
                    id: new.clone(),
                    name: "Canonical Artist".into(),
                    album_count: Some(1),
                    cover_art: None,
                }],
            }],
        };
        let (_, transition) = repo.upsert_index("s1", &index, 2).unwrap();
        assert_eq!(transition.unwrap().old_id, old);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn alias_baseline_resumes_from_durable_artist_cursor() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        store
            .with_conn("test.seed_large_artist_alias_baseline", |conn| {
                let mut insert = conn.prepare(
                    "INSERT INTO artist(server_id,id,name,synced_at) VALUES ('s1',?1,?2,1)",
                )?;
                for index in 0..1_025 {
                    insert.execute(params![format!("{index:032x}"), format!("Artist {index}")])?;
                }
                Ok(())
            })
            .unwrap();
        let client = test_client(&server.uri());

        let first = ensure_transition_with_probe_candidates(&store, &client, "s1", Vec::new())
            .await
            .unwrap();
        assert_eq!(first.state, "retryable");
        assert_eq!(first.last_error.as_deref(), Some(ALIAS_BASELINE_PROGRESS_ERROR));
        let artist_marker = alias_baseline_marker(
            "s1",
            ALIAS_BASELINE_SOURCES
                .iter()
                .find(|source| source.name == "artist")
                .unwrap(),
        );
        let (cursor, completed, aliases): (Option<String>, Option<i64>, i64) = store
            .with_read_conn(|conn| {
                let (cursor, completed) = conn.query_row(
                    "SELECT cursor_text, completed_at FROM library_data_migration WHERE id = ?1",
                    params![artist_marker],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let aliases = conn.query_row(
                    "SELECT COUNT(*) FROM entity_id_remap \
                     WHERE server_id = 's1' AND entity_kind = 'artist'",
                    [],
                    |row| row.get(0),
                )?;
                Ok((cursor, completed, aliases))
            })
            .unwrap();
        assert_eq!(cursor, Some(format!("{:032x}", 1_023)));
        assert!(completed.is_none());
        assert_eq!(aliases, 1_024);

        let second = ensure_transition_with_probe_candidates(&store, &client, "s1", Vec::new())
            .await
            .unwrap();
        assert_eq!(second.state, "no_legacy_ids");
        let (completed, aliases): (Option<i64>, i64) = store
            .with_read_conn(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT completed_at FROM library_data_migration WHERE id = ?1",
                        params![artist_marker],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM entity_id_remap \
                         WHERE server_id = 's1' AND entity_kind = 'artist'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert!(completed.is_some());
        assert_eq!(aliases, 1_025);
    }

    #[test]
    fn transition_state_cannot_downgrade_after_detection() {
        let store = LibraryStore::open_in_memory();
        record_state(
            &store,
            "s1",
            "transition_detected",
            Some("old"),
            Some("new"),
            None,
            false,
        )
        .unwrap();
        record_state(
            &store,
            "s1",
            "legacy",
            Some("old"),
            Some("new"),
            None,
            false,
        )
        .unwrap();

        assert_eq!(transition_status(&store, "s1").unwrap().state, "transition_detected");
    }

    #[test]
    fn transient_probe_failure_replaces_pretransition_ready_states() {
        for initial in ["legacy", "no_legacy_ids", "blocked"] {
            let store = LibraryStore::open_in_memory();
            record_state(&store, "s1", initial, Some("old"), Some("new"), None, false)
                .unwrap();
            record_state(
                &store,
                "s1",
                "retryable",
                Some("old"),
                Some("new"),
                Some("transient probe failure"),
                false,
            )
            .unwrap();

            let status = transition_status(&store, "s1").unwrap();
            assert_eq!(status.state, "retryable", "initial state: {initial}");
            assert!(assert_sync_ready(&store, "s1").is_err());
        }
    }

    #[test]
    fn stale_transition_detection_cannot_deactivate_ready_remaps() {
        let store = LibraryStore::open_in_memory();
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        let candidate = ProbeCandidate {
            kind: EntityKind::Track,
            old_id: old.to_string(),
            new_id: new.clone(),
            cursor_after: None,
        };
        record_transition_detected(&store, "s1", &candidate, std::slice::from_ref(&candidate))
            .unwrap();
        run_native_migration(&store, "s1").unwrap();
        acknowledge_frontend(&store, "s1").unwrap();

        record_transition_detected(&store, "s1", &candidate, std::slice::from_ref(&candidate))
            .unwrap();

        assert_eq!(transition_status(&store, "s1").unwrap().state, "ready");
        assert_eq!(resolve_remapped_id(&store, "s1", "track", old).unwrap(), new);
    }

    #[test]
    fn alias_baseline_sources_use_indexed_keyset_plans() {
        let store = LibraryStore::open_in_memory();
        store
            .with_read_conn(|conn| {
                for source in ALIAS_BASELINE_SOURCES {
                    let sql = format!(
                        "EXPLAIN QUERY PLAN SELECT DISTINCT {column} FROM {table} \
                         WHERE server_id = ?1 AND {column} > COALESCE(?2, '') \
                           AND {column} IS NOT NULL AND {column} != '' {filter} \
                         ORDER BY {column} LIMIT ?3",
                        column = source.column,
                        table = source.table,
                        filter = source.filter,
                    );
                    let plan = conn
                        .prepare(&sql)?
                        .query_map(params!["s1", Option::<String>::None, 256], |row| {
                            row.get::<_, String>(3)
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    assert!(
                        plan.iter().any(|detail| detail.contains("SEARCH")),
                        "{} baseline plan was not indexed: {plan:?}",
                        source.name,
                    );
                    assert!(
                        !plan.iter().any(|detail| detail.contains("USE TEMP B-TREE")),
                        "{} baseline plan sorted through a temp B-tree: {plan:?}",
                        source.name,
                    );
                }
                Ok(())
            })
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn transient_candidate_does_not_hide_decisive_later_candidate() {
        let server = MockServer::start().await;
        let transient_old = "00112233445566778899aabbccddeeff";
        let transient_new = canonical_id(transient_old);
        for id in [transient_old, transient_new.as_str()] {
            Mock::given(method("GET"))
                .and(path("/rest/getSong.view"))
                .and(query_param("id", id))
                .respond_with(ResponseTemplate::new(503))
                .expect(1)
                .mount(&server)
                .await;
        }
        let decisive_old = "11112222333344445555666677778888";
        let decisive_new = canonical_id(decisive_old);
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", decisive_old))
            .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", decisive_new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(song_response(&decisive_new)))
            .expect(1)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        seed_legacy_track(&store, transient_old);
        seed_legacy_track(&store, decisive_old);
        let batch = ProbeCandidateBatch {
            candidates: vec![
                ProbeCandidate {
                    kind: EntityKind::Track,
                    old_id: transient_old.into(),
                    new_id: transient_new,
                    cursor_after: Some(ProbeCursor {
                        source: 0,
                        after_id: Some(transient_old.into()),
                    }),
                },
                ProbeCandidate {
                    kind: EntityKind::Track,
                    old_id: decisive_old.into(),
                    new_id: decisive_new.clone(),
                    cursor_after: Some(ProbeCursor {
                        source: 0,
                        after_id: Some(decisive_old.into()),
                    }),
                },
            ],
            next_cursor: ProbeCursor {
                source: 0,
                after_id: Some(decisive_old.into()),
            },
            exhausted: false,
        };

        let status = ensure_transition_with_candidates(
            &store,
            &test_client(&server.uri()),
            "s1",
            batch,
            EmptyCandidateOutcome::NoLegacyIds,
        )
        .await
        .unwrap();

        assert_eq!(status.state, "transition_detected");
        assert_eq!(status.probe_old_id.as_deref(), Some(decisive_old));
        assert_eq!(status.probe_new_id.as_deref(), Some(decisive_new.as_str()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn dead_candidate_advances_cursor_after_earlier_transient() {
        let server = MockServer::start().await;
        let transient_old = "00112233445566778899aabbccddeeff";
        let transient_new = canonical_id(transient_old);
        for id in [transient_old, transient_new.as_str()] {
            Mock::given(method("GET"))
                .and(path("/rest/getSong.view"))
                .and(query_param("id", id))
                .respond_with(ResponseTemplate::new(503))
                .expect(1)
                .mount(&server)
                .await;
        }
        let dead_old = "11112222333344445555666677778888";
        let dead_new = canonical_id(dead_old);
        for id in [dead_old, dead_new.as_str()] {
            Mock::given(method("GET"))
                .and(path("/rest/getSong.view"))
                .and(query_param("id", id))
                .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
                .expect(1)
                .mount(&server)
                .await;
        }
        let store = LibraryStore::open_in_memory();
        seed_legacy_track(&store, transient_old);
        seed_legacy_track(&store, dead_old);
        let batch = ProbeCandidateBatch {
            candidates: vec![
                ProbeCandidate {
                    kind: EntityKind::Track,
                    old_id: transient_old.into(),
                    new_id: transient_new.clone(),
                    cursor_after: Some(ProbeCursor {
                        source: 0,
                        after_id: Some(transient_old.into()),
                    }),
                },
                ProbeCandidate {
                    kind: EntityKind::Track,
                    old_id: dead_old.into(),
                    new_id: dead_new,
                    cursor_after: Some(ProbeCursor {
                        source: 0,
                        after_id: Some(dead_old.into()),
                    }),
                },
            ],
            next_cursor: ProbeCursor {
                source: 0,
                after_id: Some(dead_old.into()),
            },
            exhausted: false,
        };

        let status = ensure_transition_with_candidates(
            &store,
            &test_client(&server.uri()),
            "s1",
            batch,
            EmptyCandidateOutcome::NoLegacyIds,
        )
        .await
        .unwrap();

        assert_eq!(status.state, "retryable");
        assert_eq!(status.probe_old_id.as_deref(), Some(transient_old));
        assert_eq!(status.probe_new_id.as_deref(), Some(transient_new.as_str()));
        assert_eq!(
            load_probe_cursor(&store, "s1").unwrap().after_id.as_deref(),
            Some(dead_old)
        );
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
    async fn no_legacy_ids_write_guard_detects_a_later_canonical_transition() {
        let store = LibraryStore::open_in_memory();
        let unreachable = test_client("http://127.0.0.1:9");
        ensure_transition_with_probe_candidates(&store, &unreachable, "s1", Vec::new())
            .await
            .unwrap();

        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        let repo = crate::repos::TrackRepository::new(&store);
        let legacy = repo
            .upsert_delta_batch_with_remap(&[incoming_track(old)], false)
            .unwrap();
        assert!(legacy.identity_transition.is_none());
        assert_eq!(transition_status(&store, "s1").unwrap().state, "no_legacy_ids");

        let stats = repo
            .upsert_delta_batch_with_remap(&[incoming_track(&new)], false)
            .unwrap();

        assert!(stats.identity_transition.is_some());
        assert_eq!(transition_status(&store, "s1").unwrap().state, "transition_detected");
    }

    #[test]
    fn overflowing_base62_track_alias_detects_later_canonical_id() {
        let store = LibraryStore::open_in_memory();
        record_state(
            &store,
            "s1",
            "no_legacy_ids",
            None,
            None,
            None,
            false,
        )
        .unwrap();
        let old = "ZZZZZZZZZZZZZZZZZZZZZZ";
        let new = canonical_id(old);
        let repo = crate::repos::TrackRepository::new(&store);

        assert!(repo
            .upsert_delta_batch_with_remap(&[incoming_track(old)], false)
            .unwrap()
            .identity_transition
            .is_none());
        let alias: (String, i64) = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT old_id, active FROM entity_id_remap \
                     WHERE server_id = 's1' AND entity_kind = 'track' AND new_id = ?1",
                    params![new],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(alias, (old.into(), 0));

        let transition = repo
            .upsert_delta_batch_with_remap(&[incoming_track(&new)], false)
            .unwrap()
            .identity_transition
            .unwrap();
        assert_eq!(transition.old_id, old);
        assert_eq!(transition.new_id, new);
        assert_eq!(transition_status(&store, "s1").unwrap().state, "transition_detected");
    }

    #[tokio::test]
    async fn delta_revalidation_preserves_no_legacy_ids_for_empty_catalog() {
        let store = LibraryStore::open_in_memory();
        record_state(
            &store,
            "s1",
            "no_legacy_ids",
            None,
            None,
            None,
            false,
        )
        .unwrap();

        let status = revalidate_before_ingest(
            &store,
            &test_client("http://127.0.0.1:9"),
            "s1",
        )
        .await
        .unwrap();

        assert_eq!(status.state, "no_legacy_ids");
        assert!(assert_sync_ready(&store, "s1").is_ok());
    }

    #[tokio::test]
    async fn current_no_legacy_state_ignores_routine_catalog_timestamp_updates() {
        let store = LibraryStore::open_in_memory();
        let canonical = canonical_id("e3b7fc2ae9447bbec37a13bf916e3cf6");
        store
            .with_conn("test.seed_canonical_only", |conn| {
                for index in 0..1_000 {
                    conn.execute(
                        "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) \
                         VALUES ('s1',?1,'Canonical','Album',?2,'{}')",
                        params![format!("canonical-{index:04}"), index],
                    )?;
                }
                conn.execute(
                    "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) \
                     VALUES ('s1',?1,'Canonical','Album',2000,'{}')",
                    params![canonical],
                )?;
                conn.execute(
                    "INSERT INTO server_identity_transition \
                     (server_id, canonical_version, state, detected_at) \
                     VALUES ('s1',?1,'no_legacy_ids',1)",
                    params![CANONICAL_ID_VERSION],
                )?;
                Ok(())
            })
            .unwrap();

        let client = test_client("http://127.0.0.1:9");
        revalidate_before_ingest(&store, &client, "s1")
            .await
            .unwrap();
        store
            .with_conn("test.bump_routine_synced_at", |conn| {
                conn.execute(
                    "UPDATE track SET synced_at = synced_at + 10000 WHERE server_id = 's1'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        revalidate_before_ingest(&store, &client, "s1")
            .await
            .unwrap();

        assert!(no_legacy_state_is_current(
            &transition_status(&store, "s1").unwrap()
        ));
    }

    #[tokio::test]
    async fn large_canonical_only_catalog_converges_by_bounded_cursor_pages() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn("test.seed_large_canonical_only", |conn| {
                for index in 0..1_025 {
                    conn.execute(
                        "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) \
                         VALUES ('s1',?1,'Canonical','Album',1,'{}')",
                        params![format!("canonical-{index:04}")],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        let client = test_client("http://127.0.0.1:9");

        let first = ensure_transition_with_probe_candidates(&store, &client, "s1", Vec::new())
            .await
            .unwrap();
        assert_eq!(first.state, "retryable");
        assert_eq!(load_probe_cursor(&store, "s1").unwrap(), ProbeCursor::default());

        let second = ensure_transition_with_probe_candidates(&store, &client, "s1", Vec::new())
            .await
            .unwrap();
        assert_eq!(second.state, "retryable");
        assert_eq!(
            load_probe_cursor(&store, "s1").unwrap().after_id.as_deref(),
            Some("canonical-0511")
        );
        let third = ensure_transition_with_probe_candidates(&store, &client, "s1", Vec::new())
            .await
            .unwrap();
        assert_eq!(third.state, "retryable");
        assert_eq!(
            load_probe_cursor(&store, "s1").unwrap().after_id.as_deref(),
            Some("canonical-1023")
        );
        let fourth = ensure_transition_with_probe_candidates(&store, &client, "s1", Vec::new())
            .await
            .unwrap();

        assert_eq!(fourth.state, "no_legacy_ids");
        assert_eq!(load_probe_cursor(&store, "s1").unwrap(), ProbeCursor::default());
    }

    #[test]
    fn version_one_pending_frontend_is_upgraded_and_remains_ackable() {
        let store = LibraryStore::open_in_memory();
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        store
            .with_conn("test.seed_v1_pending", |conn| {
                conn.execute(
                    "INSERT INTO track_offline(server_id,track_id,local_path,cached_at) \
                     VALUES ('s1',?1,'/offline.flac',1)",
                    params![old],
                )?;
                conn.execute(
                    "INSERT INTO server_identity_transition \
                     (server_id, canonical_version, state, detected_at, native_migrated_at) \
                     VALUES ('s1',1,'pending_frontend',1,1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        acknowledge_frontend(&store, "s1").unwrap();

        let status = transition_status(&store, "s1").unwrap();
        assert_eq!(status.canonical_version, CANONICAL_ID_VERSION);
        assert_eq!(status.state, "ready");
        assert_eq!(resolve_remapped_id(&store, "s1", "track", old).unwrap(), new);
    }

    #[test]
    fn version_one_ready_runs_orphan_offline_reconciliation_once() {
        let store = LibraryStore::open_in_memory();
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        store
            .with_conn("test.seed_v1_ready", |conn| {
                conn.execute(
                    "INSERT INTO track_offline(server_id,track_id,local_path,cached_at) \
                     VALUES ('s1',?1,'/offline.flac',1)",
                    params![old],
                )?;
                conn.execute(
                    "INSERT INTO server_identity_transition \
                     (server_id, canonical_version, state, detected_at, native_migrated_at, frontend_acked_at) \
                     VALUES ('s1',1,'ready',1,1,1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        assert_sync_ready(&store, "s1").unwrap();
        assert_sync_ready(&store, "s1").unwrap();

        let status = transition_status(&store, "s1").unwrap();
        assert_eq!(status.canonical_version, CANONICAL_ID_VERSION);
        assert_eq!(status.state, "ready");
        let offline_id = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT track_id FROM track_offline WHERE server_id = 's1'",
                    [],
                    |row| row.get::<_, String>(0),
                )
            })
            .unwrap();
        assert_eq!(offline_id, new);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn version_one_legacy_and_retryable_states_are_reprobed() {
        for stale_state in ["legacy", "retryable"] {
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
            let store = LibraryStore::open_in_memory();
            seed_legacy_track(&store, old);
            store
                .with_conn("test.seed_v1_probe_state", |conn| {
                    conn.execute(
                        "INSERT INTO server_identity_transition \
                         (server_id, canonical_version, state, probe_old_id, probe_new_id, detected_at) \
                         VALUES ('s1',1,?1,?2,?3,1)",
                        params![stale_state, old, new],
                    )?;
                    Ok(())
                })
                .unwrap();

            let status = revalidate_before_ingest(&store, &test_client(&server.uri()), "s1")
                .await
                .unwrap();

            assert_eq!(status.state, "legacy");
            assert_eq!(status.canonical_version, CANONICAL_ID_VERSION);
        }
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
    async fn targeted_not_found_probe_serializes_but_rechecks_cached_legacy_evidence() {
        let server = MockServer::start().await;
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(not_found_response()))
            .expect(2)
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

    #[tokio::test(flavor = "multi_thread")]
    async fn targeted_not_found_reprobes_canonical_after_cached_legacy_result() {
        let server = MockServer::start().await;
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        Mock::given(method("GET"))
            .and(path("/rest/getSong.view"))
            .and(query_param("id", new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(song_response(&new)))
            .expect(1)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        record_state(
            &store,
            "s1",
            "legacy",
            Some(old),
            Some(&new),
            None,
            false,
        )
        .unwrap();

        let outcome = resolve_unexpected_not_found(
            &store,
            &test_client(&server.uri()),
            "s1",
            EntityKind::Track,
            old,
        )
        .await
        .unwrap();

        assert_eq!(outcome, TargetedNotFoundOutcome::TransitionDetected);
        assert_eq!(transition_status(&store, "s1").unwrap().state, "transition_detected");
    }

    #[test]
    fn probe_candidates_page_past_non_transformable_prefix() {
        let store = LibraryStore::open_in_memory();
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        store
            .with_conn("test.seed_probe_candidates", |conn| {
                for index in 0..64 {
                    conn.execute(
                        "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) \
                         VALUES ('s1',?1,'Track','Album',1,'{}')",
                        params![format!("a-{index:02}")],
                    )?;
                }
                conn.execute(
                    "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) \
                     VALUES ('s1',?1,'Track','Album',1,'{}')",
                    params![old],
                )?;
                Ok(())
            })
            .unwrap();

        let candidates = probe_candidates(&store, "s1").unwrap();

        assert_eq!(candidates.candidates.len(), 1);
        assert_eq!(candidates.candidates[0].old_id, old);
        assert_eq!(candidates.candidates[0].new_id, canonical_id(old));
    }

    #[test]
    fn probe_candidates_include_orphan_offline_tracks() {
        let store = LibraryStore::open_in_memory();
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        store
            .with_conn("test.seed_offline_probe_candidate", |conn| {
                conn.execute(
                    "INSERT INTO track_offline(server_id,track_id,local_path,cached_at) \
                     VALUES ('s1',?1,'/music/orphan.flac',1)",
                    params![old],
                )?;
                Ok(())
            })
            .unwrap();

        let candidates = probe_candidates(&store, "s1").unwrap();

        assert_eq!(candidates.candidates.len(), 1);
        assert_eq!(candidates.candidates[0].kind, EntityKind::Track);
        assert_eq!(candidates.candidates[0].old_id, old);
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
    fn migration_rewrites_orphan_offline_track_and_records_alias_history() {
        let store = LibraryStore::open_in_memory();
        let old_track = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new_track = canonical_id(old_track);
        store
            .with_conn("test.seed_orphan_offline", |conn| {
                conn.execute(
                    "INSERT INTO track_offline(server_id,track_id,local_path,cached_at) \
                     VALUES ('s1',?1,'/music/orphan.flac',1)",
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

        store
            .with_read_conn(|conn| {
                let path: String = conn.query_row(
                    "SELECT local_path FROM track_offline \
                     WHERE server_id = 's1' AND track_id = ?1",
                    params![new_track],
                    |row| row.get(0),
                )?;
                assert_eq!(path, "/music/orphan.flac");
                let history: String = conn.query_row(
                    "SELECT new_id FROM track_id_history \
                     WHERE server_id = 's1' AND old_id = ?1",
                    params![old_track],
                    |row| row.get(0),
                )?;
                assert_eq!(history, new_track);
                Ok(())
            })
            .unwrap();
        assert_eq!(
            resolve_remapped_id(&store, "s1", "track", old_track).unwrap(),
            new_track
        );
    }

    #[test]
    fn migration_retargets_orphan_offline_when_canonical_track_already_exists() {
        let store = LibraryStore::open_in_memory();
        let old_track = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new_track = canonical_id(old_track);
        store
            .with_conn("test.seed_canonical_track_and_orphan_offline", |conn| {
                conn.execute(
                    "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) \
                     VALUES ('s1',?1,'Canonical','Album',1,'{}')",
                    params![new_track],
                )?;
                conn.execute(
                    "INSERT INTO track_offline(server_id,track_id,local_path,cached_at) \
                     VALUES ('s1',?1,'/music/orphan.flac',1)",
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

        store
            .with_read_conn(|conn| {
                let ids: Vec<String> = conn
                    .prepare("SELECT id FROM track WHERE server_id = 's1'")?
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(ids, vec![new_track.clone()]);
                let offline_id: String = conn.query_row(
                    "SELECT track_id FROM track_offline WHERE server_id = 's1'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(offline_id, new_track);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn migration_blocks_when_old_and_canonical_track_rows_both_exist() {
        let store = LibraryStore::open_in_memory();
        let old_track = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new_track = canonical_id(old_track);
        store
            .with_conn("test.seed_track_pk_collision", |conn| {
                for (id, title) in [(old_track, "Legacy"), (new_track.as_str(), "Canonical")] {
                    conn.execute(
                        "INSERT INTO track(server_id,id,title,album,synced_at,raw_json) \
                         VALUES ('s1',?1,?2,'Album',1,'{}')",
                        params![id, title],
                    )?;
                }
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
        let count = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM track WHERE server_id = 's1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap();
        assert_eq!(count, 2);
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
