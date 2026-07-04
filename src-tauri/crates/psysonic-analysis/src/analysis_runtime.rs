use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{Emitter, Manager};

use psysonic_core::ports::PlaybackQueryHandle;
use psysonic_core::server_http::{apply_optional_registry_headers, ServerHttpRegistry};
use psysonic_core::user_agent::subsonic_wire_user_agent;
use psysonic_core::track_enrichment::TrackEnrichmentOutcome;

use crate::analysis_cache;

use crate::analysis_perf::{emit_analysis_track_perf, AnalysisSeedTimings};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformUpdatedPayload {
    pub track_id: String,
    pub is_partial: bool,
}

pub const ANALYSIS_PIPELINE_PARALLELISM_MIN: usize = 1;
pub const ANALYSIS_PIPELINE_PARALLELISM_MAX: usize = 20;
pub const ANALYSIS_PIPELINE_PARALLELISM_DEFAULT: usize = 1;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AnalysisTierCounts {
    pub high: usize,
    pub middle: usize,
    pub low: usize,
}

impl AnalysisTierCounts {
    pub fn total(&self) -> usize {
        self.high + self.middle + self.low
    }
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisPipelineQueueStatsDto {
    pub pipeline_workers: u32,
    pub http_queued: usize,
    pub http_queued_high: usize,
    pub http_queued_middle: usize,
    pub http_queued_low: usize,
    pub http_download_active: usize,
    pub http_download_active_high: usize,
    pub http_download_active_middle: usize,
    pub http_download_active_low: usize,
    pub cpu_queued: usize,
    pub cpu_queued_high: usize,
    pub cpu_queued_middle: usize,
    pub cpu_queued_low: usize,
    pub cpu_decode_active: usize,
    pub cpu_decode_active_high: usize,
    pub cpu_decode_active_middle: usize,
    pub cpu_decode_active_low: usize,
}

pub fn clamp_pipeline_parallelism(workers: usize) -> usize {
    workers.clamp(
        ANALYSIS_PIPELINE_PARALLELISM_MIN,
        ANALYSIS_PIPELINE_PARALLELISM_MAX,
    )
}

/// Last requested worker count (applied when lazy-init queues and on live updates).
static REQUESTED_PIPELINE_PARALLELISM: AtomicUsize =
    AtomicUsize::new(ANALYSIS_PIPELINE_PARALLELISM_DEFAULT);

fn requested_pipeline_parallelism() -> usize {
    clamp_pipeline_parallelism(REQUESTED_PIPELINE_PARALLELISM.load(Ordering::Relaxed))
}

// ─── HTTP backfill queue: download tracks + seed analysis cache ──────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AnalysisBackfillPriority {
    Low = 0,
    Middle = 1,
    High = 2,
}

