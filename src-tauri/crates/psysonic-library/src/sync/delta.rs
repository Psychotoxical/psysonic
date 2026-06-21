//! C3 — `DeltaSyncRunner` (spec §6.4 DS-0 … DS-9). Drives a targeted
//! re-fetch when the server reports new content since the last
//! successful sync. Compared to `InitialSyncRunner`:
//!
//! - Cheap probe first (DS-0 / DS-2) — short-circuits to zero further
//!   requests on the happy path.
//! - Strategy choice from `capability_flags`: N1-delta when Navidrome
//!   native bulk is available, otherwise S2-delta via
//!   `getAlbumList2 type=newest + recent`. S1 (`search3` empty query)
//!   doesn't carry a delta semantic so it's not used here.
//! - No artist/album index pass — DS-9 only re-stamps watermarks +
//!   `last_delta_sync_at`. Browse acceleration tables stay in sync
//!   incrementally via the initial pass and a future PR-3d hook.
//!
//! DS-5 canonical matcher and DS-7 starred delta are explicitly out
//! of scope for PR-3c (Phase H / follow-up).

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use psysonic_integration::navidrome::queries::nd_list_songs_internal;
use psysonic_integration::subsonic::SubsonicClient;
use serde_json::Value;

use super::backoff::{jitter_salt, with_jitter, Backoff};
use super::capability::{CapabilityFlags, NavidromeProbeCredentials};
use super::error::SyncError;
use super::mapping::{
    merge_album_open_subsonic_track_raw, navidrome_song_to_track_row, subsonic_song_to_track_row,
};
use super::progress::{NoopProgress, Progress, ProgressEvent};
use super::strategy::IngestStrategy;
use super::tombstone::TombstoneReconciler;
use crate::repos::{SyncStateRepository, TrackRepository, TrackRow};
use crate::store::LibraryStore;

/// Default batch size for delta pages — same as initial sync; servers
/// already tolerate 500-row pages at scale.
const DEFAULT_BATCH_SIZE: u32 = 500;

/// Maximum attempts per page before propagating. Same as initial sync.
const MAX_ATTEMPTS_PER_BATCH: u32 = 5;

/// How many `getAlbumList2 type=newest + recent` pages the S2-delta
/// loop walks before stopping. 2× DEFAULT_BATCH_SIZE = 1000 most-recent
/// albums per type per pass — enough overlap on small/medium libs to
/// catch every change between polls.
const S2_DELTA_MAX_PAGES_PER_TYPE: u32 = 4;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeltaSyncReport {
    pub strategy: Option<String>,
    /// `true` when DS-2 short-circuited — server watermark matched
    /// local; no tracks were touched.
    pub up_to_date: bool,
    /// `true` when DS-3 saw an active scan and deferred. Caller
    /// re-runs the delta on the next tick.
    pub deferred_scanning: bool,
    /// Track upserts performed during DS-4.
    pub changed_count: u32,
    pub remapped_count: u32,
    /// Tombstone chunk stats from DS-8 — `0` when the runner wasn't
    /// configured with `with_tombstone_budget`.
    pub tombstones_checked: u32,
    pub tombstones_deleted: u32,
}

pub struct DeltaSyncRunner<'a> {
    store: &'a LibraryStore,
    subsonic: &'a SubsonicClient,
    navidrome: Option<NavidromeProbeCredentials>,
    server_id: String,
    library_scope: String,
    capability_flags: CapabilityFlags,
    cancel: Option<Arc<std::sync::atomic::AtomicBool>>,
    batch_size: u32,
    sleep_enabled: bool,
    /// DS-8 budget. `None` skips the tombstone chunk entirely; `Some(n)`
    /// drives `TombstoneReconciler::reconcile_chunk(n)` after DS-4.
    tombstone_budget: Option<u32>,
    progress: Arc<dyn Progress + Send + Sync>,
}

