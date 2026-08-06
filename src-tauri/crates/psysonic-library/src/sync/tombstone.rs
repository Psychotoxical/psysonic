//! C4 — `TombstoneReconciler` (spec §6.7).
//!
//! Streams a chunk of local track ids, hits `getSong` per id, and
//! marks `track.deleted = 1` for every `SubsonicError::NotFound`
//! (error code 70). Designed for two callers:
//!
//! - **Mode A (manual integrity check):** Settings → "Verify library
//!   integrity" loops `reconcile_chunk(N)` until it returns
//!   `checked == 0`.
//! - **Mode B (auto, threshold-triggered):** the delta scheduler
//!   tests `should_auto_reconcile` against the count drop, then loops
//!   `reconcile_chunk(budget)` once per delta tick until the gap
//!   closes.
//!
//! Streaming so memory stays bounded at 500k: `LIMIT N ORDER BY
//! synced_at ASC` picks the next chunk; PR-3c keeps the loop entirely
//! caller-driven so cancellation is checked between chunks.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use psysonic_integration::subsonic::{SubsonicClient, SubsonicError};

use super::backoff::{jitter_salt, with_jitter, Backoff};
use super::error::SyncError;
use crate::navidrome_identity::{
    resolve_unexpected_not_found, EntityKind, TargetedNotFoundOutcome,
};
use crate::repos::TrackRepository;
use crate::store::LibraryStore;

const MAX_ATTEMPTS_PER_BATCH: u32 = 5;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TombstoneReport {
    pub checked: u32,
    pub deleted: u32,
}

pub struct TombstoneReconciler<'a> {
    store: &'a LibraryStore,
    subsonic: &'a SubsonicClient,
    server_id: String,
    library_scope: String,
    cancel: Option<Arc<std::sync::atomic::AtomicBool>>,
    sleep_enabled: bool,
}

impl<'a> TombstoneReconciler<'a> {
    pub fn new(
        store: &'a LibraryStore,
        subsonic: &'a SubsonicClient,
        server_id: impl Into<String>,
    ) -> Self {
        Self {
            store,
            subsonic,
            server_id: server_id.into(),
            library_scope: String::new(),
            cancel: None,
            sleep_enabled: true,
        }
    }

    pub fn with_library_scope(mut self, library_scope: impl Into<String>) -> Self {
        self.library_scope = library_scope.into();
        self
    }

    pub fn with_cancellation(mut self, flag: Arc<std::sync::atomic::AtomicBool>) -> Self {
        self.cancel = Some(flag);
        self
    }

    pub fn with_sleep_disabled(mut self) -> Self {
        self.sleep_enabled = false;
        self
    }

    /// Process up to `budget` not-yet-checked tracks. Returns counts
    /// for this call only — caller loops until `checked == 0` to
    /// complete a Mode A pass, or stops at any budget for Mode B
    /// sampled passes. Order: oldest `synced_at` first so the most
    /// stale rows get re-validated soonest.
    pub async fn reconcile_chunk(&self, budget: u32) -> Result<TombstoneReport, SyncError> {
        if budget == 0 {
            return Ok(TombstoneReport::default());
        }
        let ids = self.next_candidates(budget)?;
        self.reconcile_ids(ids).await
    }

    /// Complete one bounded full pass over the rows that were live when the
    /// pass began. The captured max id and keyset cursor guarantee termination
    /// even though successful probes refresh `synced_at`.
    pub async fn reconcile_full_pass(&self, batch_size: u32) -> Result<TombstoneReport, SyncError> {
        if batch_size == 0 {
            return Ok(TombstoneReport::default());
        }
        let Some(cutoff_id) = self.capture_cutoff_id()? else {
            return Ok(TombstoneReport::default());
        };
        let mut report = TombstoneReport::default();
        let mut after_id: Option<String> = None;
        loop {
            let ids = self.next_candidates_after(after_id.as_deref(), &cutoff_id, batch_size)?;
            if ids.is_empty() {
                break;
            }
            after_id = ids.last().cloned();
            let chunk = self.reconcile_ids(ids).await?;
            report.checked = report.checked.saturating_add(chunk.checked);
            report.deleted = report.deleted.saturating_add(chunk.deleted);
        }
        Ok(report)
    }