impl AnalysisBackfillPriority {
    pub fn from_optional_str(raw: Option<&str>) -> Option<Self> {
        let s = raw?.trim();
        if s.is_empty() {
            return None;
        }
        match s.to_ascii_lowercase().as_str() {
            "high" => Some(Self::High),
            "middle" => Some(Self::Middle),
            "low" => Some(Self::Low),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisBackfillEnqueueKind {
    NewLow,
    NewMiddle,
    NewHigh,
    /// Same track was already waiting; moved to a higher tier with the latest URL.
    ReorderedHigher,
    /// Same or lower priority while the track is already queued or running.
    DuplicateSkipped,
    /// High-priority request but that track is already being downloaded+seeded.
    RunningSkipped,
}

/// One queued HTTP-backfill job: `(track_id, url, server_id)`. Dedup is by
/// `track_id` (a track is backfilled at most once at a time); `server_id` rides
/// along to scope the eventual cache write and follows the latest enqueue.
type BackfillJob = (String, String, String);

#[derive(Default)]
pub struct AnalysisBackfillQueueState {
    high: VecDeque<BackfillJob>,
    middle: VecDeque<BackfillJob>,
    low: VecDeque<BackfillJob>,
    /// Active HTTP downloads keyed by track id (tier kept for pipeline stats).
    pub in_progress: HashMap<String, AnalysisBackfillPriority>,
}

impl AnalysisBackfillQueueState {
    fn queued_len(&self) -> usize {
        self.high.len() + self.middle.len() + self.low.len()
    }

    fn queued_tier_counts(&self) -> AnalysisTierCounts {
        AnalysisTierCounts {
            high: self.high.len(),
            middle: self.middle.len(),
            low: self.low.len(),
        }
    }

    fn in_progress_tier_counts(&self) -> AnalysisTierCounts {
        let mut counts = AnalysisTierCounts::default();
        for tier in self.in_progress.values() {
            match tier {
                AnalysisBackfillPriority::High => counts.high += 1,
                AnalysisBackfillPriority::Middle => counts.middle += 1,
                AnalysisBackfillPriority::Low => counts.low += 1,
            }
        }
        counts
    }

    fn tier_deque(&self, tier: AnalysisBackfillPriority) -> &VecDeque<BackfillJob> {
        match tier {
            AnalysisBackfillPriority::High => &self.high,
            AnalysisBackfillPriority::Middle => &self.middle,
            AnalysisBackfillPriority::Low => &self.low,
        }
    }

    fn tier_deque_mut(&mut self, tier: AnalysisBackfillPriority) -> &mut VecDeque<BackfillJob> {
        match tier {
            AnalysisBackfillPriority::High => &mut self.high,
            AnalysisBackfillPriority::Middle => &mut self.middle,
            AnalysisBackfillPriority::Low => &mut self.low,
        }
    }

    fn locate_queued(&self, tid: &str) -> Option<AnalysisBackfillPriority> {
        [
            AnalysisBackfillPriority::High,
            AnalysisBackfillPriority::Middle,
            AnalysisBackfillPriority::Low,
        ]
        .into_iter()
        .find(|&tier| {
            self
                .tier_deque(tier)
                .iter()
                .any(|(t, _, _)| t.as_str() == tid)
        })
    }

    fn remove_queued(&mut self, tid: &str) -> Option<BackfillJob> {
        for tier in [
            AnalysisBackfillPriority::High,
            AnalysisBackfillPriority::Middle,
            AnalysisBackfillPriority::Low,
        ] {
            if let Some(pos) = self
                .tier_deque(tier)
                .iter()
                .position(|(t, _, _)| t.as_str() == tid)
            {
                return self.tier_deque_mut(tier).remove(pos);
            }
        }
        None
    }

    fn push_new(&mut self, priority: AnalysisBackfillPriority, job: BackfillJob) {
        match priority {
            AnalysisBackfillPriority::High => self.high.push_front(job),
            AnalysisBackfillPriority::Middle => self.middle.push_back(job),
            AnalysisBackfillPriority::Low => self.low.push_back(job),
        }
    }

    fn is_reserved(&self, tid: &str) -> bool {
        self.in_progress.contains_key(tid) || self.locate_queued(tid).is_some()
    }

    fn try_pop_next(&mut self, max_concurrent: usize) -> Option<BackfillJob> {
        if self.in_progress.len() >= max_concurrent {
            return None;
        }
        for tier in [
            AnalysisBackfillPriority::High,
            AnalysisBackfillPriority::Middle,
            AnalysisBackfillPriority::Low,
        ] {
            if let Some(job) = self.tier_deque_mut(tier).pop_front() {
                self.in_progress.insert(job.0.clone(), tier);
                return Some(job);
            }
        }
        None
    }

    fn finish_job(&mut self, tid: &str) {
        self.in_progress.remove(tid);
    }

    pub fn enqueue(
        &mut self,
        server_id: String,
        tid: String,
        url: String,
        priority: AnalysisBackfillPriority,
    ) -> AnalysisBackfillEnqueueKind {
        let tref = tid.as_str();
        if !self.is_reserved(tref) && analysis_track_in_cpu_pipeline(tref) {
            return AnalysisBackfillEnqueueKind::DuplicateSkipped;
        }
        if self.is_reserved(tref) {
            if self.in_progress.contains_key(tref) {
                if priority == AnalysisBackfillPriority::High {
                    return AnalysisBackfillEnqueueKind::RunningSkipped;
                }
                return AnalysisBackfillEnqueueKind::DuplicateSkipped;
            }
            let existing = self.locate_queued(tref).unwrap_or(AnalysisBackfillPriority::Low);
            if priority <= existing {
                return AnalysisBackfillEnqueueKind::DuplicateSkipped;
            }
            self.remove_queued(tref);
            self.push_new(priority, (tid, url, server_id));
            return AnalysisBackfillEnqueueKind::ReorderedHigher;
        }
        let kind = match priority {
            AnalysisBackfillPriority::High => AnalysisBackfillEnqueueKind::NewHigh,
            AnalysisBackfillPriority::Middle => AnalysisBackfillEnqueueKind::NewMiddle,
            AnalysisBackfillPriority::Low => AnalysisBackfillEnqueueKind::NewLow,
        };
        self.push_new(priority, (tid, url, server_id));
        kind
    }

    pub fn prune_queued_not_in(
        &mut self,
        keep_track_ids: &HashSet<&str>,
        server_id: Option<&str>,
    ) -> usize {
        let before = self.queued_len();
        for tier in [
            AnalysisBackfillPriority::High,
            AnalysisBackfillPriority::Middle,
            AnalysisBackfillPriority::Low,
        ] {
            self.tier_deque_mut(tier)
                .retain(|(track_id, _, job_server_id)| {
                    let scoped = server_id.is_some_and(|sid| {
                        job_server_id.is_empty() || job_server_id == sid
                    });
                    if server_id.is_some() && !scoped {
                        return true;
                    }
                    keep_track_ids.contains(track_id.as_str())
                });
        }
        before.saturating_sub(self.queued_len())
    }
}

/// Frontend-maintained set of queue-neighbour track ids (next ~5 in queue).
#[derive(Default)]
pub struct PlaybackPriorityHints {
    middle_track_ids: Mutex<HashSet<String>>,
}

impl PlaybackPriorityHints {
    pub fn set_middle_track_ids(
        &self,
        ids: impl IntoIterator<Item = (String, String)>,
    ) {
        let mut set = HashSet::new();
        for (server_id, track_id) in ids {
            let sid = server_id.trim();
            let tid = track_id.trim();
            if !tid.is_empty() {
                set.insert(priority_hint_key(sid, tid));
            }
        }
        *self.middle_track_ids.lock().unwrap_or_else(|e| e.into_inner()) = set;
    }

    pub fn is_middle_priority(&self, server_id: &str, track_id: &str) -> bool {
        self.middle_track_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&priority_hint_key(server_id, track_id))
    }
}

fn priority_hint_key(server_id: &str, track_id: &str) -> String {
    format!("{server_id}::{track_id}")
}

pub struct AnalysisBackfillShared {
    pub state: Mutex<AnalysisBackfillQueueState>,
    wake_tx: tokio::sync::mpsc::UnboundedSender<()>,
    max_parallel: AtomicUsize,
}

impl AnalysisBackfillShared {
    pub fn ping_worker(&self) {
        let _ = self.wake_tx.send(());
    }

    fn max_parallel(&self) -> usize {
        clamp_pipeline_parallelism(self.max_parallel.load(Ordering::Relaxed))
    }
}

static ANALYSIS_BACKFILL: OnceLock<Arc<AnalysisBackfillShared>> = OnceLock::new();

/// Lazily spawns the single backfill worker (first caller supplies `AppHandle`).
pub fn analysis_backfill_shared(app: &tauri::AppHandle) -> Arc<AnalysisBackfillShared> {
    ANALYSIS_BACKFILL
        .get_or_init(|| {
            let (wake_tx, wake_rx) = tokio::sync::mpsc::unbounded_channel();
            let shared = Arc::new(AnalysisBackfillShared {
                state: Mutex::new(AnalysisBackfillQueueState::default()),
                wake_tx,
                max_parallel: AtomicUsize::new(requested_pipeline_parallelism()),
            });
            let app = app.clone();
            tauri::async_runtime::spawn(analysis_backfill_worker_loop(app, shared.clone(), wake_rx));
            shared.ping_worker();
            shared
        })
        .clone()
}

use crate::track_analysis_plan::plan_track_analysis;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueTrackAnalysisOutcome {
    /// Waveform, LUFS, and enrichment facts are all current.
    Complete,
    /// Symphonia full-file decode queued (enrichment runs after seed when needed).
    QueuedFullSeed,
    /// Oximedia pass ran inline (waveform + LUFS already cached).
    RanEnrichmentOnly,
}

/// **Single entry point** for byte-backed track analysis.
///
/// 1. Plan: waveform / LUFS gaps in analysis cache + enrichment facts in library.
/// 2. If nothing missing → no-op.
/// 3. If waveform or LUFS missing → CPU seed queue (Symphonia + EBU R128).
/// 4. Else if enrichment missing → oximedia 60 s window only.
pub async fn enqueue_track_analysis(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    format_hint: Option<&str>,
    priority: AnalysisBackfillPriority,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    enqueue_track_analysis_with_fetch(app, server_id, track_id, bytes, format_hint, priority, 0).await
}

async fn enqueue_track_analysis_with_fetch(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    format_hint: Option<&str>,
    priority: AnalysisBackfillPriority,
    fetch_ms: u64,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    if bytes.is_empty() {
        return Ok(EnqueueTrackAnalysisOutcome::Complete);
    }
    let content_hash = analysis_cache::md5_first_16kb(bytes);
    let plan = plan_track_analysis(app, server_id, track_id, &content_hash);
    if !plan.any() {
        crate::app_deprintln!(
            "[analysis] track complete track_id={} hash={}",
            track_id,
            content_hash
        );
        return Ok(EnqueueTrackAnalysisOutcome::Complete);
    }
    if plan.needs_full_cpu_seed() {
        crate::app_deprintln!(
            "[analysis] queue full seed track_id={} hash={} need_waveform={} need_loudness={} need_enrichment={}",
            track_id,
            content_hash,
            plan.need_waveform,
            plan.need_loudness,
            plan.enrichment.any()
        );
        submit_analysis_cpu_seed(
            app.clone(),
            server_id.to_string(),
            track_id.to_string(),
            bytes.to_vec(),
            format_hint.map(str::to_string),
            priority,
            fetch_ms,
        )
        .await?;
        return Ok(EnqueueTrackAnalysisOutcome::QueuedFullSeed);
    }
    if plan.needs_enrichment_only() {
        crate::app_deprintln!(
            "[analysis] enrichment-only track_id={} hash={}",
            track_id,
            content_hash
        );
        let bpm_started = std::time::Instant::now();
        let outcome = run_track_enrichment_from_bytes(
            app,
            server_id,
            track_id,
            bytes,
            analysis_emits_ui_events(priority),
        )
        .await;
        if matches!(outcome, TrackEnrichmentOutcome::Failed) {
            if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
                let key = analysis_cache::TrackKey {
                    server_id: server_id.to_string(),
                    track_id: track_id.to_string(),
                    md5_16kb: content_hash.clone(),
                };
                let _ = cache.touch_track_status(&key, "failed");
            }
            return Err("track enrichment failed".to_string());
        }
        let bpm_ms = bpm_started.elapsed().as_millis() as u64;
        emit_analysis_track_perf(app, track_id, fetch_ms, 0, bpm_ms);
        return Ok(EnqueueTrackAnalysisOutcome::RanEnrichmentOnly);
    }
    Ok(EnqueueTrackAnalysisOutcome::Complete)
}

/// Re-export for HTTP backfill gate (no bytes yet).
pub use crate::track_analysis_plan::track_analysis_needs_work;

/// Oximedia BPM/mood pass only — prefer [`enqueue_track_analysis`].
pub async fn run_track_enrichment_from_bytes(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    notify_ui: bool,
) -> TrackEnrichmentOutcome {
    if server_id.is_empty() {
        return TrackEnrichmentOutcome::SkippedNoServer;
    }
    let app = app.clone();
    let sid = server_id.to_string();
    let tid = track_id.to_string();
    let data = bytes.to_vec();
    match tokio::task::spawn_blocking(move || {
        crate::track_enrichment::run_track_enrichment_if_needed(&app, &sid, &tid, &data, notify_ui)
    })
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => TrackEnrichmentOutcome::Failed,
    }
}

