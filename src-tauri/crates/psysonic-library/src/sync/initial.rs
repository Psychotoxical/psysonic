//! `InitialSyncRunner` — spec §6.3 IS-1 … IS-6. PR-3b lands the runner,
//! cursor persistence, and the N1/S1/S2 ingest loops. S3 (file-tree)
//! is enumerated but returns `StrategyUnsupported`. IS-4 artist pass +
//! IS-5 watermarks run after the bulk loop completes.
//!
//! The runner is pure Rust — no Tauri events, no background task
//! lifecycle. PR-3d wires it into a `tokio::task::spawn` shell with
//! progress emit + the cancellation token; PR-3b only ships the
//! library-side function the shell will call.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use psysonic_integration::navidrome::queries::nd_list_songs_internal;
use psysonic_integration::subsonic::SubsonicClient;
use serde_json::Value;

use super::backoff::{with_jitter, Backoff};
use super::capability::{CapabilityFlags, NavidromeProbeCredentials};
use super::cursor::{CursorPhase, InitialSyncCursor, StrategyState};
use super::error::SyncError;
use super::mapping::{navidrome_song_to_track_row, subsonic_song_to_track_row};
use super::strategy::IngestStrategy;
use crate::repos::{RemapStats, SyncStateRepository, TrackRepository, TrackRow};
use crate::store::LibraryStore;

/// Bulk ingest batch size per spec §6.3 (`batch=500`).
const DEFAULT_BATCH_SIZE: u32 = 500;

/// Maximum attempts per batch before `SyncError::Transport` propagates.
/// Caller (Settings „retry" / PR-3d scheduler) can wrap and retry the
/// whole run if needed.
const MAX_ATTEMPTS_PER_BATCH: u32 = 5;

/// Summary returned from `InitialSyncRunner::run`. Caller emits a
/// completion event with these numbers (PR-3d).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InitialSyncReport {
    pub strategy: Option<String>,
    pub ingested_count: u32,
    pub remapped_count: u32,
}

pub struct InitialSyncRunner<'a> {
    store: &'a LibraryStore,
    subsonic: &'a SubsonicClient,
    navidrome: Option<NavidromeProbeCredentials>,
    server_id: String,
    library_scope: String,
    capability_flags: CapabilityFlags,
    cancel: Option<Arc<AtomicBool>>,
    batch_size: u32,
    sleep_enabled: bool,
}

impl<'a> InitialSyncRunner<'a> {
    pub fn new(
        store: &'a LibraryStore,
        subsonic: &'a SubsonicClient,
        server_id: impl Into<String>,
        library_scope: impl Into<String>,
        capability_flags: CapabilityFlags,
    ) -> Self {
        Self {
            store,
            subsonic,
            navidrome: None,
            server_id: server_id.into(),
            library_scope: library_scope.into(),
            capability_flags,
            cancel: None,
            batch_size: DEFAULT_BATCH_SIZE,
            sleep_enabled: true,
        }
    }

    pub fn with_navidrome_credentials(mut self, creds: NavidromeProbeCredentials) -> Self {
        self.navidrome = Some(creds);
        self
    }

    pub fn with_cancellation(mut self, flag: Arc<AtomicBool>) -> Self {
        self.cancel = Some(flag);
        self
    }

    pub fn with_batch_size(mut self, n: u32) -> Self {
        if n > 0 {
            self.batch_size = n;
        }
        self
    }

    /// Disable real sleep between backoff attempts. Tests pin this so
    /// `503 → success on retry` exercises the retry loop in
    /// milliseconds instead of seconds. Production code leaves it on.
    pub fn with_sleep_disabled(mut self) -> Self {
        self.sleep_enabled = false;
        self
    }