    async fn reconcile_ids(&self, ids: Vec<String>) -> Result<TombstoneReport, SyncError> {
        let mut report = TombstoneReport::default();
        let mut alive_ids = Vec::new();
        let mut deleted_ids = Vec::new();
        for id in ids {
            self.check_cancellation()?;
            report.checked = report.checked.saturating_add(1);
            let outcome = retry_with_backoff(
                self,
                || self.subsonic.get_song(&id),
                |e: SubsonicError| -> SyncError { e.into() },
            )
            .await;
            match outcome {
                Ok(_) => {
                    alive_ids.push(id);
                }
                Err(SyncError::NotFound) => {
                    match resolve_unexpected_not_found(
                        self.store,
                        self.subsonic,
                        &self.server_id,
                        EntityKind::Track,
                        &id,
                    )
                    .await
                    .map_err(SyncError::IdentityTransition)?
                    {
                        TargetedNotFoundOutcome::ConfirmedMissing => {
                            deleted_ids.push(id);
                            report.deleted = report.deleted.saturating_add(1);
                        }
                        TargetedNotFoundOutcome::TransitionDetected => {
                            return Err(SyncError::IdentityTransition(
                                "canonical-ID transition detected while verifying a track"
                                    .to_string(),
                            ));
                        }
                    }
                }
                Err(other) => return Err(other),
            }
        }
        TrackRepository::new(self.store)
            .apply_tombstone_results(
                &self.server_id,
                &self.library_scope,
                &alive_ids,
                &deleted_ids,
            )
            .map_err(SyncError::Storage)?;
        Ok(report)
    }

    fn check_cancellation(&self) -> Result<(), SyncError> {
        if let Some(flag) = &self.cancel {
            if flag.load(Ordering::SeqCst) {
                return Err(SyncError::Cancelled);
            }
        }
        Ok(())
    }

    fn next_candidates(&self, budget: u32) -> Result<Vec<String>, SyncError> {
        self.store
            .with_conn("tombstone.next_candidates", |c| {
                if self.library_scope.is_empty() {
                    let mut stmt = c.prepare(
                        "SELECT id FROM track \
                         WHERE server_id = ?1 AND deleted = 0 \
                         ORDER BY synced_at ASC, id ASC LIMIT ?2",
                    )?;
                    let rows = stmt
                        .query_map(rusqlite::params![self.server_id, budget as i64], |r| {
                            r.get::<_, String>(0)
                        })?
                        .collect();
                    rows
                } else {
                    let mut stmt = c.prepare(
                        "SELECT id FROM track \
                         WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0 \
                         ORDER BY synced_at ASC, id ASC LIMIT ?3",
                    )?;
                    let rows = stmt
                        .query_map(
                            rusqlite::params![self.server_id, self.library_scope, budget as i64],
                            |r| r.get::<_, String>(0),
                        )?
                        .collect();
                    rows
                }
            })
            .map_err(SyncError::Storage)
    }

    fn capture_cutoff_id(&self) -> Result<Option<String>, SyncError> {
        self.store
            .with_conn("tombstone.capture_cutoff", |c| {
                if self.library_scope.is_empty() {
                    c.query_row(
                        "SELECT MAX(id) FROM track WHERE server_id = ?1 AND deleted = 0",
                        rusqlite::params![self.server_id],
                        |row| row.get(0),
                    )
                } else {
                    c.query_row(
                        "SELECT MAX(id) FROM track \
                         WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0",
                        rusqlite::params![self.server_id, self.library_scope],
                        |row| row.get(0),
                    )
                }
            })
            .map_err(SyncError::Storage)
    }