/// Read a local file and run [`enqueue_track_analysis`] (hot cache, offline, spill promote).
pub async fn enqueue_track_analysis_from_file(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    file_path: &std::path::Path,
    priority: AnalysisBackfillPriority,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    let bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Ok(EnqueueTrackAnalysisOutcome::Complete);
    }
    let format_hint = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty());
    enqueue_track_analysis(app, server_id, track_id, &bytes, format_hint.as_deref(), priority).await
}

/// Library-tier offline pin: reuse waveform/LUFS cached under the playback index key,
/// plan enrichment under the library UUID, and skip work when both scopes are complete.
pub async fn enqueue_offline_library_analysis_from_file(
    app: &tauri::AppHandle,
    server_index_key: &str,
    library_server_id: &str,
    track_id: &str,
    file_path: &std::path::Path,
    explicit_priority: Option<AnalysisBackfillPriority>,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    use crate::track_analysis_plan::plan_track_analysis_offline_library;

    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut prefix = vec![0u8; 16384];
    let n = file.read(&mut prefix).await.map_err(|e| e.to_string())?;
    prefix.truncate(n);
    if prefix.is_empty() {
        return Ok(());
    }
    let content_hash = analysis_cache::md5_first_16kb(&prefix);
    let plan = plan_track_analysis_offline_library(
        app,
        &[server_index_key, library_server_id],
        library_server_id,
        track_id,
        &content_hash,
    );
    if !plan.any() {
        crate::app_deprintln!(
            "[analysis] offline library seed skip (complete) track_id={} index={} library={}",
            track_id,
            server_index_key,
            library_server_id,
        );
        return Ok(());
    }
    let bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| e.to_string())?;
    let format_hint = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty());
    let priority = explicit_priority.unwrap_or_else(|| {
        analysis_backfill_resolve_priority(app, server_index_key, track_id, None)
    });
    enqueue_track_analysis_offline_library_with_plan(OfflineLibraryAnalysisEnqueue {
        app,
        cache_server_id: server_index_key,
        enrichment_server_id: library_server_id,
        track_id,
        bytes: &bytes,
        format_hint: format_hint.as_deref(),
        priority,
        plan,
        fetch_ms: 0,
    })
    .await?;
    Ok(())
}

struct OfflineLibraryAnalysisEnqueue<'a> {
    app: &'a tauri::AppHandle,
    cache_server_id: &'a str,
    enrichment_server_id: &'a str,
    track_id: &'a str,
    bytes: &'a [u8],
    format_hint: Option<&'a str>,
    priority: AnalysisBackfillPriority,
    plan: psysonic_core::track_analysis::TrackAnalysisPlan,
    fetch_ms: u64,
}

async fn enqueue_track_analysis_offline_library_with_plan(
    args: OfflineLibraryAnalysisEnqueue<'_>,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    if args.bytes.is_empty() || !args.plan.any() {
        return Ok(EnqueueTrackAnalysisOutcome::Complete);
    }
    let content_hash = analysis_cache::md5_first_16kb(args.bytes);
    if args.plan.needs_full_cpu_seed() {
        crate::app_deprintln!(
            "[analysis] queue full seed track_id={} hash={} need_waveform={} need_loudness={} need_enrichment={}",
            args.track_id,
            content_hash,
            args.plan.need_waveform,
            args.plan.need_loudness,
            args.plan.enrichment.any()
        );
        submit_analysis_cpu_seed(
            args.app.clone(),
            args.cache_server_id.to_string(),
            args.track_id.to_string(),
            args.bytes.to_vec(),
            args.format_hint.map(str::to_string),
            args.priority,
            args.fetch_ms,
        )
        .await?;
        return Ok(EnqueueTrackAnalysisOutcome::QueuedFullSeed);
    }
    if args.plan.needs_enrichment_only() {
        crate::app_deprintln!(
            "[analysis] enrichment-only track_id={} hash={}",
            args.track_id,
            content_hash
        );
        let bpm_started = std::time::Instant::now();
        let outcome = run_track_enrichment_from_bytes(
            args.app,
            args.enrichment_server_id,
            args.track_id,
            args.bytes,
            analysis_emits_ui_events(args.priority),
        )
        .await;
        if matches!(outcome, TrackEnrichmentOutcome::Failed) {
            if let Some(cache) = args.app.try_state::<analysis_cache::AnalysisCache>() {
                let key = analysis_cache::TrackKey {
                    server_id: args.cache_server_id.to_string(),
                    track_id: args.track_id.to_string(),
                    md5_16kb: content_hash.clone(),
                };
                let _ = cache.touch_track_status(&key, "failed");
            }
            return Err("track enrichment failed".to_string());
        }
        let bpm_ms = bpm_started.elapsed().as_millis() as u64;
        emit_analysis_track_perf(args.app, args.track_id, args.fetch_ms, 0, bpm_ms);
        return Ok(EnqueueTrackAnalysisOutcome::RanEnrichmentOnly);
    }
    Ok(EnqueueTrackAnalysisOutcome::Complete)
}

/// Decode `bytes` for `track_id` via the cpu-seed queue. Prefer [`enqueue_track_analysis`].
pub async fn enqueue_analysis_seed(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
) -> Result<bool, String> {
    let priority = analysis_backfill_resolve_priority(app, server_id, track_id, None);
    let outcome = enqueue_track_analysis(app, server_id, track_id, bytes, None, priority).await?;
    Ok(!matches!(outcome, EnqueueTrackAnalysisOutcome::Complete))
}

fn analysis_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(subsonic_wire_user_agent())
            .timeout(std::time::Duration::from_secs(120))
            .pool_max_idle_per_host(ANALYSIS_PIPELINE_PARALLELISM_MAX)
            .build()
            .expect("analysis HTTP client")
    })
}

async fn analysis_backfill_download_bytes(
    app: &tauri::AppHandle,
    server_id: &str,
    url: &str,
) -> Result<(Vec<u8>, u64), String> {
    let fetch_started = std::time::Instant::now();
    let registry = app
        .try_state::<Arc<ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));
    let request = apply_optional_registry_headers(
        registry.as_deref(),
        Some(server_id),
        url,
        analysis_http_client().get(url),
    );
    let response = request
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("empty response".to_string());
    }
    let fetch_ms = fetch_started.elapsed().as_millis() as u64;
    Ok((bytes.to_vec(), fetch_ms))
}

async fn analysis_backfill_worker_loop(
    app: tauri::AppHandle,
    shared: Arc<AnalysisBackfillShared>,
    mut wake_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    loop {
        if wake_rx.recv().await.is_none() {
            break;
        }
        spawn_backfill_slots(&app, &shared).await;
    }
}

/// Queued + currently-decoding CPU-seed jobs. Each retains the full track
/// byte buffer, so this counter approximates pipeline memory pressure.
fn cpu_seed_pipeline_load() -> usize {
    let Some(shared) = ANALYSIS_CPU_SEED.get() else {
        return 0;
    };
    let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    st.queued_len() + st.running.len()
}