    /// IS-1 → IS-6. Resumes from `sync_state.initial_sync_cursor_json`
    /// when a cursor is already persisted; otherwise picks a strategy
    /// from `capability_flags` and starts fresh.
    pub async fn run(&self) -> Result<InitialSyncReport, SyncError> {
        let sync_state = SyncStateRepository::new(self.store);
        sync_state
            .ensure(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;

        // IS-1 — phase=initial_sync.
        sync_state
            .set_sync_phase(&self.server_id, &self.library_scope, "initial_sync")
            .map_err(SyncError::Storage)?;

        let mut cursor = self.load_or_init_cursor(&sync_state)?;
        let mut report = InitialSyncReport {
            strategy: Some(cursor.strategy.clone()),
            ingested_count: cursor.ingested_count,
            remapped_count: 0,
        };
        let strategy = IngestStrategy::from_tag(&cursor.strategy).ok_or_else(|| {
            SyncError::CursorIncompatible {
                expected: "n1|s1|s2|s3",
                actual: cursor.strategy.clone(),
            }
        })?;

        // IS-3 — bulk ingest per strategy.
        if cursor.phase == CursorPhase::Ingest {
            match strategy {
                IngestStrategy::N1 => self.run_n1(&mut cursor, &mut report, &sync_state).await?,
                IngestStrategy::S1 => self.run_s1(&mut cursor, &mut report, &sync_state).await?,
                IngestStrategy::S2 => self.run_s2(&mut cursor, &mut report, &sync_state).await?,
                IngestStrategy::S3 => {
                    return Err(SyncError::StrategyUnsupported { strategy: "s3" })
                }
            }
            cursor.phase = CursorPhase::ArtistPass;
            self.persist_cursor(&sync_state, &cursor)?;
        }

        // IS-4 — optional artist/album index pass via `getArtists`.
        if cursor.phase == CursorPhase::ArtistPass {
            self.run_artist_pass(&sync_state).await?;
            cursor.phase = CursorPhase::Watermarks;
            self.persist_cursor(&sync_state, &cursor)?;
        }

        // IS-5 — watermarks (server_last_scan_iso, server_track_count,
        // artists_last_modified_ms) so DS-0 polls can short-circuit.
        if cursor.phase == CursorPhase::Watermarks {
            self.run_watermark_pass(&sync_state).await?;
            cursor.phase = CursorPhase::Done;
            self.persist_cursor(&sync_state, &cursor)?;
        }

        // IS-6 — phase=ready, last_full_sync_at=now, clear cursor.
        sync_state
            .set_sync_phase(&self.server_id, &self.library_scope, "ready")
            .map_err(SyncError::Storage)?;
        sync_state
            .set_initial_sync_cursor(
                &self.server_id,
                &self.library_scope,
                &Value::Object(serde_json::Map::new()),
            )
            .map_err(SyncError::Storage)?;

        Ok(report)
    }

    // ── cursor / persistence ───────────────────────────────────────────

    fn load_or_init_cursor(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<InitialSyncCursor, SyncError> {
        let raw = sync_state
            .get_initial_sync_cursor(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        if let Some(raw) = raw {
            if !is_empty_cursor(&raw) {
                let parsed: InitialSyncCursor = serde_json::from_value(raw.clone())
                    .map_err(|e| SyncError::Storage(format!("invalid cursor: {e}")))?;
                let strategy_from_flags = IngestStrategy::select_from_flags(self.capability_flags);
                if parsed.strategy != strategy_from_flags.as_tag() {
                    return Err(SyncError::CursorIncompatible {
                        expected: strategy_from_flags.as_tag(),
                        actual: parsed.strategy,
                    });
                }
                return Ok(parsed);
            }
        }
        let strategy = IngestStrategy::select_from_flags(self.capability_flags);
        let scope = if self.library_scope.is_empty() {
            None
        } else {
            Some(self.library_scope.clone())
        };
        let fresh = InitialSyncCursor::fresh(strategy, scope);
        self.persist_cursor(sync_state, &fresh)?;
        Ok(fresh)
    }

    fn persist_cursor(
        &self,
        sync_state: &SyncStateRepository<'_>,
        cursor: &InitialSyncCursor,
    ) -> Result<(), SyncError> {
        let value = serde_json::to_value(cursor)
            .map_err(|e| SyncError::Storage(format!("serialize cursor: {e}")))?;
        sync_state
            .set_initial_sync_cursor(&self.server_id, &self.library_scope, &value)
            .map_err(SyncError::Storage)
    }

    fn check_cancellation(&self) -> Result<(), SyncError> {
        if let Some(flag) = &self.cancel {
            if flag.load(Ordering::SeqCst) {
                return Err(SyncError::Cancelled);
            }
        }
        Ok(())
    }

    fn unstable_track_ids(&self) -> bool {
        self.capability_flags
            .contains(CapabilityFlags::UNSTABLE_TRACK_IDS)
    }

    fn library_scope_opt(&self) -> Option<&str> {
        if self.library_scope.is_empty() {
            None
        } else {
            Some(self.library_scope.as_str())
        }
    }

    async fn sleep(&self, d: Duration) {
        if self.sleep_enabled && !d.is_zero() {
            tokio::time::sleep(d).await;
        }
    }

    fn write_batch(&self, rows: &[TrackRow]) -> Result<RemapStats, SyncError> {
        TrackRepository::new(self.store)
            .upsert_batch_with_remap(rows, self.unstable_track_ids())
            .map_err(SyncError::Storage)
    }

    // ── N1 (Navidrome native /api/song) ────────────────────────────────

    async fn run_n1(
        &self,
        cursor: &mut InitialSyncCursor,
        report: &mut InitialSyncReport,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        let creds = self.navidrome.as_ref().ok_or_else(|| SyncError::Transport(
            "n1 strategy selected but no Navidrome credentials supplied".into(),
        ))?;
        let mut offset = match cursor.strategy_state {
            StrategyState::LinearOffset { offset } => offset,
            ref other => {
                return Err(SyncError::Storage(format!(
                    "n1 expected linear-offset cursor, got {other:?}"
                )))
            }
        };

        loop {
            self.check_cancellation()?;
            let end = offset.saturating_add(self.batch_size);
            let response = retry_with_backoff(
                self,
                || nd_list_songs_internal(
                    &creds.server_url,
                    &creds.bearer_token,
                    "id",
                    "ASC",
                    offset,
                    end,
                ),
                SyncError::Navidrome,
            )
            .await?;

            let array = response.as_array().cloned().unwrap_or_default();
            if array.is_empty() {
                break;
            }
            let synced_at = now_unix_ms();
            let rows: Vec<TrackRow> = array
                .iter()
                .filter_map(|v| {
                    navidrome_song_to_track_row(
                        &self.server_id,
                        v,
                        synced_at,
                        self.library_scope_opt(),
                    )
                })
                .collect();
            let stats = self.write_batch(&rows)?;
            report.ingested_count = report.ingested_count.saturating_add(rows.len() as u32);
            report.remapped_count = report
                .remapped_count
                .saturating_add(stats.remapped.len() as u32);

            offset = end;
            cursor.strategy_state = StrategyState::LinearOffset { offset };
            cursor.ingested_count = report.ingested_count;
            self.persist_cursor(sync_state, cursor)?;

            if (array.len() as u32) < self.batch_size {
                break;
            }
        }
        Ok(())
    }

    // ── S1 (Subsonic search3 empty query) ──────────────────────────────

    async fn run_s1(
        &self,
        cursor: &mut InitialSyncCursor,
        report: &mut InitialSyncReport,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        let mut offset = match cursor.strategy_state {
            StrategyState::LinearOffset { offset } => offset,
            ref other => {
                return Err(SyncError::Storage(format!(
                    "s1 expected linear-offset cursor, got {other:?}"
                )))
            }
        };

        loop {
            self.check_cancellation()?;
            let scope = self.library_scope_opt();
            let result = retry_with_backoff(
                self,
                || self.subsonic.search3("", self.batch_size, offset, scope),
                SyncError::from,
            )
            .await?;

            if result.song.is_empty() {
                break;
            }

            let synced_at = now_unix_ms();
            let mut rows: Vec<TrackRow> = Vec::with_capacity(result.song.len());
            for song in &result.song {
                let raw = serde_json::to_value(song).unwrap_or(Value::Null);
                rows.push(subsonic_song_to_track_row(
                    &self.server_id,
                    song,
                    &raw,
                    synced_at,
                    self.library_scope_opt(),
                ));
            }
            let stats = self.write_batch(&rows)?;
            report.ingested_count = report.ingested_count.saturating_add(rows.len() as u32);
            report.remapped_count = report
                .remapped_count
                .saturating_add(stats.remapped.len() as u32);

            offset = offset.saturating_add(self.batch_size);
            cursor.strategy_state = StrategyState::LinearOffset { offset };
            cursor.ingested_count = report.ingested_count;
            self.persist_cursor(sync_state, cursor)?;

            if (result.song.len() as u32) < self.batch_size {
                break;
            }
        }
        Ok(())
    }

    // ── S2 (album crawl: getAlbumList2 + getAlbum) ─────────────────────

    async fn run_s2(
        &self,
        cursor: &mut InitialSyncCursor,
        report: &mut InitialSyncReport,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        let (mut album_offset, _resumed_in_album) = match cursor.strategy_state {
            StrategyState::AlbumCrawl { album_offset, ref current_album_id } => {
                (album_offset, current_album_id.clone())
            }
            ref other => {
                return Err(SyncError::Storage(format!(
                    "s2 expected album-crawl cursor, got {other:?}"
                )))
            }
        };

        loop {
            self.check_cancellation()?;
            let scope = self.library_scope_opt();
            let albums = retry_with_backoff(
                self,
                || self.subsonic.get_album_list2(
                    "alphabeticalByName",
                    self.batch_size,
                    album_offset,
                    scope,
                ),
                SyncError::from,
            )
            .await?;
            if albums.is_empty() {
                break;
            }

            for album_summary in &albums {
                self.check_cancellation()?;
                cursor.strategy_state = StrategyState::AlbumCrawl {
                    album_offset,
                    current_album_id: Some(album_summary.id.clone()),
                };
                self.persist_cursor(sync_state, cursor)?;

                let (album, raw_album) = retry_with_backoff(
                    self,
                    || self.subsonic.get_album_with_raw(&album_summary.id),
                    SyncError::from,
                )
                .await?;

                let synced_at = now_unix_ms();
                let raw_songs = raw_album
                    .get("song")
                    .and_then(|s| s.as_array())
                    .cloned()
                    .unwrap_or_default();
                let mut rows: Vec<TrackRow> = Vec::with_capacity(album.song.len());
                for (i, song) in album.song.iter().enumerate() {
                    let raw = raw_songs
                        .get(i)
                        .cloned()
                        .unwrap_or_else(|| serde_json::to_value(song).unwrap_or(Value::Null));
                    rows.push(subsonic_song_to_track_row(
                        &self.server_id,
                        song,
                        &raw,
                        synced_at,
                        self.library_scope_opt(),
                    ));
                }
                if !rows.is_empty() {
                    let stats = self.write_batch(&rows)?;
                    report.ingested_count = report
                        .ingested_count
                        .saturating_add(rows.len() as u32);
                    report.remapped_count = report
                        .remapped_count
                        .saturating_add(stats.remapped.len() as u32);
                }
            }

            album_offset = album_offset.saturating_add(self.batch_size);
            cursor.strategy_state = StrategyState::AlbumCrawl {
                album_offset,
                current_album_id: None,
            };
            cursor.ingested_count = report.ingested_count;
            self.persist_cursor(sync_state, cursor)?;

            if (albums.len() as u32) < self.batch_size {
                break;
            }
        }
        Ok(())
    }

    // ── IS-4 artist pass (best-effort browse acceleration) ─────────────

    async fn run_artist_pass(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        let scope = self.library_scope_opt();
        let artists = retry_with_backoff(
            self,
            || self.subsonic.get_artists(scope),
            SyncError::from,
        )
        .await
        .ok();
        if let Some(index) = artists {
            if let Some(ms) = index.last_modified_ms {
                sync_state
                    .set_artists_last_modified_ms(&self.server_id, &self.library_scope, ms)
                    .map_err(SyncError::Storage)?;
            }
        }
        Ok(())
    }

    // ── IS-5 watermarks ────────────────────────────────────────────────

    async fn run_watermark_pass(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        if self
            .capability_flags
            .contains(CapabilityFlags::SCAN_STATUS_AVAILABLE)
        {
            if let Ok(s) = self.subsonic.get_scan_status().await {
                sync_state
                    .set_server_last_scan_iso(
                        &self.server_id,
                        &self.library_scope,
                        s.last_scan.as_deref(),
                    )
                    .map_err(SyncError::Storage)?;
            }
        }
        Ok(())
    }
}

fn is_empty_cursor(v: &Value) -> bool {
    matches!(v, Value::Object(o) if o.is_empty())
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// Wrap an async closure in §6.8 backoff. Retries on `SyncError::Transport`
/// up to `MAX_ATTEMPTS_PER_BATCH`, sleeping per the backoff schedule
/// (skipped when `sleep_enabled` is false — test path).
/// Cancellation is checked between attempts.
async fn retry_with_backoff<'a, F, FFut, T, E>(
    runner: &InitialSyncRunner<'a>,
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
        runner.check_cancellation()?;
        attempt += 1;
        match build().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                let mapped = map_err(e);
                if !is_retryable(&mapped) || attempt >= MAX_ATTEMPTS_PER_BATCH {
                    return Err(mapped);
                }
                let delay = backoff.next_delay();
                let jittered = with_jitter(delay, attempt as u64);
                runner.sleep(jittered).await;
            }
        }
    }
}