    fn next_candidates_after(
        &self,
        after_id: Option<&str>,
        cutoff_id: &str,
        budget: u32,
    ) -> Result<Vec<String>, SyncError> {
        self.store
            .with_conn("tombstone.next_candidates_after", |c| {
                if self.library_scope.is_empty() {
                    let mut statement = c.prepare(
                        "SELECT id FROM track \
                         WHERE server_id = ?1 AND deleted = 0 AND id <= ?2 \
                           AND (?3 IS NULL OR id > ?3) \
                         ORDER BY id ASC LIMIT ?4",
                    )?;
                    let rows = statement
                        .query_map(
                            rusqlite::params![self.server_id, cutoff_id, after_id, budget as i64],
                            |row| row.get::<_, String>(0),
                        )?
                        .collect();
                    rows
                } else {
                    let mut statement = c.prepare(
                        "SELECT id FROM track \
                         WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0 \
                           AND id <= ?3 AND (?4 IS NULL OR id > ?4) \
                         ORDER BY id ASC LIMIT ?5",
                    )?;
                    let rows = statement
                        .query_map(
                            rusqlite::params![
                                self.server_id,
                                self.library_scope,
                                cutoff_id,
                                after_id,
                                budget as i64
                            ],
                            |row| row.get::<_, String>(0),
                        )?
                        .collect();
                    rows
                }
            })
            .map_err(SyncError::Storage)
    }

    async fn sleep(&self, d: Duration) {
        if self.sleep_enabled && !d.is_zero() {
            tokio::time::sleep(d).await;
        }
    }
}

/// §6.7 Mode B threshold check — returns `true` when the local /
/// server count gap exceeds the configured percentage. `server_count
/// == 0` is treated as "no signal" → `false` (no spurious reconcile
/// on a fresh server response).
pub fn should_auto_reconcile(local_count: u32, server_count: u32, threshold_pct: u32) -> bool {
    if server_count == 0 {
        return false;
    }
    let gap = local_count.saturating_sub(server_count);
    let ratio_x100 = gap.saturating_mul(100) / server_count;
    ratio_x100 > threshold_pct
}

/// Scope-aware Mode B threshold check. `getScanStatus.count` is server-wide,
/// so scoped runs use the explicit full Verify pass instead of count mismatch.
pub fn should_auto_reconcile_scope(
    library_scope: &str,
    local_count: u32,
    server_count: u32,
    threshold_pct: u32,
) -> bool {
    library_scope.is_empty() && should_auto_reconcile(local_count, server_count, threshold_pct)
}

async fn retry_with_backoff<'a, F, FFut, T, E>(
    reconciler: &TombstoneReconciler<'a>,
    mut build: F,
    map_err: impl Fn(E) -> SyncError,
) -> Result<T, SyncError>
where
    F: FnMut() -> FFut,
    FFut: std::future::Future<Output = Result<T, E>>,
{
    let mut backoff = Backoff::default();
    let mut attempt = 0u32;
    loop {
        reconciler.check_cancellation()?;
        attempt += 1;
        match build().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                let mapped = map_err(e);
                if !is_retryable(&mapped) || attempt >= MAX_ATTEMPTS_PER_BATCH {
                    return Err(mapped);
                }
                let delay = backoff.next_delay();
                let jittered = with_jitter(delay, jitter_salt(attempt));
                reconciler.sleep(jittered).await;
            }
        }
    }
}