/// Soft cap on in-flight CPU-seed jobs (queued + running). When reached, the
/// HTTP backfill worker idles to keep decoded `Vec<u8>` buffers from piling up
/// faster than Symphonia + R128 can drain them. Floor of 2 covers `workers=1`.
fn cpu_seed_pipeline_cap(max_parallel: usize) -> usize {
    max_parallel.saturating_mul(2).max(2)
}

/// Decide whether the HTTP backfill worker should idle right now. High-tier
/// (now-playing) jobs always bypass the cap so playback is never starved.
fn should_idle_for_cpu_backpressure(
    cpu_load: usize,
    cpu_cap: usize,
    high_pending: bool,
) -> bool {
    !high_pending && cpu_load >= cpu_cap
}

async fn spawn_backfill_slots(app: &tauri::AppHandle, shared: &Arc<AnalysisBackfillShared>) {
    loop {
        let max = shared.max_parallel();
        // Backpressure against the CPU-seed pipeline: downloaded track bytes
        // (Vec<u8>, tens of MB for FLAC) sit in `AnalysisCpuSeedJob.bytes` until
        // Symphonia decode + R128 finish — much slower than HTTP. Without a cap,
        // aggressive library backfill on large libraries grows RAM unbounded.
        // High-tier (now-playing) jobs always proceed.
        let cpu_load = cpu_seed_pipeline_load();
        let cpu_cap = cpu_seed_pipeline_cap(max);
        let job_bundle = {
            let mut st = shared
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let high_pending = !st.high.is_empty();
            if should_idle_for_cpu_backpressure(cpu_load, cpu_cap, high_pending) {
                None
            } else {
                st.try_pop_next(max).map(|job| {
                    let worker_slot = st.in_progress.len();
                    (job, worker_slot)
                })
            }
        };
        let Some(((track_id, url, server_id), worker_slot)) = job_bundle else {
            if cpu_load >= cpu_cap {
                crate::app_deprintln!(
                    "[analysis] backfill idle: cpu_seed pipeline_load={} cap={} (waiting for decode catch-up)",
                    cpu_load,
                    cpu_cap
                );
            }
            break;
        };
        crate::app_deprintln!(
            "[analysis] backfill worker={}/{}: start track_id={}",
            worker_slot,
            max,
            track_id
        );
        let app = app.clone();
        let shared = shared.clone();
        tauri::async_runtime::spawn(async move {
            let download_result = analysis_backfill_download_bytes(&app, &server_id, &url).await;
            {
                let mut st = shared
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                st.finish_job(&track_id);
            }
            shared.ping_worker();

            let result = match download_result {
                Ok((bytes, fetch_ms)) => {
                    crate::app_deprintln!(
                        "[analysis] backfill worker={}/{}: fetched track_id={} fetch_ms={}",
                        worker_slot,
                        max,
                        track_id,
                        fetch_ms
                    );
                    let priority = analysis_backfill_resolve_priority(&app, &server_id, &track_id, None);
                    match enqueue_track_analysis_with_fetch(
                        &app,
                        &server_id,
                        &track_id,
                        &bytes,
                        None,
                        priority,
                        fetch_ms,
                    )
                    .await
                    {
                        Ok(outcome) => {
                            Ok(!matches!(outcome, EnqueueTrackAnalysisOutcome::Complete))
                        }
                        Err(e) => Err(e),
                    }
                }
                Err(e) => Err(e),
            };

            match &result {
                Ok(has_loudness) => crate::app_deprintln!(
                    "[analysis] backfill worker={}/{}: ready track_id={} has_loudness={}",
                    worker_slot,
                    max,
                    track_id,
                    has_loudness
                ),
                Err(e) => crate::app_eprintln!(
                    "[analysis] backfill worker={}/{}: failed track_id={}: {}",
                    worker_slot,
                    max,
                    track_id,
                    e
                ),
            }
        });
    }
}

pub fn analysis_set_pipeline_parallelism(workers: usize) {
    let workers = clamp_pipeline_parallelism(workers);
    REQUESTED_PIPELINE_PARALLELISM.store(workers, Ordering::Relaxed);
    if let Some(shared) = ANALYSIS_BACKFILL.get() {
        shared
            .max_parallel
            .store(workers, Ordering::Relaxed);
        shared.ping_worker();
    }
    if let Some(shared) = ANALYSIS_CPU_SEED.get() {
        shared
            .max_parallel
            .store(workers, Ordering::Relaxed);
        shared.ping_worker();
    }
}

pub fn analysis_backfill_queue_stats() -> (usize, usize, Option<String>) {
    if let Some(shared) = ANALYSIS_BACKFILL.get() {
        let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let in_progress_count = st.in_progress.len();
        let first_in_progress = st.in_progress.keys().next().cloned();
        (st.queued_len(), in_progress_count, first_in_progress)
    } else {
        (0, 0, None)
    }
}

pub fn analysis_track_in_cpu_pipeline(track_id: &str) -> bool {
    let tid = track_id.trim();
    if tid.is_empty() {
        return false;
    }
    let Some(shared) = ANALYSIS_CPU_SEED.get() else {
        return false;
    };
    let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if st.running.contains_key(tid) {
        return true;
    }
    st.locate_queued(tid).is_some()
}

pub fn analysis_pipeline_queue_stats() -> AnalysisPipelineQueueStatsDto {
    let pipeline_workers = ANALYSIS_BACKFILL
        .get()
        .map(|shared| shared.max_parallel())
        .or_else(|| ANALYSIS_CPU_SEED.get().map(|shared| shared.max_parallel()))
        .unwrap_or(ANALYSIS_PIPELINE_PARALLELISM_DEFAULT) as u32;

    let (http_tiers, http_active_tiers) = if let Some(shared) = ANALYSIS_BACKFILL.get() {
        let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        (st.queued_tier_counts(), st.in_progress_tier_counts())
    } else {
        (AnalysisTierCounts::default(), AnalysisTierCounts::default())
    };

    let (cpu_tiers, cpu_active_tiers) = if let Some(shared) = ANALYSIS_CPU_SEED.get() {
        let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        (st.queued_tier_counts(), st.running_tier_counts())
    } else {
        (AnalysisTierCounts::default(), AnalysisTierCounts::default())
    };

    AnalysisPipelineQueueStatsDto {
        pipeline_workers,
        http_queued: http_tiers.total(),
        http_queued_high: http_tiers.high,
        http_queued_middle: http_tiers.middle,
        http_queued_low: http_tiers.low,
        http_download_active: http_active_tiers.total(),
        http_download_active_high: http_active_tiers.high,
        http_download_active_middle: http_active_tiers.middle,
        http_download_active_low: http_active_tiers.low,
        cpu_queued: cpu_tiers.total(),
        cpu_queued_high: cpu_tiers.high,
        cpu_queued_middle: cpu_tiers.middle,
        cpu_queued_low: cpu_tiers.low,
        cpu_decode_active: cpu_active_tiers.total(),
        cpu_decode_active_high: cpu_active_tiers.high,
        cpu_decode_active_middle: cpu_active_tiers.middle,
        cpu_decode_active_low: cpu_active_tiers.low,
    }
}

pub fn analysis_backfill_is_current_track(app: &tauri::AppHandle, track_id: &str) -> bool {
    app.try_state::<psysonic_core::ports::PlaybackQueryHandle>()
        .is_some_and(|p| p.is_track_currently_playing(track_id))
}

pub fn analysis_backfill_resolve_priority(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    explicit: Option<AnalysisBackfillPriority>,
) -> AnalysisBackfillPriority {
    if let Some(priority) = explicit {
        return priority;
    }
    if analysis_backfill_is_current_track(app, track_id) {
        return AnalysisBackfillPriority::High;
    }
    if app
        .try_state::<PlaybackPriorityHints>()
        .is_some_and(|h| h.is_middle_priority(server_id, track_id))
    {
        return AnalysisBackfillPriority::Middle;
    }
    AnalysisBackfillPriority::Low
}