impl<'a> DeltaSyncRunner<'a> {
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
            tombstone_budget: None,
            progress: Arc::new(NoopProgress),
        }
    }

    pub fn with_navidrome_credentials(mut self, creds: NavidromeProbeCredentials) -> Self {
        self.navidrome = Some(creds);
        self
    }

    pub fn with_cancellation(mut self, flag: Arc<std::sync::atomic::AtomicBool>) -> Self {
        self.cancel = Some(flag);
        self
    }

    pub fn with_batch_size(mut self, n: u32) -> Self {
        if n > 0 {
            self.batch_size = n;
        }
        self
    }

    pub fn with_sleep_disabled(mut self) -> Self {
        self.sleep_enabled = false;
        self
    }

    /// DS-8 — run a `TombstoneReconciler::reconcile_chunk(budget)`
    /// pass after DS-4 ingest. Caller (PR-3d scheduler) decides
    /// budget based on §6.7 threshold detection and per-tick limits.
    pub fn with_tombstone_budget(mut self, budget: u32) -> Self {
        self.tombstone_budget = Some(budget);
        self
    }

    pub fn with_progress(mut self, progress: Arc<dyn Progress + Send + Sync>) -> Self {
        self.progress = progress;
        self
    }

    /// DS-0 … DS-9. Returns a report describing what happened — caller
    /// (PR-3d background scheduler) decides whether to re-tick on
    /// `deferred_scanning`.
    pub async fn run(&self) -> Result<DeltaSyncReport, SyncError> {
        let sync_state = SyncStateRepository::new(self.store);
        sync_state
            .ensure(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;

        let mut report = DeltaSyncReport::default();

        // DS-0 / DS-1 / DS-2 / DS-3 — poll + watermark compare.
        let probe = self.poll_for_change(&sync_state).await?;
        report.deferred_scanning = probe.deferred_scanning;
        if probe.deferred_scanning {
            return Ok(report);
        }
        if probe.up_to_date {
            report.up_to_date = true;
            self.stamp_last_delta(&sync_state)?;
            return Ok(report);
        }

        // DS-4 — targeted ingest. Strategy choice matches initial sync
        // but S1 is skipped: `search3` doesn't carry a delta semantic.
        let strategy = self.delta_strategy();
        report.strategy = Some(strategy.as_tag().to_string());
        self.progress.emit(ProgressEvent::PhaseChanged {
            phase: format!("delta:{}", strategy.as_tag()),
        });
        match strategy {
            IngestStrategy::N1 => self.run_n1_delta(&mut report).await?,
            IngestStrategy::S2 => self.run_s2_delta(&mut report).await?,
            IngestStrategy::S1 | IngestStrategy::S3 => {
                return Err(SyncError::StrategyUnsupported {
                    strategy: strategy.as_tag(),
                })
            }
        }

        // DS-8 — optional tombstone chunk (PR-3d wiring). Runs after
        // ingest so newly-arrived rows are already in `track` before
        // we probe `getSong` for stale ids.
        if let Some(budget) = self.tombstone_budget {
            if budget > 0 {
                let mut reconciler =
                    TombstoneReconciler::new(self.store, self.subsonic, &self.server_id);
                if !self.sleep_enabled {
                    reconciler = reconciler.with_sleep_disabled();
                }
                if let Some(flag) = &self.cancel {
                    reconciler = reconciler.with_cancellation(Arc::clone(flag));
                }
                let stats = reconciler.reconcile_chunk(budget).await?;
                report.tombstones_checked = stats.checked;
                report.tombstones_deleted = stats.deleted;
                self.progress.emit(ProgressEvent::Tombstoned {
                    deleted_count: stats.deleted,
                    checked_count: stats.checked,
                });
            }
        }

        // DS-9 — stamp watermarks + refresh artist browse index when applicable.
        if let Some(ms) = probe.next_artists_watermark {
            let scope = self.library_scope_opt();
            if let Ok(index) = self.subsonic.get_artists(scope).await {
                super::artist_index::apply_artist_index(
                    self.store,
                    &self.server_id,
                    &self.library_scope,
                    &index,
                )?;
            }
            // Advance the watermark to the probed value regardless of the index
            // refresh result — a failed/empty `getArtists` must not force a full
            // refetch on every delta. Wins over the index's own last-modified.
            sync_state
                .set_artists_last_modified_ms(&self.server_id, &self.library_scope, ms)
                .map_err(SyncError::Storage)?;
        }
        if let Some(iso) = probe.next_last_scan_iso.as_deref() {
            sync_state
                .set_server_last_scan_iso(
                    &self.server_id,
                    &self.library_scope,
                    Some(iso),
                )
                .map_err(SyncError::Storage)?;
        }
        self.stamp_last_delta(&sync_state)?;

        self.progress.emit(ProgressEvent::Completed {
            kind: "delta_sync".into(),
        });
        Ok(report)
    }

    // ── helpers ────────────────────────────────────────────────────────

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

    fn write_batch(&self, rows: &[TrackRow]) -> Result<(u32, u32), SyncError> {
        let stats = TrackRepository::new(self.store)
            .upsert_batch_with_remap(rows, self.unstable_track_ids())
            .map_err(SyncError::Storage)?;
        Ok((rows.len() as u32, stats.remapped.len() as u32))
    }

    fn delta_strategy(&self) -> IngestStrategy {
        if self
            .capability_flags
            .contains(CapabilityFlags::NAVIDROME_NATIVE_BULK)
        {
            IngestStrategy::N1
        } else {
            // S1 has no delta semantic — fall through to album-crawl.
            IngestStrategy::S2
        }
    }

    fn stamp_last_delta(&self, sync_state: &SyncStateRepository<'_>) -> Result<(), SyncError> {
        sync_state
            .set_last_delta_sync_at(&self.server_id, &self.library_scope, now_unix_ms())
            .map_err(SyncError::Storage)
    }

    fn local_track_updated_watermark(&self) -> Result<Option<i64>, SyncError> {
        self.store
            .with_conn("delta.local_track_watermark", |c| {
                c.query_row(
                    "SELECT MAX(server_updated_at) FROM track \
                     WHERE server_id = ?1 AND deleted = 0",
                    rusqlite::params![self.server_id],
                    |row| row.get::<_, Option<i64>>(0),
                )
            })
            .map_err(SyncError::Storage)
    }

    fn local_album_ids(&self) -> Result<HashSet<String>, SyncError> {
        self.store
            .with_conn("delta.local_album_ids", |c| {
                let mut stmt = c.prepare(
                    "SELECT DISTINCT album_id FROM track \
                     WHERE server_id = ?1 AND deleted = 0 AND album_id IS NOT NULL",
                )?;
                let rows: rusqlite::Result<HashSet<String>> = stmt
                    .query_map(rusqlite::params![self.server_id], |r| {
                        r.get::<_, String>(0)
                    })?
                    .collect();
                rows
            })
            .map_err(SyncError::Storage)
    }

    // ── DS-0 / DS-1 / DS-2 / DS-3 — poll + watermark compare ───────────

    async fn poll_for_change(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<DeltaPollOutcome, SyncError> {
        let tier = sync_state
            .get_library_tier(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?
            .unwrap_or_else(|| "unknown".to_string());

        let mut outcome = DeltaPollOutcome::default();

        let use_scan_status = tier == "huge"
            && self
                .capability_flags
                .contains(CapabilityFlags::SCAN_STATUS_AVAILABLE);

        if use_scan_status {
            let scan = self.subsonic.get_scan_status().await?;
            // DS-3 — defer when a scan is in flight on the server.
            if scan.scanning {
                outcome.deferred_scanning = true;
                return Ok(outcome);
            }
            // DS-2 — watermark match → short-circuit.
            let stored = sync_state
                .get_server_last_scan_iso(&self.server_id, &self.library_scope)
                .map_err(SyncError::Storage)?;
            if let (Some(stored), Some(live)) = (stored.as_deref(), scan.last_scan.as_deref()) {
                if stored == live {
                    outcome.up_to_date = true;
                    return Ok(outcome);
                }
            }
            outcome.next_last_scan_iso = scan.last_scan;
        } else {
            // Small/medium tier (or unknown): `getArtists` carries
            // `lastModified` which is the watermark.
            let scope = self.library_scope_opt();
            let artists = self.subsonic.get_artists(scope).await?;
            let stored = sync_state
                .get_artists_last_modified_ms(&self.server_id, &self.library_scope)
                .map_err(SyncError::Storage)?;
            if let (Some(stored), Some(live)) = (stored, artists.last_modified_ms) {
                if stored == live {
                    outcome.up_to_date = true;
                    return Ok(outcome);
                }
            }
            outcome.next_artists_watermark = artists.last_modified_ms;
        }

        Ok(outcome)
    }

    // ── DS-4 N1-delta — Navidrome native /api/song _sort=updated_at ───

    async fn run_n1_delta(&self, report: &mut DeltaSyncReport) -> Result<(), SyncError> {
        let creds = self.navidrome.as_ref().ok_or_else(|| {
            SyncError::Transport("n1-delta selected but no Navidrome credentials supplied".into())
        })?;
        let watermark = self.local_track_updated_watermark()?;

        let mut offset: u32 = 0;
        loop {
            self.check_cancellation()?;
            let end = offset.saturating_add(self.batch_size);
            let response = retry_with_backoff(
                self,
                || {
                    nd_list_songs_internal(
                        &creds.server_url,
                        &creds.bearer_token,
                        "updated_at",
                        "DESC",
                        offset,
                        end,
                    )
                },
                SyncError::Navidrome,
            )
            .await?;

            let array = response.as_array().cloned().unwrap_or_default();
            if array.is_empty() {
                break;
            }

            let synced_at = now_unix_ms();
            let mut rows: Vec<TrackRow> = Vec::with_capacity(array.len());
            let mut crossed_watermark = false;
            for v in &array {
                if let Some(row) = navidrome_song_to_track_row(
                    &self.server_id,
                    v,
                    synced_at,
                    self.library_scope_opt(),
                ) {
                    if let (Some(watermark), Some(server_updated)) =
                        (watermark, row.server_updated_at)
                    {
                        if server_updated < watermark {
                            crossed_watermark = true;
                            continue;
                        }
                    }
                    rows.push(row);
                }
            }

            if !rows.is_empty() {
                let (changed, remapped) = self.write_batch(&rows)?;
                report.changed_count = report.changed_count.saturating_add(changed);
                report.remapped_count = report.remapped_count.saturating_add(remapped);
            }

            if crossed_watermark || (array.len() as u32) < self.batch_size {
                break;
            }
            offset = end;
        }
        Ok(())
    }

    // ── DS-4 S2-delta — getAlbumList2 newest + recent, getAlbum diff ──

    async fn run_s2_delta(&self, report: &mut DeltaSyncReport) -> Result<(), SyncError> {
        let scope = self.library_scope_opt();
        let known_albums = self.local_album_ids()?;
        let mut seen_albums: HashSet<String> = HashSet::new();

        for list_type in ["newest", "recent"] {
            let mut offset: u32 = 0;
            for _ in 0..S2_DELTA_MAX_PAGES_PER_TYPE {
                self.check_cancellation()?;
                let page = retry_with_backoff(
                    self,
                    || {
                        self.subsonic
                            .get_album_list2(list_type, self.batch_size, offset, scope)
                    },
                    SyncError::from,
                )
                .await?;
                if page.is_empty() {
                    break;
                }
                let page_len = page.len() as u32;

                for album_summary in page {
                    if !seen_albums.insert(album_summary.id.clone()) {
                        continue;
                    }
                    // S2-delta only fetches album bodies the local
                    // store doesn't already have. `recent` (`getAlbumList2
                    // type=recent`) returns play-time order, so a
                    // known album that just got played still skips
                    // the song-list re-fetch.
                    if known_albums.contains(&album_summary.id) {
                        continue;
                    }
                    self.check_cancellation()?;
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
                        let mut raw = raw_songs
                            .get(i)
                            .cloned()
                            .unwrap_or_else(|| serde_json::to_value(song).unwrap_or(Value::Null));
                        merge_album_open_subsonic_track_raw(&raw_album, &mut raw);
                        rows.push(subsonic_song_to_track_row(
                            &self.server_id,
                            song,
                            &raw,
                            synced_at,
                            self.library_scope_opt(),
                        ));
                    }
                    if !rows.is_empty() {
                        let (changed, remapped) = self.write_batch(&rows)?;
                        report.changed_count = report.changed_count.saturating_add(changed);
                        report.remapped_count =
                            report.remapped_count.saturating_add(remapped);
                    }
                }

                if page_len < self.batch_size {
                    break;
                }
                offset = offset.saturating_add(self.batch_size);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
struct DeltaPollOutcome {
    deferred_scanning: bool,
    up_to_date: bool,
    next_last_scan_iso: Option<String>,
    next_artists_watermark: Option<i64>,
}

use super::now_unix_ms;

async fn retry_with_backoff<'a, F, FFut, T, E>(
    runner: &DeltaSyncRunner<'a>,
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
                let jittered = with_jitter(delay, jitter_salt(attempt));
                runner.sleep(jittered).await;
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
    use crate::repos::TrackRow;
    use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
    use serde_json::json;
    use wiremock::matchers::{header, method as wm_method, path as wm_path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_subsonic(uri: &str) -> SubsonicClient {
        SubsonicClient::with_static_credentials(
            uri,
            SubsonicCredentials::with_static("user", "tok", "salt"),
            reqwest::Client::new(),
        )
    }

    fn flags(bits: u32) -> CapabilityFlags {
        CapabilityFlags::new(bits)
    }

    fn seed_track(store: &LibraryStore, id: &str, album_id: &str, server_updated_at: i64) {
        TrackRepository::new(store)
            .upsert_batch(&[TrackRow {
                server_id: "s1".into(),
                id: id.into(),
                title: "seed".into(),
                title_sort: None,
                artist: None,
                artist_id: None,
                album: "A".into(),
                album_id: Some(album_id.into()),
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
                server_path: None,
                library_id: None,
                isrc: None,
                mbid_recording: None,
                bpm: None,
                replay_gain_track_db: None,
                replay_gain_album_db: None,
                content_hash: None,
                server_updated_at: Some(server_updated_at),
                server_created_at: None,
                deleted: false,
                synced_at: 1,
                raw_json: "{}".into(),
            }])
            .unwrap();
    }

    // ── DS-2: getArtists watermark match → short-circuit ─────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn ds2_short_circuits_when_artists_watermark_matches() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": {
                        "lastModified": 1_700_000_000_000_i64,
                        "ignoredArticles": "",
                        "index": []
                    }
                }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state
            .set_artists_last_modified_ms("s1", "", 1_700_000_000_000)
            .unwrap();

        let subsonic = test_subsonic(&server.uri());
        let report = DeltaSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        assert!(report.up_to_date);
        assert_eq!(report.changed_count, 0);
        assert!(!report.deferred_scanning);
    }

    // ── DS-3: huge-tier scan in progress → defer ─────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn ds3_defers_when_getscanstatus_is_scanning() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getScanStatus.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "scanStatus": { "scanning": true, "count": 10000 }
                }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state.set_library_tier("s1", "", "huge").unwrap();

        let subsonic = test_subsonic(&server.uri());
        let report = DeltaSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SCAN_STATUS_AVAILABLE),
        )
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        assert!(report.deferred_scanning);
        assert!(!report.up_to_date);
        assert_eq!(report.changed_count, 0);
    }

    // ── DS-4 N1-delta crosses watermark and stops ────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn n1_delta_stops_at_local_watermark() {
        let server = MockServer::start().await;
        // getArtists path: claim new lastModified to trigger DS-4.
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
            .mount(&server)
            .await;
        // /api/song _sort=updated_at _order=DESC: 3 fresh, then 2 stale
        // (server_updated_at < watermark).
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .and(query_param("_start", "0"))
            .and(query_param("_sort", "updated_at"))
            .and(query_param("_order", "DESC"))
            .and(header("X-ND-Authorization", "Bearer nd-tok"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "id": "tr_n3", "title": "new3", "updatedAt": "2024-06-03T00:00:00Z" },
                { "id": "tr_n2", "title": "new2", "updatedAt": "2024-06-02T00:00:00Z" },
                { "id": "tr_n1", "title": "new1", "updatedAt": "2024-06-01T00:00:00Z" },
                { "id": "tr_old1", "title": "old", "updatedAt": "2024-01-01T00:00:00Z" },
                { "id": "tr_old2", "title": "old", "updatedAt": "2024-01-01T00:00:00Z" }
            ])))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        // Seed a track with server_updated_at = 2024-05-01 — fresh3..1
        // are newer (above watermark); old1/old2 are older (below).
        seed_track(&store, "tr_old_seed", "al_x", parse_test_iso("2024-05-01"));

        let nav = NavidromeProbeCredentials {
            server_url: server.uri(),
            bearer_token: "nd-tok".into(),
        };
        let subsonic = test_subsonic(&server.uri());
        let report = DeltaSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::NAVIDROME_NATIVE_BULK),
        )
        .with_navidrome_credentials(nav)
        .with_batch_size(10)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        assert_eq!(report.changed_count, 3, "only the 3 fresh rows upserted");
        assert_eq!(report.strategy.as_deref(), Some("n1"));
    }

    // ── DS-4 S2-delta only fetches unknown album ids ─────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s2_delta_skips_known_album_ids() {
        let server = MockServer::start().await;
        // Watermark change: getArtists lastModified differs from stored
        // (null) → falls through to DS-4.
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
            .mount(&server)
            .await;
        // getAlbumList2 type=newest page 0: two albums, one we already
        // have locally and one fresh.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(query_param("type", "newest"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": {
                        "album": [
                            { "id": "al_known", "name": "Known" },
                            { "id": "al_fresh", "name": "Fresh" }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;
        // Empty pages after the first one for both types.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": { "album": [] }
                }
            })))
            .mount(&server)
            .await;
        // getAlbum body for the fresh id only. If "al_known" is
        // accidentally fetched, the test mock returns 404 by default
        // and the runner errors out — that's the assertion.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .and(query_param("id", "al_fresh"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "album": {
                        "id": "al_fresh",
                        "name": "Fresh",
                        "song": [
                            { "id": "tr_new", "title": "Just landed", "duration": 240 }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        seed_track(&store, "tr_existing", "al_known", 1_000);

        let subsonic = test_subsonic(&server.uri());
        let report = DeltaSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_batch_size(10)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        assert_eq!(report.strategy.as_deref(), Some("s2"));
        assert_eq!(report.changed_count, 1, "only the fresh album got upserted");
        // The seed plus the new track land in the store.
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 2);
    }

    // ── DS-9 watermarks land + last_delta_sync_at stamped ────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn ds9_writes_watermarks_and_last_delta_timestamp() {
        let server = MockServer::start().await;
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
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": { "album": [] }
                }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        DeltaSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        let sync_state = SyncStateRepository::new(&store);
        assert_eq!(
            sync_state
                .get_artists_last_modified_ms("s1", "")
                .unwrap(),
            Some(1_716_840_000_000)
        );
        let (last_delta,): (Option<i64>,) = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT last_delta_sync_at FROM sync_state WHERE server_id='s1'",
                    [],
                    |r| Ok((r.get(0)?,)),
                )
            })
            .unwrap();
        assert!(last_delta.unwrap_or(0) > 0);
    }

    // ── DS-8: tombstone wire runs after DS-4 ─────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn ds8_runs_tombstone_chunk_when_budget_set() {
        let server = MockServer::start().await;
        // Watermark change → DS-4 ingest path runs.
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
            .mount(&server)
            .await;
        // S2-delta: empty album list → no ingest, but DS-8 still runs.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": { "album": [] }
                }
            })))
            .mount(&server)
            .await;
        // getSong probe — first id returns ok, second returns code 70.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .and(query_param("id", "tr_alive"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "song": { "id": "tr_alive", "title": "Alive" }
                }
            })))
            .mount(&server)
            .await;
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
        seed_track(&store, "tr_alive", "al_x", 1_000);
        seed_track(&store, "tr_gone", "al_x", 1_000);

        let subsonic = test_subsonic(&server.uri());
        let report = DeltaSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_tombstone_budget(10)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        assert_eq!(report.tombstones_checked, 2);
        assert_eq!(report.tombstones_deleted, 1);

        // tr_gone is now soft-deleted.
        let gone_deleted: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT deleted FROM track WHERE id='tr_gone'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(gone_deleted, 1);
    }

    fn parse_test_iso(s: &str) -> i64 {
        // Tiny helper for the seed track watermark — full date only,
        // midnight UTC, ms epoch.
        let mut parts = s.split('-');
        let y: i64 = parts.next().unwrap().parse().unwrap();
        let m: i64 = parts.next().unwrap().parse().unwrap();
        let d: i64 = parts.next().unwrap().parse().unwrap();
        let y2 = if m <= 2 { y - 1 } else { y };
        let era = y2.div_euclid(400);
        let yoe = y2 - era * 400;
        let mm = if m > 2 { m - 3 } else { m + 9 };
        let doy = (153 * mm + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        days * 86_400_000
    }
}