fn is_retryable(e: &SyncError) -> bool {
    matches!(e, SyncError::Transport(_) | SyncError::Navidrome(_))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::navidrome_identity::{canonical_id, transition_status};
    use crate::repos::{TrackRepository, TrackRow};
    use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
    use serde_json::json;
    use wiremock::matchers::{method as wm_method, path as wm_path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_subsonic(uri: &str) -> SubsonicClient {
        SubsonicClient::with_static_credentials(
            uri,
            SubsonicCredentials::with_static("user", "tok", "salt"),
            reqwest::Client::new(),
        )
    }

    fn seed_track(store: &LibraryStore, id: &str, synced_at: i64) {
        seed_scoped_track(store, id, synced_at, None, None);
    }

    fn seed_scoped_track(
        store: &LibraryStore,
        id: &str,
        synced_at: i64,
        library_id: Option<&str>,
        album_id: Option<&str>,
    ) {
        TrackRepository::new(store)
            .upsert_batch(&[TrackRow {
                server_id: "s1".into(),
                id: id.into(),
                title: id.into(),
                title_sort: None,
                artist: None,
                artist_id: None,
                album: String::new(),
                album_id: album_id.map(str::to_string),
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
                library_id: library_id.map(str::to_string),
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
                synced_at,
                raw_json: "{}".into(),
            }])
            .unwrap();
    }

    // ── should_auto_reconcile threshold predicate ─────────────────────

    #[test]
    fn threshold_fires_when_local_outpaces_server_above_pct() {
        // 110 local vs 100 server → 10% gap > 5% threshold.
        assert!(should_auto_reconcile(110, 100, 5));
    }

    #[test]
    fn threshold_stays_silent_within_tolerance() {
        // 102 local vs 100 server → 2% gap, threshold 5%.
        assert!(!should_auto_reconcile(102, 100, 5));
    }

    #[test]
    fn threshold_silent_when_local_is_below_or_equal_server() {
        assert!(!should_auto_reconcile(100, 100, 0));
        assert!(!should_auto_reconcile(50, 100, 5));
    }

    #[test]
    fn threshold_silent_when_server_count_is_zero() {
        // No signal — never reconcile on a server that's still scanning.
        assert!(!should_auto_reconcile(1000, 0, 5));
    }

    #[test]
    fn threshold_stays_silent_for_scoped_counts() {
        assert!(!should_auto_reconcile_scope("music-folder", 110, 100, 5));
    }

    // ── reconcile_chunk marks deleted on code 70 ─────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn reconcile_chunk_marks_deleted_for_code_70() {
        let server = MockServer::start().await;
        // tr_a → still present, tr_b → 404 via code 70.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .and(query_param("id", "tr_a"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "song": { "id": "tr_a", "title": "Still here" }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .and(query_param("id", "tr_b"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "failed",
                    "error": { "code": 70, "message": "Song not found" }
                }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        seed_track(&store, "tr_a", 1);
        seed_track(&store, "tr_b", 2);

        let subsonic = test_subsonic(&server.uri());
        let report = TombstoneReconciler::new(&store, &subsonic, "s1")
            .with_sleep_disabled()
            .reconcile_chunk(10)
            .await
            .unwrap();

        assert_eq!(report.checked, 2);
        assert_eq!(report.deleted, 1);

        // tr_b is marked deleted; tr_a stays live but its synced_at is
        // refreshed (so it doesn't get re-picked immediately).
        let (a_deleted, b_deleted): (i64, i64) = store
            .with_conn("misc", |c| {
                let a: i64 = c.query_row("SELECT deleted FROM track WHERE id='tr_a'", [], |r| {
                    r.get(0)
                })?;
                let b: i64 = c.query_row("SELECT deleted FROM track WHERE id='tr_b'", [], |r| {
                    r.get(0)
                })?;
                Ok((a, b))
            })
            .unwrap();
        assert_eq!(a_deleted, 0);
        assert_eq!(b_deleted, 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn canonical_fallback_aborts_before_tombstoning_a_legacy_track() {
        let server = MockServer::start().await;
        let old = "e3b7fc2ae9447bbec37a13bf916e3cf6";
        let new = canonical_id(old);
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .and(query_param("id", old))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "failed",
                    "error": { "code": 70, "message": "Song not found" }
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .and(query_param("id", new.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "song": { "id": new, "title": "Still here" }
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        seed_track(&store, old, 1);

        let error = TombstoneReconciler::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .reconcile_chunk(10)
            .await
            .unwrap_err();

        assert!(matches!(error, SyncError::IdentityTransition(_)));
        let deleted: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT deleted FROM track WHERE server_id = 's1' AND id = ?1",
                    rusqlite::params![old],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(deleted, 0);
        assert_eq!(
            transition_status(&store, "s1").unwrap().state,
            "transition_detected"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn legacy_track_is_tombstoned_when_both_old_and_canonical_ids_are_missing() {
        let server = MockServer::start().await;
        let old = "00112233445566778899aabbccddeeff";
        let new = canonical_id(old);
        for id in [old, new.as_str()] {
            Mock::given(wm_method("GET"))
                .and(wm_path("/rest/getSong.view"))
                .and(query_param("id", id))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "subsonic-response": {
                        "status": "failed",
                        "error": { "code": 70, "message": "Song not found" }
                    }
                })))
                .expect(1)
                .mount(&server)
                .await;
        }
        let store = LibraryStore::open_in_memory();
        seed_track(&store, old, 1);

        let report = TombstoneReconciler::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .reconcile_chunk(10)
            .await
            .unwrap();

        assert_eq!(report.deleted, 1);
        let deleted: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT deleted FROM track WHERE server_id = 's1' AND id = ?1",
                    rusqlite::params![old],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(deleted, 1);
    }

    // ── reconcile_chunk respects budget and ordering ─────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn reconcile_chunk_processes_oldest_first_up_to_budget() {
        let server = MockServer::start().await;
        // Any id → ok envelope.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "song": { "id": "any", "title": "t" }
                }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        // Seed three tracks with distinct synced_at values; oldest first.
        seed_track(&store, "tr_oldest", 100);
        seed_track(&store, "tr_middle", 200);
        seed_track(&store, "tr_newest", 300);

        let subsonic = test_subsonic(&server.uri());
        let report = TombstoneReconciler::new(&store, &subsonic, "s1")
            .with_sleep_disabled()
            .reconcile_chunk(2)
            .await
            .unwrap();
        assert_eq!(report.checked, 2);

        // After the chunk: the two checked rows have a refreshed
        // synced_at; the un-checked tr_newest still sits at 300.
        let untouched: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT synced_at FROM track WHERE id='tr_newest'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(
            untouched, 300,
            "tr_newest must not be probed within budget=2"
        );
    }

    // ── reconcile_chunk: empty store ───────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn reconcile_chunk_returns_zero_counts_on_empty_store() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        let report = TombstoneReconciler::new(&store, &subsonic, "s1")
            .with_sleep_disabled()
            .reconcile_chunk(50)
            .await
            .unwrap();
        assert_eq!(report.checked, 0);
        assert_eq!(report.deleted, 0);
    }

    // ── reconcile_chunk: cancellation ─────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn reconcile_chunk_returns_cancelled_when_flag_tripped() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "tr_x", 1);

        let flag = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let subsonic = test_subsonic(&server.uri());
        let err = TombstoneReconciler::new(&store, &subsonic, "s1")
            .with_cancellation(flag)
            .with_sleep_disabled()
            .reconcile_chunk(10)
            .await
            .unwrap_err();
        assert!(matches!(err, SyncError::Cancelled));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn full_pass_checks_more_than_one_budget_and_stays_in_scope() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "song": { "id": "present", "title": "Present" }
                }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let mut rows = Vec::new();
        for i in 0..205 {
            let mut row = TrackRow {
                server_id: "s1".into(),
                id: format!("a-{i:03}"),
                title: format!("A {i}"),
                title_sort: None,
                artist: None,
                artist_id: None,
                album: String::new(),
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
                library_id: Some("lib-a".into()),
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
            };
            rows.push(row.clone());
            if i < 5 {
                row.id = format!("z-{i:03}");
                row.library_id = Some("lib-b".into());
                rows.push(row);
            }
        }
        TrackRepository::new(&store).upsert_batch(&rows).unwrap();

        let report = TombstoneReconciler::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_library_scope("lib-a")
            .with_sleep_disabled()
            .reconcile_full_pass(200)
            .await
            .unwrap();
        assert_eq!(report.checked, 205);
        assert_eq!(report.deleted, 0);

        let untouched: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM track \
                     WHERE library_id = 'lib-b' AND synced_at = 1 AND deleted = 0",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(untouched, 5);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tombstone_deletion_refreshes_projection_and_identity() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .and(query_param("id", "tr_gone"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "failed",
                    "error": { "code": 70, "message": "Song not found" }
                }
            })))
            .mount(&server)
            .await;
        let store = LibraryStore::open_in_memory();
        seed_scoped_track(&store, "tr_gone", 1, Some("lib-a"), Some("album-a"));
        crate::identity::rebuild_cluster_keys(&store, None).unwrap();

        TombstoneReconciler::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_library_scope("lib-a")
            .with_sleep_disabled()
            .reconcile_chunk(10)
            .await
            .unwrap();
        crate::identity::ensure_cluster_keys_built(&store, "s1").unwrap();

        let (projection, identity): (i64, i64) = store
            .with_read_conn(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT COUNT(*) FROM album_browse_projection \
                         WHERE server_id = 's1' AND library_id = 'lib-a'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM cluster.track_cluster_key \
                         WHERE server_id = 's1' AND track_id = 'tr_gone'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(projection, 0);
        assert_eq!(identity, 0);
    }
}