/// Library backfill uses `Low` — skip waveform / enrichment refresh IPC (`analysis:track-perf` still emits for probes).
pub fn analysis_emits_ui_events(priority: AnalysisBackfillPriority) -> bool {
    !matches!(priority, AnalysisBackfillPriority::Low)
}

/// Enqueue HTTP download + analysis seed (native coordinator + optional UI invoke).
pub fn enqueue_seed_from_url(
    app: &tauri::AppHandle,
    track_id: &str,
    url: &str,
    server_id_hint: Option<&str>,
    explicit_priority: Option<AnalysisBackfillPriority>,
    force: bool,
) -> Result<(), String> {
    if track_id.trim().is_empty() || url.trim().is_empty() {
        return Ok(());
    }
    let server_id = if let Ok(parsed) = reqwest::Url::parse(url) {
        if parsed.scheme() == "http" || parsed.scheme() == "https" {
            let host = parsed.host_str().unwrap_or_default();
            let mut base_path = parsed.path().to_string();
            if let Some(idx) = base_path.find("/rest") {
                base_path.truncate(idx);
            }
            while base_path.ends_with('/') {
                base_path.pop();
            }
            if host.is_empty() {
                server_id_hint.unwrap_or("").to_string()
            } else {
                let mut base = host.to_string();
                if let Some(port) = parsed.port() {
                    base.push_str(&format!(":{port}"));
                }
                if !base_path.is_empty() {
                    base.push_str(&base_path);
                }
                base
            }
        } else {
            server_id_hint.unwrap_or("").to_string()
        }
    } else {
        server_id_hint.unwrap_or("").to_string()
    };
    if !force {
        if let Some(playback) = app.try_state::<PlaybackQueryHandle>() {
            if playback.ranged_loudness_backfill_should_defer(track_id) {
                crate::app_deprintln!(
                    "[analysis] backfill skip track_id={} reason=ranged_playback_will_seed",
                    track_id
                );
                return Ok(());
            }
        }
    }
    if !force {
        if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
            if cache.cpu_seed_redundant_for_track(&server_id, track_id)? {
                if server_id.is_empty() {
                    crate::app_deprintln!(
                        "[analysis] backfill skip (no server scope): {}",
                        track_id
                    );
                    return Ok(());
                }
                if !track_analysis_needs_work(app, &server_id, track_id)? {
                    crate::app_deprintln!(
                        "[analysis] backfill skip (analysis complete): {}",
                        track_id
                    );
                    return Ok(());
                }
                crate::app_deprintln!(
                    "[analysis] backfill enqueue (analysis pending) track_id={}",
                    track_id
                );
            }
        }
    }
    let tid_log = track_id.to_string();
    let resolved = analysis_backfill_resolve_priority(app, &server_id, track_id, explicit_priority);
    let shared = analysis_backfill_shared(app);
    let kind = {
        let mut st = shared
            .state
            .lock()
            .map_err(|_| "analysis backfill lock poisoned".to_string())?;
        st.enqueue(server_id, track_id.to_string(), url.to_string(), resolved)
    };
    match kind {
        AnalysisBackfillEnqueueKind::NewLow
        | AnalysisBackfillEnqueueKind::NewMiddle
        | AnalysisBackfillEnqueueKind::NewHigh => {
            shared.ping_worker();
            crate::app_deprintln!(
                "[analysis] backfill enqueued: track_id={} priority={resolved:?}",
                tid_log,
            );
        }
        AnalysisBackfillEnqueueKind::ReorderedHigher => {
            shared.ping_worker();
            crate::app_deprintln!(
                "[analysis] backfill bumped tier track_id={} priority={resolved:?}",
                tid_log,
            );
        }
        AnalysisBackfillEnqueueKind::DuplicateSkipped | AnalysisBackfillEnqueueKind::RunningSkipped => {}
    }
    Ok(())
}

// ─── Full-track waveform + loudness: CPU seed queue (parallel decode workers) ─

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisCpuSeedEnqueueKind {
    NewLow,
    NewMiddle,
    NewHigh,
    ReorderedHigher,
    RunningFollower,
    MergedQueued,
}

type SeedDoneSender = tokio::sync::oneshot::Sender<
    Result<(analysis_cache::SeedFromBytesOutcome, AnalysisSeedTimings), String>,
>;
type SeedDoneReceiver = tokio::sync::oneshot::Receiver<
    Result<(analysis_cache::SeedFromBytesOutcome, AnalysisSeedTimings), String>,
>;
type RunningSeedJob = Arc<Mutex<Vec<SeedDoneSender>>>;

struct AnalysisCpuSeedJob {
    /// Playback server scope for the write key.
    server_id: String,
    track_id: String,
    bytes: Vec<u8>,
    format_hint: Option<String>,
    waiters: Vec<SeedDoneSender>,
    /// HTTP download time when this job came from the backfill worker.
    fetch_ms: u64,
    priority: AnalysisBackfillPriority,
}

#[derive(Default)]
struct AnalysisCpuSeedQueueState {
    high: VecDeque<AnalysisCpuSeedJob>,
    middle: VecDeque<AnalysisCpuSeedJob>,
    low: VecDeque<AnalysisCpuSeedJob>,
    /// Decodes in progress — same-id callers wait on the matching entry.
    running: HashMap<String, RunningSeedJob>,
    running_tiers: HashMap<String, AnalysisBackfillPriority>,
}

impl AnalysisCpuSeedQueueState {
    fn queued_len(&self) -> usize {
        self.high.len() + self.middle.len() + self.low.len()
    }

    fn queued_tier_counts(&self) -> AnalysisTierCounts {
        AnalysisTierCounts {
            high: self.high.len(),
            middle: self.middle.len(),
            low: self.low.len(),
        }
    }

    fn running_tier_counts(&self) -> AnalysisTierCounts {
        let mut counts = AnalysisTierCounts::default();
        for tier in self.running_tiers.values() {
            match tier {
                AnalysisBackfillPriority::High => counts.high += 1,
                AnalysisBackfillPriority::Middle => counts.middle += 1,
                AnalysisBackfillPriority::Low => counts.low += 1,
            }
        }
        counts
    }

    fn tier_deque(&self, tier: AnalysisBackfillPriority) -> &VecDeque<AnalysisCpuSeedJob> {
        match tier {
            AnalysisBackfillPriority::High => &self.high,
            AnalysisBackfillPriority::Middle => &self.middle,
            AnalysisBackfillPriority::Low => &self.low,
        }
    }

    fn tier_deque_mut(&mut self, tier: AnalysisBackfillPriority) -> &mut VecDeque<AnalysisCpuSeedJob> {
        match tier {
            AnalysisBackfillPriority::High => &mut self.high,
            AnalysisBackfillPriority::Middle => &mut self.middle,
            AnalysisBackfillPriority::Low => &mut self.low,
        }
    }

    fn locate_queued(&self, tid: &str) -> Option<(AnalysisBackfillPriority, usize)> {
        for tier in [
            AnalysisBackfillPriority::High,
            AnalysisBackfillPriority::Middle,
            AnalysisBackfillPriority::Low,
        ] {
            if let Some(pos) = self
                .tier_deque(tier)
                .iter()
                .position(|j| j.track_id == tid)
            {
                return Some((tier, pos));
            }
        }
        None
    }

    fn push_new(&mut self, priority: AnalysisBackfillPriority, job: AnalysisCpuSeedJob) {
        match priority {
            AnalysisBackfillPriority::High => self.high.push_front(job),
            AnalysisBackfillPriority::Middle => self.middle.push_back(job),
            AnalysisBackfillPriority::Low => self.low.push_back(job),
        }
    }