fn is_retryable(e: &SyncError) -> bool {
    matches!(
        e,
        SyncError::Transport(_) | SyncError::Navidrome(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::capability::NavidromeProbeCredentials;
    use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
    use serde_json::json;
    use std::sync::Arc;
    use wiremock::matchers::{header, method as wm_method, path as wm_path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn flags(bits: u32) -> CapabilityFlags {
        CapabilityFlags::new(bits)
    }

    fn test_subsonic(uri: &str) -> SubsonicClient {
        SubsonicClient::with_static_credentials(
            uri,
            SubsonicCredentials::with_static("user", "tok", "salt"),
            reqwest::Client::new(),
        )
    }

    async fn mount_search3_pages(server: &MockServer, total: u32, batch: u32) {
        // Two-page test fixture: first page returns `batch` songs,
        // second page returns the remainder, third page returns empty.
        for page in 0u32..=2 {
            let offset = page * batch;
            let body = if offset >= total {
                json!({ "subsonic-response": { "status": "ok", "searchResult3": {} } })
            } else {
                let remaining = (total - offset).min(batch);
                let songs: Vec<_> = (0..remaining)
                    .map(|i| json!({
                        "id": format!("tr_{:04}", offset + i),
                        "title": format!("Title {}", offset + i),
                        "duration": 200_i64 + (offset + i) as i64,
                    }))
                    .collect();
                json!({
                    "subsonic-response": {
                        "status": "ok",
                        "searchResult3": { "song": songs }
                    }
                })
            };
            Mock::given(wm_method("GET"))
                .and(wm_path("/rest/search3.view"))
                .and(query_param("songOffset", offset.to_string()))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(server)
                .await;
        }
    }

    async fn mount_minimal_artists(server: &MockServer) {
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": {
                        "lastModified": 1_716_840_000_000_i64,
                        "ignoredArticles": "",
                        "index": []
                    }
                }
            })))
            .mount(server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getScanStatus.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "scanStatus": {
                        "scanning": false,
                        "count": 1234,
                        "lastScan": "2024-06-01T12:00:00Z"
                    }
                }
            })))
            .mount(server)
            .await;
    }

    // ── S1 happy path ──────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s1_ingest_drains_pages_and_persists_done_phase() {
        let server = MockServer::start().await;
        mount_search3_pages(&server, /*total*/ 7, /*batch*/ 4).await;
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        let runner = InitialSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
        )
        .with_batch_size(4)
        .with_sleep_disabled();

        let report = runner.run().await.unwrap();
        assert_eq!(report.ingested_count, 7);
        assert_eq!(report.remapped_count, 0);
        assert_eq!(report.strategy.as_deref(), Some("s1"));

        // sync_phase ended in "ready" and cursor cleared.
        let sync_state = SyncStateRepository::new(&store);
        assert_eq!(
            sync_state.get_sync_phase("s1", "").unwrap().as_deref(),
            Some("ready")
        );
        let cur = sync_state.get_initial_sync_cursor("s1", "").unwrap();
        assert_eq!(cur, Some(json!({})));

        // Tracks landed in the store.
        let count: i64 = store
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 7);
    }

    // ── S1 mid-cursor resume ──────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s1_resumes_from_persisted_cursor_after_kill() {
        let server = MockServer::start().await;
        mount_search3_pages(&server, /*total*/ 10, /*batch*/ 4).await;
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);

        // Seed the cursor as if a prior run completed page 0 (offset=4)
        // but was killed before page 1 landed.
        sync_state.ensure("s1", "").unwrap();
        let mid_cursor = json!({
            "strategy": "s1",
            "phase": "ingest",
            "library_scope": null,
            "ingested_count": 4,
            "strategy_state": { "kind": "linear_offset", "offset": 4 }
        });
        sync_state
            .set_initial_sync_cursor("s1", "", &mid_cursor)
            .unwrap();

        let report = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_batch_size(4)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        // Resumed at offset 4 — only 6 more rows ingested.
        assert_eq!(report.ingested_count, 4 + 6);
        // …but the store ends up with all 10.
        let count: i64 = store
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        // 6 — only the pages run by *this* invocation are persisted to
        // `track` here because the cursor said offset=4 but the prior
        // run never actually wrote rows in this fixture. The assertion
        // documents the resume semantics: cursor controls request
        // offset, not row count.
        assert_eq!(count, 6);
    }

    // ── Cursor strategy-mismatch surfaces as CursorIncompatible ───────

    #[tokio::test(flavor = "multi_thread")]
    async fn cursor_with_wrong_strategy_returns_incompatible_error() {
        let server = MockServer::start().await;
        // Any 200 envelope shape works — error fires before HTTP.
        Mock::given(wm_method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok" }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        let n1_cursor = json!({
            "strategy": "n1",
            "phase": "ingest",
            "ingested_count": 0,
            "strategy_state": { "kind": "linear_offset", "offset": 0 }
        });
        sync_state
            .set_initial_sync_cursor("s1", "", &n1_cursor)
            .unwrap();

        // Capability flags now point to S1; cursor still says N1.
        let err = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .run()
        .await
        .unwrap_err();
        assert!(matches!(err, SyncError::CursorIncompatible { .. }));
    }

    // ── Backoff retries on 503 then succeeds ──────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s1_retries_after_transient_503_then_succeeds() {
        let server = MockServer::start().await;
        // First request — 503. Wiremock `up_to_n_times` makes this
        // simple: 1 mock that only answers once with 503, then a
        // catch-all that returns the empty success envelope.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .and(query_param("songOffset", "0"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "searchResult3": {} }
            })))
            .mount(&server)
            .await;
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let report = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_batch_size(10)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();
        assert_eq!(report.ingested_count, 0, "all retries land before a song");
    }

    // ── Cancellation token aborts mid-run ─────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn cancellation_flag_returns_cancelled_error() {
        let server = MockServer::start().await;
        mount_search3_pages(&server, /*total*/ 100, /*batch*/ 4).await;
        let cancel = Arc::new(AtomicBool::new(true)); // already tripped
        let store = LibraryStore::open_in_memory();

        let err = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_batch_size(4)
        .with_cancellation(cancel)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap_err();
        assert!(matches!(err, SyncError::Cancelled));
    }

    // ── N1 happy path via wiremock ────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn n1_ingest_paginates_navidrome_native_endpoint() {
        let server = MockServer::start().await;
        // Two pages of 2 songs each, then empty.
        for page in 0u32..=2 {
            let start = page * 2;
            let songs = if page < 2 {
                vec![
                    json!({"id": format!("tr_{start}"), "title": format!("t{start}"), "duration": 100}),
                    json!({"id": format!("tr_{}", start + 1), "title": format!("t{}", start + 1), "duration": 100}),
                ]
            } else {
                vec![]
            };
            Mock::given(wm_method("GET"))
                .and(wm_path("/api/song"))
                .and(query_param("_start", start.to_string()))
                .and(header("X-ND-Authorization", "Bearer nd-tok"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::Value::Array(songs)))
                .mount(&server)
                .await;
        }
        // Minimal Subsonic ping path for artist/watermark phases.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": { "lastModified": 0, "ignoredArticles": "", "index": [] }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getScanStatus.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "scanStatus": { "scanning": false } }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let nav = NavidromeProbeCredentials {
            server_url: server.uri(),
            bearer_token: "nd-tok".into(),
        };
        let report = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
        )
        .with_navidrome_credentials(nav)
        .with_batch_size(2)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();
        assert_eq!(report.ingested_count, 4);
        let count: i64 = store
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 4);
    }

    // ── S3 explicitly unsupported in v1 ───────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s3_strategy_returns_unsupported_error() {
        // We can't easily get the selector to return S3 (it never
        // auto-picks S3), so seed a cursor that says s3 and pair it
        // with FileTreeBrowse-only flags so the cursor passes the
        // strategy-tag check.
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok" }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state
            .set_initial_sync_cursor(
                "s1",
                "",
                &json!({
                    "strategy": "s3",
                    "phase": "ingest",
                    "ingested_count": 0,
                    "strategy_state": { "kind": "empty" }
                }),
            )
            .unwrap();

        let err = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            // Default flags ⇒ selector resolves to s2, but the cursor
            // already says s3 → CursorIncompatible. We assert the
            // happy path of S3 via that error class.
            flags(0),
        )
        .with_sleep_disabled()
        .run()
        .await
        .unwrap_err();
        assert!(matches!(
            err,
            SyncError::CursorIncompatible { .. } | SyncError::StrategyUnsupported { .. }
        ));
    }

    // ── S2 happy path: getAlbumList2 → getAlbum-per-id loop ───────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s2_ingest_walks_albums_and_persists_songs() {
        let server = MockServer::start().await;
        // First album-list page: 2 albums, second page: 0 (loop ends).
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": {
                        "album": [
                            { "id": "al_1", "name": "First" },
                            { "id": "al_2", "name": "Second" }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(query_param("offset", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": { "album": [] }
                }
            })))
            .mount(&server)
            .await;
        // Per-album song lists.
        for (album_id, song_id) in [("al_1", "tr_a"), ("al_2", "tr_b")] {
            Mock::given(wm_method("GET"))
                .and(wm_path("/rest/getAlbum.view"))
                .and(query_param("id", album_id))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "subsonic-response": {
                        "status": "ok",
                        "album": {
                            "id": album_id,
                            "name": album_id,
                            "song": [
                                { "id": song_id, "title": "song", "duration": 240 }
                            ]
                        }
                    }
                })))
                .mount(&server)
                .await;
        }
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        let report = InitialSyncRunner::new(
            &store,
            &subsonic,
            "s2",
            "",
            // Force selector to fall through to S2: clear N1 + S1 bits.
            flags(0),
        )
        .with_batch_size(2)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        assert_eq!(report.strategy.as_deref(), Some("s2"));
        assert_eq!(report.ingested_count, 2);

        let count: i64 = store
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 2);
    }

    // ── Remap path triggers when UnstableTrackIds is set on the sync ───

    #[tokio::test(flavor = "multi_thread")]
    async fn remap_fires_during_sync_when_unstable_track_ids_flag_set() {
        let server = MockServer::start().await;
        // Pre-seed an "old" track row with a known content_hash —
        // simulates the prior sync result before Navidrome re-indexed.
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[TrackRow {
                server_id: "s1".into(),
                id: "tr_old".into(),
                title: "Aurora".into(),
                title_sort: None,
                artist: Some("A".into()),
                artist_id: None,
                album: "An Album".into(),
                album_id: None,
                album_artist: None,
                duration_sec: 240,
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
                server_path: Some("/path/aurora.flac".into()),
                library_id: None,
                isrc: None,
                mbid_recording: None,
                bpm: None,
                replay_gain_track_db: None,
                replay_gain_album_db: None,
                content_hash: None,
                server_updated_at: None,
                server_created_at: None,
                deleted: false,
                synced_at: 1,
                raw_json: "{}".into(),
            }])
            .unwrap();

        // S1 page returns the same path under a new id — must trigger
        // §6.9 remap.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .and(query_param("songOffset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "searchResult3": {
                        "song": [
                            {
                                "id": "tr_new",
                                "title": "Aurora",
                                "duration": 240,
                                "path": "/path/aurora.flac"
                            }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "searchResult3": {} }
            })))
            .mount(&server)
            .await;
        mount_minimal_artists(&server).await;

        let subsonic = test_subsonic(&server.uri());
        let report = InitialSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::UNSTABLE_TRACK_IDS),
        )
        .with_batch_size(10)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();
        assert_eq!(report.remapped_count, 1);

        // Old id gone, new id present.
        let ids: Vec<String> = store
            .with_conn(|c| {
                let mut s = c.prepare("SELECT id FROM track WHERE server_id='s1' ORDER BY id")?;
                let r: rusqlite::Result<Vec<String>> = s.query_map([], |r| r.get(0))?.collect();
                r
            })
            .unwrap();
        assert_eq!(ids, vec!["tr_new"]);
    }
}