    fn enqueue(
        &mut self,
        server_id: String,
        track_id: String,
        bytes: Vec<u8>,
        format_hint: Option<String>,
        priority: AnalysisBackfillPriority,
        fetch_ms: u64,
    ) -> (
        AnalysisCpuSeedEnqueueKind,
        SeedDoneReceiver,
    ) {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let tid = track_id.as_str();

        if let Some(followers) = self.running.get(tid) {
            followers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(done_tx);
            return (AnalysisCpuSeedEnqueueKind::RunningFollower, done_rx);
        }

        if let Some((existing_tier, pos)) = self.locate_queued(tid) {
            let mut job = self.tier_deque_mut(existing_tier).remove(pos).unwrap();
            job.server_id = server_id;
            job.bytes = bytes;
            job.format_hint = format_hint;
            job.fetch_ms = fetch_ms;
            job.waiters.push(done_tx);
            if priority > existing_tier {
                job.priority = priority;
                self.push_new(priority, job);
                return (AnalysisCpuSeedEnqueueKind::ReorderedHigher, done_rx);
            }
            job.priority = existing_tier;
            self.tier_deque_mut(existing_tier).push_back(job);
            return (AnalysisCpuSeedEnqueueKind::MergedQueued, done_rx);
        }

        let job = AnalysisCpuSeedJob {
            server_id,
            track_id: track_id.clone(),
            bytes,
            format_hint,
            waiters: vec![done_tx],
            fetch_ms,
            priority,
        };
        let kind = match priority {
            AnalysisBackfillPriority::High => AnalysisCpuSeedEnqueueKind::NewHigh,
            AnalysisBackfillPriority::Middle => AnalysisCpuSeedEnqueueKind::NewMiddle,
            AnalysisBackfillPriority::Low => AnalysisCpuSeedEnqueueKind::NewLow,
        };
        self.push_new(priority, job);
        (kind, done_rx)
    }

    fn prune_queued_not_in(
        &mut self,
        keep_track_ids: &HashSet<&str>,
        server_id: Option<&str>,
    ) -> (usize, usize) {
        let mut removed_jobs = 0usize;
        let mut removed_waiters = 0usize;
        for tier in [
            AnalysisBackfillPriority::High,
            AnalysisBackfillPriority::Middle,
            AnalysisBackfillPriority::Low,
        ] {
            let mut kept = VecDeque::with_capacity(self.tier_deque(tier).len());
            while let Some(job) = self.tier_deque_mut(tier).pop_front() {
                let scoped = server_id.is_some_and(|sid| {
                    job.server_id.is_empty() || job.server_id == sid
                });
                if server_id.is_some() && !scoped {
                    kept.push_back(job);
                    continue;
                }
                if keep_track_ids.contains(job.track_id.as_str()) {
                    kept.push_back(job);
                    continue;
                }
                removed_jobs += 1;
                removed_waiters += job.waiters.len();
                for tx in job.waiters {
                    let _ = tx.send(Err(
                        "cpu-seed pruned: track no longer in playback queue".to_string(),
                    ));
                }
            }
            *self.tier_deque_mut(tier) = kept;
        }
        (removed_jobs, removed_waiters)
    }

    fn try_pop_next(&mut self) -> Option<AnalysisCpuSeedJob> {
        self.high
            .pop_front()
            .or_else(|| self.middle.pop_front())
            .or_else(|| self.low.pop_front())
    }
}

struct AnalysisCpuSeedShared {
    state: Mutex<AnalysisCpuSeedQueueState>,
    wake_tx: tokio::sync::mpsc::UnboundedSender<()>,
    max_parallel: AtomicUsize,
}

impl AnalysisCpuSeedShared {
    fn ping_worker(&self) {
        let _ = self.wake_tx.send(());
    }

    fn max_parallel(&self) -> usize {
        clamp_pipeline_parallelism(self.max_parallel.load(Ordering::Relaxed))
    }
}

static ANALYSIS_CPU_SEED: OnceLock<Arc<AnalysisCpuSeedShared>> = OnceLock::new();

fn analysis_cpu_seed_shared(app: &tauri::AppHandle) -> Arc<AnalysisCpuSeedShared> {
    ANALYSIS_CPU_SEED
        .get_or_init(|| {
            let (wake_tx, wake_rx) = tokio::sync::mpsc::unbounded_channel();
            let shared = Arc::new(AnalysisCpuSeedShared {
                state: Mutex::new(AnalysisCpuSeedQueueState::default()),
                wake_tx,
                max_parallel: AtomicUsize::new(requested_pipeline_parallelism()),
            });
            let app = app.clone();
            tauri::async_runtime::spawn(analysis_cpu_seed_worker_loop(app, shared.clone(), wake_rx));
            shared.ping_worker();
            shared
        })
        .clone()
}

/// HTTP backfill + CPU seed queue sizes (debug log only — `app_deprintln!`).
fn emit_analysis_queue_snapshot_line() {
    let http = if let Some(arc) = ANALYSIS_BACKFILL.get() {
        let st = arc.state.lock().unwrap_or_else(|e| e.into_inner());
        format!(
            "http_backfill={{queued:{} tiers=({},{},{}) download_active:{}}}",
            st.queued_len(),
            st.high.len(),
            st.middle.len(),
            st.low.len(),
            st.in_progress.len(),
        )
    } else {
        "http_backfill={{not_started}}".to_string()
    };

    let cpu = if let Some(arc) = ANALYSIS_CPU_SEED.get() {
        let st = arc.state.lock().unwrap_or_else(|e| e.into_inner());
        let queued_jobs = st.queued_len();
        let decoding_count = st.running.len();
        let tiers = st.queued_tier_counts();
        format!(
            "cpu_seed={{queued_jobs:{} tiers=({},{},{}) decoding_active:{}}}",
            queued_jobs,
            tiers.high,
            tiers.middle,
            tiers.low,
            decoding_count,
        )
    } else {
        "cpu_seed={{not_started}}".to_string()
    };

    crate::app_deprintln!(
        "[analysis] queue_snapshot interval_s=60 note=queues_in_memory_cleared_on_app_restart | {http} | {cpu}"
    );
}

pub async fn analysis_queue_snapshot_loop() {
    emit_analysis_queue_snapshot_line();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        emit_analysis_queue_snapshot_line();
    }
}

async fn analysis_cpu_seed_worker_loop(
    app: tauri::AppHandle,
    shared: Arc<AnalysisCpuSeedShared>,
    mut wake_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    loop {
        if wake_rx.recv().await.is_none() {
            break;
        }
        spawn_cpu_seed_slots(&app, &shared).await;
    }
}

async fn spawn_cpu_seed_slots(app: &tauri::AppHandle, shared: &Arc<AnalysisCpuSeedShared>) {
    loop {
        let max = shared.max_parallel();
        let job_bundle = {
            let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            if st.running.len() >= max {
                None
            } else {
                st.try_pop_next().map(|j| {
                    let followers = Arc::new(Mutex::new(Vec::new()));
                    let job_priority = j.priority;
                    st.running
                        .insert(j.track_id.clone(), followers.clone());
                    st.running_tiers
                        .insert(j.track_id.clone(), job_priority);
                    let worker_slot = st.running.len();
                    (j, followers, worker_slot)
                })
            }
        };
        let Some((job, followers, worker_slot)) = job_bundle else {
            break;
        };
        let tid_log = job.track_id.clone();
        let fetch_ms = job.fetch_ms;
        crate::app_deprintln!(
            "[analysis] cpu-seed worker={}/{}: start track_id={}",
            worker_slot,
            max,
            tid_log
        );
        let app_for_decode = app.clone();
        let app_for_events = app.clone();
        let shared = shared.clone();
        let notify_ui = analysis_emits_ui_events(job.priority);
        tauri::async_runtime::spawn(async move {
            let sid = job.server_id.clone();
            let tid = job.track_id.clone();
            let bytes = job.bytes;
            let format_hint = job.format_hint;
            let seed_result = tokio::task::spawn_blocking(move || {
                analysis_cache::seed_from_bytes_execute(
                    &app_for_decode,
                    &sid,
                    &tid,
                    &bytes,
                    format_hint.as_deref(),
                    notify_ui,
                )
            })
            .await
            .unwrap_or_else(|e| Err(format!("cpu-seed spawn_blocking: {e}")));

            let mut extra = followers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .drain(..)
                .collect::<Vec<_>>();
            for tx in job.waiters {
                let _ = tx.send(seed_result.clone());
            }
            for tx in extra.drain(..) {
                let _ = tx.send(seed_result.clone());
            }

            {
                let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                st.running.remove(&tid_log);
                st.running_tiers.remove(&tid_log);
            }
            // Decode slot freed → wake HTTP backfill in case it was idling on
            // the `cpu_seed_pipeline_cap` backpressure check.
            if let Some(http) = ANALYSIS_BACKFILL.get() {
                http.ping_worker();
            }

            match &seed_result {
                Ok((outcome, timings)) => {
                    let ok = *outcome == analysis_cache::SeedFromBytesOutcome::Upserted;
                    emit_analysis_track_perf(
                        &app_for_events,
                        &tid_log,
                        fetch_ms,
                        timings.seed_ms,
                        timings.bpm_ms,
                    );
                    crate::app_deprintln!(
                        "[analysis] cpu-seed worker={}/{}: done track_id={} upserted={}",
                        worker_slot,
                        max,
                        tid_log,
                        ok
                    );
                    if ok && notify_ui {
                        let _ = app_for_events.emit(
                            "analysis:waveform-updated",
                            WaveformUpdatedPayload {
                                track_id: tid_log.clone(),
                                is_partial: false,
                            },
                        );
                    }
                }
                Err(e) => {
                    crate::app_eprintln!(
                        "[analysis] cpu-seed worker={}/{}: failed track_id={}: {e}",
                        worker_slot,
                        max,
                        tid_log
                    );
                }
            }
            shared.ping_worker();
        });
    }
}

/// Prune queued items in both analysis queues (HTTP backfill + CPU seed) whose
/// track ids are not in `keep_track_ids`. Items that are *currently running* are
/// untouched; only queued items are removed. Pruned CPU-seed waiters get an Err
/// indicating the prune.
///
/// Returns `(http_removed, cpu_removed_jobs, cpu_removed_waiters)`. Either
/// queue may not have been initialized yet — those slots return 0.
pub fn prune_analysis_queues(
    keep_track_ids: &HashSet<&str>,
    server_id: Option<&str>,
) -> Result<(usize, usize, usize), String> {
    let http_removed = if let Some(shared) = ANALYSIS_BACKFILL.get() {
        let mut st = shared
            .state
            .lock()
            .map_err(|_| "analysis backfill lock poisoned".to_string())?;
        st.prune_queued_not_in(keep_track_ids, server_id)
    } else {
        0
    };

    let (cpu_removed_jobs, cpu_removed_waiters) = if let Some(shared) = ANALYSIS_CPU_SEED.get() {
        let mut st = shared
            .state
            .lock()
            .map_err(|_| "analysis cpu-seed lock poisoned".to_string())?;
        st.prune_queued_not_in(keep_track_ids, server_id)
    } else {
        (0, 0)
    };

    Ok((http_removed, cpu_removed_jobs, cpu_removed_waiters))
}

/// Submit full-buffer analysis; serializes with other producers. Priority mirrors
/// HTTP backfill tier ordering (high → middle → low).
///
/// Emits `analysis:waveform-updated` when analysis **wrote** new waveform data (`Upserted`).
/// Cache-hit skips (`SkippedWaveformCacheHit`) omit the event so the frontend does not
/// re-run loudness refresh / waveform IPC for rows that were already current.
pub async fn submit_analysis_cpu_seed(
    app: tauri::AppHandle,
    server_id: String,
    track_id: String,
    bytes: Vec<u8>,
    format_hint: Option<String>,
    priority: AnalysisBackfillPriority,
    fetch_ms: u64,
) -> Result<analysis_cache::SeedFromBytesOutcome, String> {
    let shared = analysis_cpu_seed_shared(&app);
    let rx = {
        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let (kind, rx) = st.enqueue(server_id, track_id.clone(), bytes, format_hint, priority, fetch_ms);
        crate::app_deprintln!("[analysis] cpu-seed submit: kind={kind:?} priority={priority:?}");
        drop(st);
        shared.ping_worker();
        rx
    };
    let (outcome, _timings) = match rx.await {
        Ok(res) => res?,
        Err(_) => return Err("cpu-seed: result channel dropped".to_string()),
    };
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── AnalysisBackfillQueueState ────────────────────────────────────────────

    #[test]
    fn backfill_default_state_has_empty_queues_and_no_in_progress() {
        let s = AnalysisBackfillQueueState::default();
        assert_eq!(s.queued_len(), 0);
        assert!(s.in_progress.is_empty());
    }

    #[test]
    fn backfill_is_reserved_checks_all_tiers_and_in_progress() {
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(
            String::new(),
            "queued".into(),
            "u".into(),
            AnalysisBackfillPriority::Middle,
        );
        s.in_progress.insert("active".into(), AnalysisBackfillPriority::Low);
        assert!(s.is_reserved("queued"));
        assert!(s.is_reserved("active"));
        assert!(!s.is_reserved("other"));
    }

    #[test]
    fn backfill_try_pop_next_drains_high_then_middle_then_low() {
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(String::new(), "low".into(), "u".into(), AnalysisBackfillPriority::Low);
        s.enqueue(String::new(), "mid".into(), "u".into(), AnalysisBackfillPriority::Middle);
        s.enqueue(String::new(), "hi".into(), "u".into(), AnalysisBackfillPriority::High);
        assert_eq!(s.try_pop_next(4).unwrap().0, "hi");
        assert_eq!(s.try_pop_next(4).unwrap().0, "mid");
        assert_eq!(s.try_pop_next(4).unwrap().0, "low");
    }

    #[test]
    fn backfill_enqueue_low_priority_appends_to_low_tier() {
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(
            String::new(),
            "first".into(),
            "u".into(),
            AnalysisBackfillPriority::High,
        );
        let kind = s.enqueue(
            String::new(),
            "second".into(),
            "u2".into(),
            AnalysisBackfillPriority::Low,
        );
        assert_eq!(kind, AnalysisBackfillEnqueueKind::NewLow);
        assert_eq!(s.try_pop_next(4).unwrap().0, "first");
        assert_eq!(s.try_pop_next(4).unwrap().0, "second");
    }

    #[test]
    fn backfill_enqueue_high_priority_pushes_to_high_tier() {
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(
            String::new(),
            "old".into(),
            "u".into(),
            AnalysisBackfillPriority::Low,
        );
        let kind = s.enqueue(
            String::new(),
            "hot".into(),
            "u2".into(),
            AnalysisBackfillPriority::High,
        );
        assert_eq!(kind, AnalysisBackfillEnqueueKind::NewHigh);
        assert_eq!(s.try_pop_next(4).unwrap().0, "hot");
    }

    #[test]
    fn backfill_enqueue_middle_priority_appends_to_middle_tier() {
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(
            String::new(),
            "old".into(),
            "u".into(),
            AnalysisBackfillPriority::Low,
        );
        let kind = s.enqueue(
            String::new(),
            "next".into(),
            "u2".into(),
            AnalysisBackfillPriority::Middle,
        );
        assert_eq!(kind, AnalysisBackfillEnqueueKind::NewMiddle);
        assert_eq!(s.try_pop_next(4).unwrap().0, "next");
        assert_eq!(s.try_pop_next(4).unwrap().0, "old");
    }

    #[test]
    fn backfill_enqueue_returns_duplicate_skipped_for_same_tier_dup() {
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(
            String::new(),
            "dup".into(),
            "u".into(),
            AnalysisBackfillPriority::Low,
        );
        let kind = s.enqueue(
            String::new(),
            "dup".into(),
            "u2".into(),
            AnalysisBackfillPriority::Low,
        );
        assert_eq!(kind, AnalysisBackfillEnqueueKind::DuplicateSkipped);
        assert_eq!(s.queued_len(), 1);
    }

    #[test]
    fn backfill_enqueue_upgrades_low_to_middle() {
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(
            String::new(),
            "dup".into(),
            "old_url".into(),
            AnalysisBackfillPriority::Low,
        );
        let kind = s.enqueue(
            "server-1".into(),
            "dup".into(),
            "fresh_url".into(),
            AnalysisBackfillPriority::Middle,
        );
        assert_eq!(kind, AnalysisBackfillEnqueueKind::ReorderedHigher);
        let job = s.try_pop_next(4).unwrap();
        assert_eq!(job.0, "dup");
        assert_eq!(job.1, "fresh_url");
        assert_eq!(job.2, "server-1");
        assert_eq!(s.queued_len(), 0);
    }

    #[test]
    fn backfill_enqueue_returns_running_skipped_for_high_prio_active_track() {
        let mut s = AnalysisBackfillQueueState {
            in_progress: HashMap::from([(
                String::from("active"),
                AnalysisBackfillPriority::Low,
            )]),
            ..Default::default()
        };
        let kind = s.enqueue(
            String::new(),
            "active".into(),
            "u".into(),
            AnalysisBackfillPriority::High,
        );
        assert_eq!(kind, AnalysisBackfillEnqueueKind::RunningSkipped);
    }

    #[test]
    fn backfill_try_pop_next_respects_max_concurrent() {
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(String::new(), "a".into(), "u".into(), AnalysisBackfillPriority::Low);
        s.enqueue(String::new(), "b".into(), "u".into(), AnalysisBackfillPriority::Low);
        s.in_progress.insert("active".into(), AnalysisBackfillPriority::Low);
        assert!(s.try_pop_next(1).is_none());
        assert_eq!(s.try_pop_next(2).unwrap().0, "a");
    }

    #[test]
    fn backfill_prune_queued_not_in_drops_unkept_entries() {
        let mut s = AnalysisBackfillQueueState::default();
        for tid in ["a", "b", "c", "d"] {
            s.enqueue(String::new(), tid.into(), "u".into(), AnalysisBackfillPriority::Low);
        }
        let keep: HashSet<&str> = ["a", "c"].iter().copied().collect();
        let removed = s.prune_queued_not_in(&keep, None);
        assert_eq!(removed, 2);
        assert_eq!(s.try_pop_next(4).unwrap().0, "a");
        assert_eq!(s.try_pop_next(4).unwrap().0, "c");
    }

    // ── AnalysisCpuSeedQueueState ─────────────────────────────────────────────

    #[test]
    fn cpu_seed_enqueue_low_prio_appends_to_low_tier() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (kind, _rx) = s.enqueue(
            String::new(),
            "a".into(),
            vec![],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewLow);
        assert_eq!(s.queued_len(), 1);
    }

    #[test]
    fn cpu_seed_enqueue_high_prio_pushes_to_high_tier() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(
            String::new(),
            "first".into(),
            vec![],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (kind, _r2) = s.enqueue(
            String::new(),
            "hot".into(),
            vec![],
            None,
            AnalysisBackfillPriority::High,
            0,
        );
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewHigh);
        assert_eq!(s.try_pop_next().unwrap().track_id, "hot");
    }

    #[test]
    fn cpu_seed_enqueue_existing_low_prio_merges_at_back() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(
            "server-a".into(),
            "dup".into(),
            vec![1, 2, 3],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (kind, _r2) = s.enqueue(
            "server-b".into(),
            "dup".into(),
            vec![4, 5, 6],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::MergedQueued);
        assert_eq!(s.queued_len(), 1);
        let job = s.try_pop_next().unwrap();
        assert_eq!(job.bytes, vec![4, 5, 6], "fresh bytes overwrite");
        assert_eq!(job.server_id, "server-b", "latest server scope wins on merge");
        assert_eq!(job.waiters.len(), 2, "both waiters attached");
    }

    #[test]
    fn cpu_seed_enqueue_existing_low_prio_upgrades_to_high() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(
            String::new(),
            "first".into(),
            vec![],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (_, _r2) = s.enqueue(
            String::new(),
            "dup".into(),
            vec![],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (kind, _r3) = s.enqueue(
            String::new(),
            "dup".into(),
            vec![],
            None,
            AnalysisBackfillPriority::High,
            0,
        );
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::ReorderedHigher);
        assert_eq!(s.try_pop_next().unwrap().track_id, "dup");
    }

    #[test]
    fn cpu_seed_enqueue_running_id_attaches_as_follower() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let followers = Arc::new(Mutex::new(Vec::new()));
        s.running.insert("active".into(), followers.clone());
        let (kind, _rx) = s.enqueue(
            String::new(),
            "active".into(),
            vec![],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::RunningFollower);
        assert_eq!(followers.lock().unwrap().len(), 1, "follower channel attached");
        assert_eq!(s.queued_len(), 0, "follower does not occupy a queue slot");
    }

    #[test]
    fn cpu_seed_prune_returns_removed_jobs_and_waiter_count() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(
            String::new(),
            "a".into(),
            vec![],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (_, _r2) = s.enqueue(
            String::new(),
            "b".into(),
            vec![],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (_, _r3) = s.enqueue(
            String::new(),
            "a".into(),
            vec![],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (_, _r4) = s.enqueue(
            String::new(),
            "c".into(),
            vec![],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );

        let keep: HashSet<&str> = ["a"].iter().copied().collect();
        let (removed_jobs, removed_waiters) = s.prune_queued_not_in(&keep, None);
        assert_eq!(removed_jobs, 2, "b and c removed");
        assert_eq!(removed_waiters, 2, "one waiter on b + one on c");
        assert_eq!(s.try_pop_next().unwrap().track_id, "a");
    }

    #[test]
    fn cpu_seed_prune_sends_err_to_dropped_waiters() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, rx) = s.enqueue(
            String::new(),
            "doomed".into(),
            vec![],
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let keep: HashSet<&str> = HashSet::new();
        let _ = s.prune_queued_not_in(&keep, None);
        let result = rx.blocking_recv().expect("sender side should have closed cleanly");
        assert!(result.is_err(), "pruned job must yield Err, got {result:?}");
    }

    // ── CPU-seed backpressure ─────────────────────────────────────────────────

    #[test]
    fn cpu_seed_pipeline_cap_scales_with_workers() {
        assert_eq!(cpu_seed_pipeline_cap(1), 2);
        assert_eq!(cpu_seed_pipeline_cap(3), 6);
        assert_eq!(cpu_seed_pipeline_cap(6), 12);
        assert_eq!(cpu_seed_pipeline_cap(20), 40);
    }

    #[test]
    fn cpu_seed_pipeline_cap_has_floor_of_two() {
        assert_eq!(cpu_seed_pipeline_cap(0), 2);
    }

    #[test]
    fn backpressure_idles_when_cpu_load_meets_cap_and_no_high() {
        assert!(should_idle_for_cpu_backpressure(12, 12, false));
        assert!(should_idle_for_cpu_backpressure(20, 12, false));
    }

    #[test]
    fn backpressure_allows_pop_when_cpu_load_below_cap() {
        assert!(!should_idle_for_cpu_backpressure(11, 12, false));
        assert!(!should_idle_for_cpu_backpressure(0, 12, false));
    }

    #[test]
    fn backpressure_bypassed_for_high_priority_jobs() {
        assert!(!should_idle_for_cpu_backpressure(100, 12, true));
    }
}
