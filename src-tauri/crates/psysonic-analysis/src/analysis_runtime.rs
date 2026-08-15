use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{Emitter, Manager};

use psysonic_core::ports::PlaybackQueryHandle;
use psysonic_core::server_http::ServerHttpRegistry;
use psysonic_core::track_enrichment::TrackEnrichmentOutcome;
use psysonic_core::user_agent::subsonic_wire_user_agent;

use crate::analysis_cache;

use crate::analysis_perf::{emit_analysis_track_perf, AnalysisSeedTimings};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformUpdatedPayload {
    pub track_id: String,
    pub server_index_key: String,
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
    /// Automatic backfill recently failed before CPU admission.
    RetryDeferred,
    /// Automatic backfill is cooling down after a terminal failure.
    TerminalSkipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum EnqueueSeedFromUrlOutcome {
    Enqueued,
    AlreadyReserved,
    Skipped,
    Unsupported,
}

/// One queued HTTP-backfill job: `(track_id, url, server_id)`. Dedup is by
/// `(server_id, track_id)` so identical Subsonic ids on different servers do
/// not share downloads or cache writes.
type BackfillJob = (String, String, String);

const ANALYSIS_BACKFILL_RETRY_BASE_SECS: u64 = 30;
const ANALYSIS_BACKFILL_RETRY_MAX_SECS: u64 = 30 * 60;
// A track id can later point at new content, so even terminal HTTP/size
// failures must not suppress automatic analysis for the whole app session.
const ANALYSIS_BACKFILL_TERMINAL_RETRY_SECS: u64 = 60 * 60;

#[derive(Debug, Clone, Copy)]
struct AnalysisBackfillRetryState {
    failures: u32,
    retry_after: std::time::Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnalysisBackfillFinish {
    Success,
    RetryableFailure,
    TerminalFailure,
}

#[derive(Default)]
pub struct AnalysisBackfillQueueState {
    high: VecDeque<BackfillJob>,
    middle: VecDeque<BackfillJob>,
    low: VecDeque<BackfillJob>,
    /// Active HTTP downloads keyed by track id (tier kept for pipeline stats).
    pub in_progress: HashMap<String, AnalysisBackfillPriority>,
    /// HTTP download completed and the corresponding CPU seed is still pending.
    /// This reservation prevents a second download without consuming an HTTP slot.
    awaiting_cpu: HashSet<String>,
    retry_state: HashMap<String, AnalysisBackfillRetryState>,
    terminal_failures: HashMap<String, std::time::Instant>,
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

    fn locate_queued(&self, key: &str) -> Option<AnalysisBackfillPriority> {
        [
            AnalysisBackfillPriority::High,
            AnalysisBackfillPriority::Middle,
            AnalysisBackfillPriority::Low,
        ]
        .into_iter()
        .find(|&tier| {
            self.tier_deque(tier)
                .iter()
                .any(|(t, _, sid)| seed_key(sid, t) == key)
        })
    }

    fn remove_queued(&mut self, key: &str) -> Option<BackfillJob> {
        for tier in [
            AnalysisBackfillPriority::High,
            AnalysisBackfillPriority::Middle,
            AnalysisBackfillPriority::Low,
        ] {
            if let Some(pos) = self
                .tier_deque(tier)
                .iter()
                .position(|(t, _, sid)| seed_key(sid, t) == key)
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

    fn is_reserved(&self, key: &str) -> bool {
        self.in_progress.contains_key(key)
            || self.awaiting_cpu.contains(key)
            || self.locate_queued(key).is_some()
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
                self.in_progress.insert(seed_key(&job.2, &job.0), tier);
                return Some(job);
            }
        }
        None
    }

    fn try_pop_next_with_cpu_backpressure(
        &mut self,
        max_concurrent: usize,
        cpu_load: usize,
        cpu_cap: usize,
    ) -> Option<BackfillJob> {
        let high_pending = !self.high.is_empty();
        if should_idle_for_cpu_backpressure(
            cpu_load,
            self.in_progress.len(),
            cpu_cap,
            high_pending,
        ) {
            return None;
        }
        self.try_pop_next(max_concurrent)
    }

    fn record_retryable_failure(&mut self, key: &str) {
        let failures = self
            .retry_state
            .get(key)
            .map_or(1, |state| state.failures.saturating_add(1));
        let exponent = failures.saturating_sub(1).min(6);
        let delay_secs = ANALYSIS_BACKFILL_RETRY_BASE_SECS
            .saturating_mul(1_u64 << exponent)
            .min(ANALYSIS_BACKFILL_RETRY_MAX_SECS);
        self.retry_state.insert(
            key.to_string(),
            AnalysisBackfillRetryState {
                failures,
                retry_after: std::time::Instant::now() + std::time::Duration::from_secs(delay_secs),
            },
        );
        if self.locate_queued(key) == Some(AnalysisBackfillPriority::Low) {
            self.remove_queued(key);
        }
    }

    fn finish_job(&mut self, key: &str, finish: AnalysisBackfillFinish) {
        self.in_progress.remove(key);
        self.awaiting_cpu.remove(key);
        match finish {
            AnalysisBackfillFinish::Success => {
                self.retry_state.remove(key);
                self.terminal_failures.remove(key);
            }
            AnalysisBackfillFinish::RetryableFailure => {
                self.terminal_failures.remove(key);
                self.record_retryable_failure(key);
            }
            AnalysisBackfillFinish::TerminalFailure => {
                self.retry_state.remove(key);
                self.terminal_failures.insert(
                    key.to_string(),
                    std::time::Instant::now()
                        + std::time::Duration::from_secs(ANALYSIS_BACKFILL_TERMINAL_RETRY_SECS),
                );
            }
        }
    }

    fn mark_cpu_admitted(&mut self, key: &str) {
        self.in_progress.remove(key);
        self.awaiting_cpu.insert(key.to_string());
    }

    fn retry_deferred(&self, key: &str) -> bool {
        self.retry_state
            .get(key)
            .is_some_and(|state| state.retry_after > std::time::Instant::now())
    }

    fn terminal_deferred(&self, key: &str) -> bool {
        self.terminal_failures
            .get(key)
            .is_some_and(|retry_after| *retry_after > std::time::Instant::now())
    }

    fn clear_failure_state(&mut self, server_id: &str, track_ids: &[String]) {
        if track_ids.is_empty() {
            let prefix = format!("{server_id}\u{1f}");
            self.retry_state.retain(|key, _| !key.starts_with(&prefix));
            self.terminal_failures
                .retain(|key, _| !key.starts_with(&prefix));
            return;
        }
        for track_id in track_ids {
            let bare_track_id = track_id.strip_prefix("stream:").unwrap_or(track_id);
            for variant in [bare_track_id.to_string(), format!("stream:{bare_track_id}")] {
                let key = seed_key(server_id, &variant);
                self.retry_state.remove(&key);
                self.terminal_failures.remove(&key);
            }
        }
    }

    pub fn enqueue(
        &mut self,
        server_id: String,
        tid: String,
        url: String,
        priority: AnalysisBackfillPriority,
    ) -> AnalysisBackfillEnqueueKind {
        self.enqueue_with_force(server_id, tid, url, priority, false)
    }

    fn enqueue_with_force(
        &mut self,
        server_id: String,
        tid: String,
        url: String,
        priority: AnalysisBackfillPriority,
        force: bool,
    ) -> AnalysisBackfillEnqueueKind {
        // Reservation/merge scope is (server, track): the same Subsonic id on
        // two servers is two different files and must not collide.
        let key = seed_key(&server_id, &tid);
        let tref = key.as_str();
        if !self.is_reserved(tref) && analysis_track_in_cpu_pipeline(&server_id, &tid) {
            return AnalysisBackfillEnqueueKind::DuplicateSkipped;
        }
        if self.is_reserved(tref) {
            if self.in_progress.contains_key(tref) || self.awaiting_cpu.contains(tref) {
                if priority == AnalysisBackfillPriority::High {
                    return AnalysisBackfillEnqueueKind::RunningSkipped;
                }
                return AnalysisBackfillEnqueueKind::DuplicateSkipped;
            }
            let existing = self
                .locate_queued(tref)
                .unwrap_or(AnalysisBackfillPriority::Low);
            if priority <= existing {
                return AnalysisBackfillEnqueueKind::DuplicateSkipped;
            }
            self.remove_queued(tref);
            self.push_new(priority, (tid, url, server_id));
            return AnalysisBackfillEnqueueKind::ReorderedHigher;
        }
        if !force && priority == AnalysisBackfillPriority::Low && self.retry_deferred(tref) {
            return AnalysisBackfillEnqueueKind::RetryDeferred;
        }
        if !force && priority == AnalysisBackfillPriority::Low && self.terminal_deferred(tref) {
            return AnalysisBackfillEnqueueKind::TerminalSkipped;
        }
        if !self.terminal_deferred(tref) {
            self.terminal_failures.remove(tref);
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
                    let scoped = server_id
                        .is_some_and(|sid| job_server_id.is_empty() || job_server_id == sid);
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
    pub fn set_middle_track_ids(&self, ids: impl IntoIterator<Item = (String, String)>) {
        let mut set = HashSet::new();
        for (server_id, track_id) in ids {
            let sid = server_id.trim();
            let tid = track_id.trim();
            if !tid.is_empty() {
                set.insert(priority_hint_key(sid, tid));
            }
        }
        *self
            .middle_track_ids
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = set;
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
            tauri::async_runtime::spawn(analysis_backfill_worker_loop(
                app,
                shared.clone(),
                wake_rx,
            ));
            shared.ping_worker();
            shared
        })
        .clone()
}

use crate::track_analysis_plan::plan_track_analysis;

#[derive(Debug, Clone, PartialEq, Eq)]
struct TrustedRevisionGeneration {
    revision: String,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedAnalysisRevision {
    pub md5_16kb: String,
    pub generation: u64,
    /// The analysis bytes are a server transcode whose original identity was
    /// established independently through the raw-prefix probe.
    pub analysis_bytes_transcoded: bool,
    /// Library `track.server_id` scope for `content_hash` repair when it differs
    /// from the analysis-cache scope (offline dual-address/library paths).
    pub content_hash_server_id: Option<String>,
}

#[derive(Default)]
struct TrustedActivationState {
    current_by_track: HashMap<String, TrustedRevisionGeneration>,
}

impl TrustedActivationState {
    fn register(&mut self, key: String, revision: &str, generation: u64) -> u64 {
        if let Some(current) = self.current_by_track.get(&key) {
            if current.revision == revision {
                return current.generation;
            }
            if current.generation > generation {
                return generation;
            }
        }
        self.current_by_track.insert(
            key,
            TrustedRevisionGeneration {
                revision: revision.to_string(),
                generation,
            },
        );
        generation
    }
}

static TRUSTED_ACTIVATION_GENERATION: AtomicU64 = AtomicU64::new(0);
static TRUSTED_ACTIVATIONS: OnceLock<Mutex<TrustedActivationState>> = OnceLock::new();
type TrustedAnalysisFetchWaiter = tokio::sync::oneshot::Sender<()>;
static TRUSTED_ANALYSIS_FETCHES: OnceLock<
    Mutex<HashMap<String, Vec<TrustedAnalysisFetchWaiter>>>,
> = OnceLock::new();

#[derive(Debug)]
pub struct TrustedAnalysisFetchPermit {
    key: String,
    waited: bool,
}

impl TrustedAnalysisFetchPermit {
    pub fn waited(&self) -> bool {
        self.waited
    }
}

impl Drop for TrustedAnalysisFetchPermit {
    fn drop(&mut self) {
        let waiters = TRUSTED_ANALYSIS_FETCHES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.key)
            .unwrap_or_default();
        for waiter in waiters {
            let _ = waiter.send(());
        }
    }
}

pub async fn reserve_trusted_analysis_fetch(
    server_id: &str,
    track_id: &str,
    revision: &str,
) -> TrustedAnalysisFetchPermit {
    let canonical_track_id = track_id.strip_prefix("stream:").unwrap_or(track_id);
    let key = seed_revision_key(server_id, canonical_track_id, revision);
    let mut waited = false;
    loop {
        let receiver = {
            let mut reservations = TRUSTED_ANALYSIS_FETCHES
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(waiters) = reservations.get_mut(&key) {
                let (sender, receiver) = tokio::sync::oneshot::channel();
                waiters.push(sender);
                Some(receiver)
            } else {
                reservations.insert(key.clone(), Vec::new());
                return TrustedAnalysisFetchPermit { key, waited };
            }
        };
        let _ = receiver.expect("occupied fetch must provide a waiter").await;
        waited = true;
    }
}

fn canonical_activation_key(server_id: &str, track_id: &str) -> String {
    let canonical_track_id = track_id.strip_prefix("stream:").unwrap_or(track_id);
    seed_key(server_id, canonical_track_id)
}

fn next_trusted_generation() -> u64 {
    TRUSTED_ACTIVATION_GENERATION.fetch_add(1, Ordering::Relaxed) + 1
}

fn register_trusted_revision_generation(
    server_id: &str,
    track_id: &str,
    revision: &str,
    generation: u64,
) -> u64 {
    let key = canonical_activation_key(server_id, track_id);
    let mut state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    state.register(key, revision, generation)
}

#[cfg(test)]
fn trusted_revision_generation_is_current(
    server_id: &str,
    track_id: &str,
    revision: &str,
    generation: u64,
) -> bool {
    let key = canonical_activation_key(server_id, track_id);
    TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .current_by_track
        .get(&key)
        .is_some_and(|current| {
            current.revision == revision && current.generation == generation
        })
}

pub fn begin_trusted_revision(server_id: &str, track_id: &str, revision: &str) -> u64 {
    let key = canonical_activation_key(server_id, track_id);
    let mut state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(current) = state.current_by_track.get(&key) {
        if current.revision == revision {
            return current.generation;
        }
    }
    let generation = next_trusted_generation();
    state.current_by_track.insert(
        key,
        TrustedRevisionGeneration {
            revision: revision.to_string(),
            generation,
        },
    );
    generation
}

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
    enqueue_track_analysis_with_fetch(
        app,
        server_id,
        track_id,
        Cow::Borrowed(bytes),
        format_hint,
        None,
        priority,
        0,
        None,
    )
    .await
}

/// Activate a trusted revision only while it is still the latest registered
/// revision for the canonical `(server, track)`. The guard remains locked
/// across content-hash repair and variant purge so reverse completions cannot
/// interleave their destructive activation steps.
fn activate_trusted_identity<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cache_server_id: &str,
    content_hash_server_id: &str,
    track_id: &str,
    content_hash: &str,
    generation: u64,
) -> bool {
    if cache_server_id.is_empty() {
        return false;
    }
    let activation_key = canonical_activation_key(cache_server_id, track_id);
    let state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let current = state.current_by_track.get(&activation_key);
    let is_current = current.is_some_and(|current| {
        current.revision == content_hash && current.generation == generation
    });

    let key = analysis_cache::TrackKey {
        server_id: cache_server_id.to_string(),
        track_id: track_id.to_string(),
        md5_16kb: content_hash.to_string(),
    };
    if !is_current {
        let superseded_by_other_revision =
            current.is_some_and(|current| current.revision != content_hash);
        if superseded_by_other_revision {
            if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
                match cache.delete_fingerprint(&key) {
                    Ok(n) if n > 0 => crate::app_deprintln!(
                        "[analysis] discarded {n} stale trusted rows track_id={track_id} hash={content_hash}"
                    ),
                    Ok(_) => {}
                    Err(e) => {
                        crate::app_eprintln!("[analysis] stale trusted cleanup failed: {e}")
                    }
                }
            }
        }
        return false;
    }

    if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
        match cache.delete_other_fingerprints(&key) {
            Ok(n) if n > 0 => crate::app_deprintln!(
                "[analysis] trusted activation purged {n} stale fingerprint rows track_id={track_id}"
            ),
            Ok(_) => {}
            Err(e) => {
                crate::app_eprintln!("[analysis] trusted activation purge failed: {e}");
                return false;
            }
        }
    }
    if let Some(sink) = app.try_state::<psysonic_core::ports::ContentHashSink>() {
        sink.record_content_hash(content_hash_server_id, track_id, content_hash);
    }
    true
}

fn activate_trusted_enrichment<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cache_server_id: &str,
    content_hash_server_id: &str,
    track_id: &str,
    content_hash: &str,
    generation: u64,
    outcome: TrackEnrichmentOutcome,
) -> bool {
    if matches!(
        outcome,
        TrackEnrichmentOutcome::Failed | TrackEnrichmentOutcome::SkippedSuperseded
    ) {
        return false;
    }
    activate_trusted_identity(
        app,
        cache_server_id,
        content_hash_server_id,
        track_id,
        content_hash,
        generation,
    )
}

pub(crate) fn commit_trusted_enrichment_if_current<T>(
    server_id: &str,
    track_id: &str,
    content_hash: &str,
    generation: u64,
    commit: impl FnOnce() -> T,
) -> Option<T> {
    let activation_key = canonical_activation_key(server_id, track_id);
    let state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let is_current = state
        .current_by_track
        .get(&activation_key)
        .is_some_and(|current| {
            current.revision == content_hash && current.generation == generation
        });
    is_current.then(commit)
}

/// Like [`enqueue_track_analysis`] but with a verified original fingerprint.
/// Original bytes are prefix-verified; an explicitly marked server transcode
/// is analysed under the separately verified original identity.
pub async fn enqueue_track_analysis_trusted(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    format_hint: Option<&str>,
    trusted_revision: TrustedAnalysisRevision,
    priority: AnalysisBackfillPriority,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    enqueue_track_analysis_with_fetch(
        app,
        server_id,
        track_id,
        Cow::Borrowed(bytes),
        format_hint,
        Some(trusted_revision),
        priority,
        0,
        None,
    )
    .await
}

/// Owned-byte variant for completed playback captures. Large spill files can
/// enter the CPU queue without cloning the complete track a second time.
pub async fn enqueue_track_analysis_trusted_owned(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: Vec<u8>,
    format_hint: Option<&str>,
    trusted_revision: TrustedAnalysisRevision,
    priority: AnalysisBackfillPriority,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    enqueue_track_analysis_with_fetch(
        app,
        server_id,
        track_id,
        Cow::Owned(bytes),
        format_hint,
        Some(trusted_revision),
        priority,
        0,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn enqueue_track_analysis_with_fetch(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: Cow<'_, [u8]>,
    format_hint: Option<&str>,
    trusted_revision: Option<TrustedAnalysisRevision>,
    priority: AnalysisBackfillPriority,
    fetch_ms: u64,
    cpu_admitted: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    if bytes.is_empty() {
        return Ok(EnqueueTrackAnalysisOutcome::Complete);
    }
    if let Some(trusted) = trusted_revision
        .as_ref()
        .filter(|trusted| !trusted.analysis_bytes_transcoded)
    {
        if !crate::raw_probe::bytes_match_trusted(bytes.as_ref(), &trusted.md5_16kb) {
            return Err("trusted original fingerprint does not match analysis bytes".to_string());
        }
    }
    // Trusted-original identity wins: planning against it reuses an existing
    // complete result for the original.
    let content_hash = trusted_revision
        .as_ref()
        .map(|trusted| trusted.md5_16kb.clone())
        .unwrap_or_else(|| analysis_cache::md5_first_16kb(bytes.as_ref()));
    let plan = plan_track_analysis(app, server_id, track_id, &content_hash);
    if !plan.any() {
        crate::app_deprintln!(
            "[analysis] track complete track_id={} hash={}",
            track_id,
            content_hash
        );
        if let Some(trusted) = trusted_revision.as_ref() {
            let content_hash_server_id = trusted
                .content_hash_server_id
                .as_deref()
                .unwrap_or(server_id);
            activate_trusted_identity(
                app,
                server_id,
                content_hash_server_id,
                track_id,
                &content_hash,
                trusted.generation,
            );
        }
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
            bytes.into_owned(),
            format_hint.map(str::to_string),
            trusted_revision,
            priority,
            fetch_ms,
            cpu_admitted,
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
        let trusted_guard = trusted_revision
            .as_ref()
            .map(|trusted| (server_id.to_string(), trusted.generation));
        let outcome = run_track_enrichment_from_owned_bytes(
            app,
            server_id,
            track_id,
            bytes.into_owned(),
            Some(content_hash.clone()),
            trusted_guard,
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
        if let Some(trusted) = trusted_revision.as_ref() {
            let content_hash_server_id = trusted
                .content_hash_server_id
                .as_deref()
                .unwrap_or(server_id);
            activate_trusted_enrichment(
                app,
                server_id,
                content_hash_server_id,
                track_id,
                &content_hash,
                trusted.generation,
                outcome,
            );
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
    trusted_md5_16kb: Option<String>,
    notify_ui: bool,
) -> TrackEnrichmentOutcome {
    run_track_enrichment_from_owned_bytes(
        app,
        server_id,
        track_id,
        bytes.to_vec(),
        trusted_md5_16kb,
        None,
        notify_ui,
    )
    .await
}

async fn run_track_enrichment_from_owned_bytes(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    data: Vec<u8>,
    trusted_md5_16kb: Option<String>,
    trusted_guard: Option<(String, u64)>,
    notify_ui: bool,
) -> TrackEnrichmentOutcome {
    if server_id.is_empty() {
        return TrackEnrichmentOutcome::SkippedNoServer;
    }
    let app = app.clone();
    let sid = server_id.to_string();
    let tid = track_id.to_string();
    match tokio::task::spawn_blocking(move || {
        crate::track_enrichment::run_track_enrichment_if_needed(
            &app,
            &sid,
            &tid,
            &data,
            trusted_md5_16kb.as_deref(),
            trusted_guard
                .as_ref()
                .map(|(server_id, generation)| (server_id.as_str(), *generation)),
            notify_ui,
        )
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
    enqueue_track_analysis(
        app,
        server_id,
        track_id,
        &bytes,
        format_hint.as_deref(),
        priority,
    )
    .await
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
    verified_original: bool,
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
    let trusted_revision = verified_original.then(|| TrustedAnalysisRevision {
        md5_16kb: content_hash.clone(),
        generation: begin_trusted_revision(server_index_key, track_id, &content_hash),
        analysis_bytes_transcoded: false,
        content_hash_server_id: Some(library_server_id.to_string()),
    });
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
        if let Some(trusted) = trusted_revision.as_ref() {
            activate_trusted_identity(
                app,
                server_index_key,
                trusted
                    .content_hash_server_id
                    .as_deref()
                    .unwrap_or(server_index_key),
                track_id,
                &trusted.md5_16kb,
                trusted.generation,
            );
        }
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
        trusted_revision,
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
    trusted_revision: Option<TrustedAnalysisRevision>,
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
            args.trusted_revision,
            args.priority,
            args.fetch_ms,
            None,
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
        let trusted_guard = args
            .trusted_revision
            .as_ref()
            .map(|trusted| (args.cache_server_id.to_string(), trusted.generation));
        let outcome = run_track_enrichment_from_owned_bytes(
            args.app,
            args.enrichment_server_id,
            args.track_id,
            args.bytes.to_vec(),
            Some(content_hash.clone()),
            trusted_guard,
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
        if let Some(trusted) = args.trusted_revision.as_ref() {
            activate_trusted_enrichment(
                args.app,
                args.cache_server_id,
                trusted
                    .content_hash_server_id
                    .as_deref()
                    .unwrap_or(args.cache_server_id),
                args.track_id,
                &trusted.md5_16kb,
                trusted.generation,
                outcome,
            );
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

const ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES: usize = 64 * 1024 * 1024;
const ANALYSIS_SOURCE_UNAVAILABLE_REVISION: &str = "source-unavailable";

#[derive(Debug, Clone, PartialEq, Eq)]
enum AnalysisBackfillJobError {
    Terminal(String),
    Retryable(String),
    Superseded,
}

impl std::fmt::Display for AnalysisBackfillJobError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Terminal(message) | Self::Retryable(message) => formatter.write_str(message),
            Self::Superseded => formatter.write_str("superseded by newer analysis work"),
        }
    }
}

impl AnalysisBackfillJobError {
    fn is_retryable(&self) -> bool {
        matches!(self, Self::Retryable(_))
    }

    fn is_superseded(&self) -> bool {
        matches!(self, Self::Superseded)
    }
}

fn source_unavailable_failure<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    server_id: &str,
    track_id: &str,
    error: &crate::raw_probe::SubsonicStreamError,
    generation: u64,
) -> AnalysisBackfillJobError {
    crate::app_deprintln!(
        "[analysis][backfill] source unavailable track_id={track_id} code={} reason={}",
        error.code,
        error.diagnostic_reason(),
    );
    let activation_key = canonical_activation_key(server_id, track_id);
    let mut activation_state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let effective_generation = activation_state.register(
        activation_key.clone(),
        ANALYSIS_SOURCE_UNAVAILABLE_REVISION,
        generation,
    );
    let is_current = activation_state
        .current_by_track
        .get(&activation_key)
        .is_some_and(|current| {
            current.revision == ANALYSIS_SOURCE_UNAVAILABLE_REVISION
                && current.generation == effective_generation
        });
    if !is_current {
        return AnalysisBackfillJobError::Superseded;
    }
    let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() else {
        return AnalysisBackfillJobError::Retryable(format!(
            "analysis source unavailable (Subsonic code {}), but analysis cache is unavailable",
            error.code
        ));
    };
    let key = analysis_cache::TrackKey {
        server_id: server_id.to_string(),
        track_id: track_id.to_string(),
        md5_16kb: ANALYSIS_SOURCE_UNAVAILABLE_REVISION.to_string(),
    };
    match cache.touch_track_status(&key, "failed") {
        Ok(()) => AnalysisBackfillJobError::Terminal(format!(
            "analysis source unavailable (Subsonic code {}, reason={})",
            error.code,
            error.diagnostic_reason(),
        )),
        Err(cache_error) => AnalysisBackfillJobError::Retryable(format!(
            "analysis source unavailable (Subsonic code {}), but failed to record it: {cache_error}",
            error.code
        )),
    }
}

async fn probe_backfill_trusted_identity<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    registry: Option<&ServerHttpRegistry>,
    server_id: &str,
    track_id: &str,
    url: &str,
    generation: u64,
) -> Result<Option<String>, AnalysisBackfillJobError> {
    match crate::raw_probe::probe_trusted_original_md5(
        analysis_http_client(),
        registry,
        Some(server_id),
        url,
    )
    .await
    {
        crate::raw_probe::TrustedOriginalProbeResult::Trusted(hash) => Ok(Some(hash)),
        crate::raw_probe::TrustedOriginalProbeResult::SubsonicError(error)
            if error.is_source_unavailable() =>
        {
            Err(source_unavailable_failure(
                app, server_id, track_id, &error, generation,
            ))
        }
        crate::raw_probe::TrustedOriginalProbeResult::SubsonicError(error) => {
            crate::app_deprintln!(
                "[analysis][backfill] raw identity probe rejected track_id={track_id} code={} reason={}",
                error.code,
                error.diagnostic_reason(),
            );
            Ok(None)
        }
        crate::raw_probe::TrustedOriginalProbeResult::Unavailable => Ok(None),
    }
}

fn analysis_stream_format_hint(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()?
        .query_pairs()
        .find_map(|(key, value)| (key == "format" && value != "raw").then(|| value.into_owned()))
}

#[derive(Debug)]
struct AnalysisBackfillDownload {
    bytes: Vec<u8>,
    fetch_ms: u64,
    format_hint: Option<String>,
    trusted_revision: Option<TrustedAnalysisRevision>,
    trusted_fetch_permit: Option<TrustedAnalysisFetchPermit>,
}

fn record_oversized_trusted_analysis<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    server_id: &str,
    track_id: &str,
    trusted_md5_16kb: &str,
    generation: u64,
) -> Result<(), AnalysisBackfillJobError> {
    let activation_key = canonical_activation_key(server_id, track_id);
    let state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !state
        .current_by_track
        .get(&activation_key)
        .is_some_and(|current| {
            current.revision == trusted_md5_16kb && current.generation == generation
        })
    {
        return Ok(());
    }
    let cache = app
        .try_state::<analysis_cache::AnalysisCache>()
        .ok_or_else(|| {
            AnalysisBackfillJobError::Retryable(
                "analysis cache unavailable while recording oversized analysis input".to_string(),
            )
        })?;
    let key = analysis_cache::TrackKey {
        server_id: server_id.to_string(),
        track_id: track_id.to_string(),
        md5_16kb: trusted_md5_16kb.to_string(),
    };
    cache.touch_track_status(&key, "failed").map_err(|error| {
        AnalysisBackfillJobError::Retryable(format!(
            "failed to record oversized analysis input: {error}"
        ))
    })
}

async fn analysis_backfill_download<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    server_id: &str,
    track_id: &str,
    url: &str,
    max_bytes: usize,
) -> Result<AnalysisBackfillDownload, AnalysisBackfillJobError> {
    let operation_generation = next_trusted_generation();
    let mut effective_generation = operation_generation;
    let registry = app
        .try_state::<Arc<ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));
    let raw_supported =
        crate::raw_probe::raw_stream_supported(registry.as_deref(), Some(server_id), url);
    let mut trusted = if raw_supported {
        match probe_backfill_trusted_identity(
            app,
            registry.as_deref(),
            server_id,
            track_id,
            url,
            operation_generation,
        )
        .await
        {
            Ok(Some(hash)) => {
                effective_generation = register_trusted_revision_generation(
                    server_id,
                    track_id,
                    &hash,
                    operation_generation,
                );
                Some(hash)
            }
            Ok(None) => {
                crate::app_deprintln!(
                    "[analysis] raw identity probe unavailable track_id={track_id}; falling back to original download"
                );
                None
            }
            Err(error) => return Err(error),
        }
    } else {
        None
    };

    let fetch_started = std::time::Instant::now();
    if let Some(initial_trusted_md5_16kb) = trusted.clone() {
        let transcode_result = crate::raw_probe::fetch_bounded_stream_bytes(
            analysis_http_client(),
            registry.as_deref(),
            Some(server_id),
            url,
            max_bytes,
        )
        .await;
        let revalidated = probe_backfill_trusted_identity(
            app,
            registry.as_deref(),
            server_id,
            track_id,
            url,
            operation_generation,
        )
        .await;
        match revalidated {
            Ok(Some(hash)) => {
                effective_generation = register_trusted_revision_generation(
                    server_id,
                    track_id,
                    &hash,
                    operation_generation,
                );
                let unchanged = hash == initial_trusted_md5_16kb;
                trusted = Some(hash.clone());
                if unchanged {
                    match transcode_result {
                        Ok(bytes) => {
                            return Ok(AnalysisBackfillDownload {
                                bytes,
                                fetch_ms: fetch_started.elapsed().as_millis() as u64,
                                format_hint: analysis_stream_format_hint(url),
                                trusted_revision: Some(TrustedAnalysisRevision {
                                    md5_16kb: hash,
                                    generation: effective_generation,
                                    analysis_bytes_transcoded: true,
                                    content_hash_server_id: None,
                                }),
                                trusted_fetch_permit: None,
                            });
                        }
                        Err(crate::raw_probe::BoundedStreamFetchError::TooLarge { .. }) => {
                            record_oversized_trusted_analysis(
                                app,
                                server_id,
                                track_id,
                                &hash,
                                effective_generation,
                            )?;
                            return Err(AnalysisBackfillJobError::Terminal(format!(
                                "analysis transcode exceeds cap of {max_bytes} bytes"
                            )));
                        }
                        Err(error) => {
                            crate::app_deprintln!(
                                "[analysis] transcode unavailable track_id={track_id}: {error}; falling back to original download"
                            );
                        }
                    }
                } else {
                    crate::app_deprintln!(
                        "[analysis] original changed during transcode fetch track_id={track_id}; falling back to original download"
                    );
                }
            }
            Ok(None) => {
                trusted = None;
                crate::app_deprintln!(
                    "[analysis] raw identity revalidation unavailable track_id={track_id}; falling back to original download"
                );
            }
            Err(error) => return Err(error),
        }
    }

    let download_url = crate::raw_probe::build_original_download_url(url).ok_or_else(|| {
        AnalysisBackfillJobError::Retryable(
            "original download endpoint unavailable for analysis fallback".to_string(),
        )
    })?;
    let trusted_fetch_permit = if let Some(revision) = trusted.as_deref() {
        let permit = reserve_trusted_analysis_fetch(server_id, track_id, revision).await;
        if permit.waited()
            && (analysis_revision_in_cpu_pipeline(server_id, track_id, revision)
                || !crate::track_analysis_plan::plan_track_analysis(
                    app, server_id, track_id, revision,
                )
                .any())
        {
            return Err(AnalysisBackfillJobError::Superseded);
        }
        Some(permit)
    } else {
        None
    };
    let bytes = match crate::raw_probe::fetch_bounded_stream_bytes(
        analysis_http_client(),
        registry.as_deref(),
        Some(server_id),
        &download_url,
        max_bytes,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(crate::raw_probe::BoundedStreamFetchError::TooLarge { md5_16kb }) => {
            if trusted
                .as_deref()
                .is_some_and(|trusted_md5_16kb| trusted_md5_16kb != md5_16kb)
            {
                return Err(AnalysisBackfillJobError::Retryable(
                    "oversized original download does not match raw-probed identity".to_string(),
                ));
            }
            let original_md5_16kb = trusted.as_deref().unwrap_or(&md5_16kb);
            if trusted.is_none() {
                effective_generation = register_trusted_revision_generation(
                    server_id,
                    track_id,
                    original_md5_16kb,
                    operation_generation,
                );
            }
            record_oversized_trusted_analysis(
                app,
                server_id,
                track_id,
                original_md5_16kb,
                effective_generation,
            )?;
            return Err(AnalysisBackfillJobError::Terminal(format!(
                "original download exceeds analysis cap of {max_bytes} bytes"
            )));
        }
        Err(crate::raw_probe::BoundedStreamFetchError::SubsonicApi(error))
            if error.is_source_unavailable() =>
        {
            return Err(source_unavailable_failure(
                app,
                server_id,
                track_id,
                &error,
                operation_generation,
            ));
        }
        Err(error) => {
            let message = format!("original download unavailable: {error}");
            return Err(if error.is_permanent_http() {
                AnalysisBackfillJobError::Terminal(message)
            } else {
                AnalysisBackfillJobError::Retryable(message)
            });
        }
    };
    if let Some(trusted_md5_16kb) = trusted.as_deref() {
        if !crate::raw_probe::bytes_match_trusted(&bytes, trusted_md5_16kb) {
            return Err(AnalysisBackfillJobError::Retryable(
                "original download does not match raw-probed identity".to_string(),
            ));
        }
    }
    let md5_16kb = trusted.unwrap_or_else(|| analysis_cache::md5_first_16kb(&bytes));
    effective_generation = register_trusted_revision_generation(
        server_id,
        track_id,
        &md5_16kb,
        operation_generation,
    );
    let trusted_revision = Some(TrustedAnalysisRevision {
        generation: effective_generation,
        md5_16kb,
        analysis_bytes_transcoded: false,
        content_hash_server_id: None,
    });
    Ok(AnalysisBackfillDownload {
        bytes,
        fetch_ms: fetch_started.elapsed().as_millis() as u64,
        format_hint: None,
        trusted_revision,
        trusted_fetch_permit,
    })
}

async fn process_analysis_backfill_job(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    url: &str,
    cpu_admitted: tokio::sync::oneshot::Sender<()>,
) -> Result<bool, AnalysisBackfillJobError> {
    let download = analysis_backfill_download(
        app,
        server_id,
        track_id,
        url,
        ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
    )
    .await?;
    let priority = analysis_backfill_resolve_priority(app, server_id, track_id, None);
    let AnalysisBackfillDownload {
        bytes,
        fetch_ms,
        format_hint,
        trusted_revision,
        trusted_fetch_permit,
    } = download;
    let outcome = enqueue_track_analysis_with_fetch(
        app,
        server_id,
        track_id,
        Cow::Owned(bytes),
        format_hint.as_deref(),
        trusted_revision,
        priority,
        fetch_ms,
        Some(cpu_admitted),
    )
    .await
    .map_err(AnalysisBackfillJobError::Retryable);
    drop(trusted_fetch_permit);
    let outcome = outcome?;
    Ok(!matches!(outcome, EnqueueTrackAnalysisOutcome::Complete))
}

fn release_backfill_reservation(
    shared: &AnalysisBackfillShared,
    server_id: &str,
    track_id: &str,
    finish: AnalysisBackfillFinish,
) {
    {
        let mut state = shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.finish_job(&seed_key(server_id, track_id), finish);
    }
    shared.ping_worker();
}

fn mark_backfill_cpu_admitted(shared: &AnalysisBackfillShared, server_id: &str, track_id: &str) {
    {
        let mut state = shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.mark_cpu_admitted(&seed_key(server_id, track_id));
    }
    shared.ping_worker();
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

/// Decide whether the HTTP backfill worker should idle right now. Active HTTP
/// downloads reserve their prospective CPU-buffer slots before another job is
/// popped. High-tier work gets one slot beyond the ordinary cap.
fn should_idle_for_cpu_backpressure(
    cpu_load: usize,
    http_active: usize,
    cpu_cap: usize,
    high_pending: bool,
) -> bool {
    let admission_cap = cpu_cap.saturating_add(usize::from(high_pending));
    cpu_load.saturating_add(http_active) >= admission_cap
}

async fn spawn_backfill_slots(app: &tauri::AppHandle, shared: &Arc<AnalysisBackfillShared>) {
    loop {
        let max = shared.max_parallel();
        // Backpressure against the CPU-seed pipeline: downloaded track bytes
        // (Vec<u8>, tens of MB for FLAC) sit in `AnalysisCpuSeedJob.bytes` until
        // Symphonia decode + R128 finish — much slower than HTTP. Without a cap,
        // aggressive library backfill on large libraries grows RAM unbounded.
        // High-tier (now-playing) jobs get one reserved slot beyond the normal
        // cap, but cannot grow an unbounded backlog during rapid track skips.
        let cpu_load = cpu_seed_pipeline_load();
        let cpu_cap = cpu_seed_pipeline_cap(max);
        let job_bundle = {
            let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            st.try_pop_next_with_cpu_backpressure(max, cpu_load, cpu_cap)
                .map(|job| {
                    let worker_slot = st.in_progress.len();
                    (job, worker_slot)
                })
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
            // Keep the HTTP reservation through capability/provenance checks,
            // the full raw fetch, and CPU queue admission. Releasing it earlier
            // allows a duplicate full download before the CPU queue sees the job.
            let (cpu_admitted_tx, cpu_admitted_rx) = tokio::sync::oneshot::channel();
            let process =
                process_analysis_backfill_job(&app, &server_id, &track_id, &url, cpu_admitted_tx);
            tokio::pin!(process);
            let result = tokio::select! {
                biased;
                result = &mut process => result,
                Ok(()) = cpu_admitted_rx => {
                    mark_backfill_cpu_admitted(&shared, &server_id, &track_id);
                    process.await
                }
            };
            release_backfill_reservation(
                &shared,
                &server_id,
                &track_id,
                match &result {
                    Ok(_) => AnalysisBackfillFinish::Success,
                    Err(error) if error.is_superseded() => AnalysisBackfillFinish::Success,
                    Err(error) if error.is_retryable() => {
                        AnalysisBackfillFinish::RetryableFailure
                    }
                    Err(_) => AnalysisBackfillFinish::TerminalFailure,
                },
            );

            match &result {
                Ok(has_loudness) => crate::app_deprintln!(
                    "[analysis] backfill worker={}/{}: ready track_id={} has_loudness={}",
                    worker_slot,
                    max,
                    track_id,
                    has_loudness
                ),
                Err(error) if error.is_superseded() => crate::app_deprintln!(
                    "[analysis] backfill worker={}/{}: skipped stale track_id={}",
                    worker_slot,
                    max,
                    track_id,
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
        shared.max_parallel.store(workers, Ordering::Relaxed);
        shared.ping_worker();
    }
    if let Some(shared) = ANALYSIS_CPU_SEED.get() {
        shared.max_parallel.store(workers, Ordering::Relaxed);
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

pub fn clear_analysis_backfill_failure_state(server_id: &str, track_ids: &[String]) {
    let Some(shared) = ANALYSIS_BACKFILL.get() else {
        return;
    };
    let mut state = shared
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    state.clear_failure_state(server_id, track_ids);
}

pub fn analysis_track_in_cpu_pipeline(server_id: &str, track_id: &str) -> bool {
    let tid = track_id.trim();
    if tid.is_empty() {
        return false;
    }
    let Some(shared) = ANALYSIS_CPU_SEED.get() else {
        return false;
    };
    // The cpu-seed maps are keyed by (server, track, revision) — match ANY
    // revision of this (server, track) pair.
    let prefix = format!("{}\u{1f}", seed_key(server_id, tid));
    let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if st.running.keys().any(|k| k.starts_with(&prefix)) {
        return true;
    }
    for tier in [
        AnalysisBackfillPriority::High,
        AnalysisBackfillPriority::Middle,
        AnalysisBackfillPriority::Low,
    ] {
        if st
            .tier_deque(tier)
            .iter()
            .any(|j| j.server_id == server_id && j.track_id == tid)
        {
            return true;
        }
    }
    false
}

pub fn analysis_revision_in_cpu_pipeline(
    server_id: &str,
    track_id: &str,
    revision: &str,
) -> bool {
    let tid = track_id.trim();
    if tid.is_empty() || revision.is_empty() {
        return false;
    }
    let Some(shared) = ANALYSIS_CPU_SEED.get() else {
        return false;
    };
    let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    st.contains_revision(server_id, tid, revision)
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
fn resolve_backfill_server_id(url: &str, server_id_hint: Option<&str>) -> String {
    if let Some(hint) = server_id_hint
        .map(str::trim)
        .filter(|hint| !hint.is_empty())
    {
        return hint.to_string();
    }
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return String::new();
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return String::new();
    }
    let host = parsed.host_str().unwrap_or_default();
    if host.is_empty() {
        return String::new();
    }
    let mut base_path = parsed.path().to_string();
    if let Some(idx) = base_path.find("/rest") {
        base_path.truncate(idx);
    }
    while base_path.ends_with('/') {
        base_path.pop();
    }
    let mut base = host.to_string();
    if let Some(port) = parsed.port() {
        base.push_str(&format!(":{port}"));
    }
    if !base_path.is_empty() {
        base.push_str(&base_path);
    }
    base
}

pub fn enqueue_seed_from_url(
    app: &tauri::AppHandle,
    track_id: &str,
    url: &str,
    server_id_hint: Option<&str>,
    explicit_priority: Option<AnalysisBackfillPriority>,
    force: bool,
) -> Result<EnqueueSeedFromUrlOutcome, String> {
    if track_id.trim().is_empty() || url.trim().is_empty() {
        return Ok(EnqueueSeedFromUrlOutcome::Skipped);
    }
    let server_id = resolve_backfill_server_id(url, server_id_hint);
    let is_http = url.starts_with("http://") || url.starts_with("https://");
    if is_http && crate::raw_probe::build_original_download_url(url).is_none() {
        crate::app_deprintln!(
            "[analysis] backfill unsupported track_id={track_id}: no original-download endpoint"
        );
        return Ok(EnqueueSeedFromUrlOutcome::Unsupported);
    }
    if !force {
        if let Some(playback) = app.try_state::<PlaybackQueryHandle>() {
            if playback.analysis_backfill_should_defer(track_id) {
                crate::app_deprintln!(
                    "[analysis] backfill skip track_id={} reason=playback_stream_will_seed",
                    track_id
                );
                return Ok(EnqueueSeedFromUrlOutcome::Skipped);
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
                    return Ok(EnqueueSeedFromUrlOutcome::Skipped);
                }
                if !track_analysis_needs_work(app, &server_id, track_id)? {
                    crate::app_deprintln!(
                        "[analysis] backfill skip (analysis complete): {}",
                        track_id
                    );
                    return Ok(EnqueueSeedFromUrlOutcome::Skipped);
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
        st.enqueue_with_force(
            server_id,
            track_id.to_string(),
            url.to_string(),
            resolved,
            force,
        )
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
            Ok(EnqueueSeedFromUrlOutcome::Enqueued)
        }
        AnalysisBackfillEnqueueKind::ReorderedHigher => {
            shared.ping_worker();
            crate::app_deprintln!(
                "[analysis] backfill bumped tier track_id={} priority={resolved:?}",
                tid_log,
            );
            Ok(EnqueueSeedFromUrlOutcome::Enqueued)
        }
        AnalysisBackfillEnqueueKind::DuplicateSkipped
        | AnalysisBackfillEnqueueKind::RunningSkipped => {
            Ok(EnqueueSeedFromUrlOutcome::AlreadyReserved)
        }
        AnalysisBackfillEnqueueKind::RetryDeferred => {
            crate::app_deprintln!(
                "[analysis] backfill retry deferred after transient failure: track_id={}",
                tid_log,
            );
            Ok(EnqueueSeedFromUrlOutcome::Skipped)
        }
        AnalysisBackfillEnqueueKind::TerminalSkipped => {
            crate::app_deprintln!(
                "[analysis] backfill deferred during terminal-failure cooldown: track_id={}",
                tid_log,
            );
            Ok(EnqueueSeedFromUrlOutcome::Skipped)
        }
    }
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
    /// Verified fingerprint of the ORIGINAL file associated with `bytes`.
    /// Advanced backfill may decode its explicit server transcode; `None`
    /// means the bytes own their identity (local/offline paths).
    trusted_revision: Option<TrustedAnalysisRevision>,
    /// Content revision this job represents: the trusted fingerprint when
    /// present, else the bytes' own fingerprint. Part of the dedup identity —
    /// a submission for a DIFFERENT revision of the same track must never be
    /// swallowed as a follower of a running job.
    revision: String,
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

/// Scope key for cpu-seed dedup/merge: same track id on different servers is
/// different content. `\u{1f}` cannot appear in server ids or Subsonic ids.
fn seed_key(server_id: &str, track_id: &str) -> String {
    format!("{server_id}\u{1f}{track_id}")
}

/// Full cpu-seed dedup identity: (server, track, content revision).
fn seed_revision_key(server_id: &str, track_id: &str, revision: &str) -> String {
    format!("{server_id}\u{1f}{track_id}\u{1f}{revision}")
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

    fn tier_deque_mut(
        &mut self,
        tier: AnalysisBackfillPriority,
    ) -> &mut VecDeque<AnalysisCpuSeedJob> {
        match tier {
            AnalysisBackfillPriority::High => &mut self.high,
            AnalysisBackfillPriority::Middle => &mut self.middle,
            AnalysisBackfillPriority::Low => &mut self.low,
        }
    }

    fn locate_queued(&self, key: &str) -> Option<(AnalysisBackfillPriority, usize)> {
        for tier in [
            AnalysisBackfillPriority::High,
            AnalysisBackfillPriority::Middle,
            AnalysisBackfillPriority::Low,
        ] {
            if let Some(pos) = self
                .tier_deque(tier)
                .iter()
                .position(|j| seed_revision_key(&j.server_id, &j.track_id, &j.revision) == key)
            {
                return Some((tier, pos));
            }
        }
        None
    }

    fn contains_revision(&self, server_id: &str, track_id: &str, revision: &str) -> bool {
        let key = seed_revision_key(server_id, track_id, revision);
        self.running.contains_key(&key) || self.locate_queued(&key).is_some()
    }

    fn push_new(&mut self, priority: AnalysisBackfillPriority, job: AnalysisCpuSeedJob) {
        match priority {
            AnalysisBackfillPriority::High => self.high.push_front(job),
            AnalysisBackfillPriority::Middle => self.middle.push_back(job),
            AnalysisBackfillPriority::Low => self.low.push_back(job),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn enqueue(
        &mut self,
        server_id: String,
        track_id: String,
        bytes: Vec<u8>,
        format_hint: Option<String>,
        trusted_revision: Option<TrustedAnalysisRevision>,
        priority: AnalysisBackfillPriority,
        fetch_ms: u64,
    ) -> (AnalysisCpuSeedEnqueueKind, SeedDoneReceiver) {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        // Dedup/merge scope is (server, track, content revision): the same
        // Subsonic id on two servers is two different files, and a different
        // revision of one track is different content — neither may share or
        // follow another job's decode.
        let revision = trusted_revision
            .as_ref()
            .map(|trusted| trusted.md5_16kb.clone())
            .unwrap_or_else(|| analysis_cache::md5_first_16kb(&bytes));
        let key = seed_revision_key(&server_id, &track_id, &revision);

        if let Some(followers) = self.running.get(&key) {
            followers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(done_tx);
            return (AnalysisCpuSeedEnqueueKind::RunningFollower, done_rx);
        }

        if let Some((existing_tier, pos)) = self.locate_queued(&key) {
            let mut job = self.tier_deque_mut(existing_tier).remove(pos).unwrap();
            let existing_transcode = job
                .trusted_revision
                .as_ref()
                .is_some_and(|trusted| trusted.analysis_bytes_transcoded);
            let incoming_transcode = trusted_revision
                .as_ref()
                .is_some_and(|trusted| trusted.analysis_bytes_transcoded);
            let replace_bytes = existing_transcode || !incoming_transcode;
            if replace_bytes {
                job.server_id = server_id;
                job.bytes = bytes;
                job.format_hint = format_hint;
                job.trusted_revision = trusted_revision;
                job.revision = revision;
                job.fetch_ms = fetch_ms;
            }
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
            trusted_revision,
            revision,
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
                let scoped =
                    server_id.is_some_and(|sid| job.server_id.is_empty() || job.server_id == sid);
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
                        "cpu-seed pruned: track no longer in playback queue".to_string()
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

    fn finish_running(&mut self, key: &str) -> Vec<SeedDoneSender> {
        self.running_tiers.remove(key);
        self.running
            .remove(key)
            .map(|followers| {
                followers
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .drain(..)
                    .collect()
            })
            .unwrap_or_default()
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
            tauri::async_runtime::spawn(analysis_cpu_seed_worker_loop(
                app,
                shared.clone(),
                wake_rx,
            ));
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
            queued_jobs, tiers.high, tiers.middle, tiers.low, decoding_count,
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
                    let run_key = seed_revision_key(&j.server_id, &j.track_id, &j.revision);
                    st.running.insert(run_key.clone(), followers.clone());
                    st.running_tiers.insert(run_key, job_priority);
                    let worker_slot = st.running.len();
                    (j, worker_slot)
                })
            }
        };
        let Some((job, worker_slot)) = job_bundle else {
            break;
        };
        let tid_log = job.track_id.clone();
        let run_key_log = seed_revision_key(&job.server_id, &job.track_id, &job.revision);
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
            let sid_for_event = sid.clone();
            let tid = job.track_id.clone();
            let tid_for_decode = tid.clone();
            let bytes = job.bytes;
            let format_hint = job.format_hint;
            let trusted_for_activation = job.trusted_revision.clone();
            let analysis_bytes_transcoded = job
                .trusted_revision
                .as_ref()
                .is_some_and(|trusted| trusted.analysis_bytes_transcoded);
            let trusted_md5_16kb = job
                .trusted_revision
                .as_ref()
                .map(|trusted| trusted.md5_16kb.clone());
            let trusted_generation = job
                .trusted_revision
                .as_ref()
                .map(|trusted| trusted.generation);
            let seed_result = tokio::task::spawn_blocking(move || {
                if analysis_bytes_transcoded {
                    let trusted = trusted_md5_16kb.as_deref().ok_or_else(|| {
                        "trusted analysis transcode missing original fingerprint".to_string()
                    })?;
                    analysis_cache::seed_transcoded_bytes_execute(
                        &app_for_decode,
                        &sid,
                        &tid_for_decode,
                        &bytes,
                        format_hint.as_deref(),
                        trusted,
                        trusted_generation.ok_or_else(|| {
                            "trusted analysis transcode missing generation".to_string()
                        })?,
                        notify_ui,
                    )
                } else {
                    analysis_cache::seed_from_bytes_execute(
                        &app_for_decode,
                        &sid,
                        &tid_for_decode,
                        &bytes,
                        format_hint.as_deref(),
                        trusted_md5_16kb.as_deref(),
                        trusted_generation,
                        notify_ui,
                    )
                }
            })
            .await
            .unwrap_or_else(|e| Err(format!("cpu-seed spawn_blocking: {e}")));

            if let (Some(trusted), Ok((outcome, _))) =
                (trusted_for_activation.as_ref(), seed_result.as_ref())
            {
                if matches!(
                    outcome,
                    analysis_cache::SeedFromBytesOutcome::Upserted
                        | analysis_cache::SeedFromBytesOutcome::SkippedWaveformCacheHit
                ) {
                    activate_trusted_identity(
                        &app_for_events,
                        &sid_for_event,
                        trusted
                            .content_hash_server_id
                            .as_deref()
                            .unwrap_or(&sid_for_event),
                        &tid,
                        &trusted.md5_16kb,
                        trusted.generation,
                    );
                }
            }

            let mut extra = {
                let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                st.finish_running(&run_key_log)
            };
            for tx in job.waiters {
                let _ = tx.send(seed_result.clone());
            }
            for tx in extra.drain(..) {
                let _ = tx.send(seed_result.clone());
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
                                server_index_key: sid_for_event,
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
#[allow(clippy::too_many_arguments)]
async fn submit_analysis_cpu_seed(
    app: tauri::AppHandle,
    server_id: String,
    track_id: String,
    bytes: Vec<u8>,
    format_hint: Option<String>,
    trusted_revision: Option<TrustedAnalysisRevision>,
    priority: AnalysisBackfillPriority,
    fetch_ms: u64,
    cpu_admitted: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<analysis_cache::SeedFromBytesOutcome, String> {
    let shared = analysis_cpu_seed_shared(&app);
    let rx = {
        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let (kind, rx) = st.enqueue(
            server_id,
            track_id.clone(),
            bytes,
            format_hint,
            trusted_revision,
            priority,
            fetch_ms,
        );
        crate::app_deprintln!("[analysis] cpu-seed submit: kind={kind:?} priority={priority:?}");
        drop(st);
        shared.ping_worker();
        if let Some(admitted) = cpu_admitted {
            let _ = admitted.send(());
        }
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

    fn trusted_revision(md5_16kb: &str, generation: u64) -> Option<TrustedAnalysisRevision> {
        Some(TrustedAnalysisRevision {
            md5_16kb: md5_16kb.to_string(),
            generation,
            analysis_bytes_transcoded: false,
            content_hash_server_id: None,
        })
    }

    fn trusted_transcode_revision(
        md5_16kb: &str,
        generation: u64,
    ) -> Option<TrustedAnalysisRevision> {
        Some(TrustedAnalysisRevision {
            md5_16kb: md5_16kb.to_string(),
            generation,
            analysis_bytes_transcoded: true,
            content_hash_server_id: None,
        })
    }

    struct RawOriginalResponder {
        body: Vec<u8>,
    }

    impl wiremock::Respond for RawOriginalResponder {
        fn respond(&self, request: &wiremock::Request) -> wiremock::ResponseTemplate {
            if request
                .headers
                .get(reqwest::header::RANGE.as_str())
                .is_some()
            {
                let end = self
                    .body
                    .len()
                    .saturating_sub(1)
                    .min(crate::raw_probe::RAW_PROBE_RANGE_END as usize);
                return wiremock::ResponseTemplate::new(206)
                    .insert_header(
                        "Content-Range",
                        format!("bytes 0-{end}/{}", self.body.len()).as_str(),
                    )
                    .set_body_bytes(self.body[..=end].to_vec());
            }
            wiremock::ResponseTemplate::new(200).set_body_bytes(self.body.clone())
        }
    }

    struct ChangingRawOriginalResponder {
        first: Vec<u8>,
        later: Vec<u8>,
        requests: Arc<AtomicUsize>,
    }

    impl wiremock::Respond for ChangingRawOriginalResponder {
        fn respond(&self, request: &wiremock::Request) -> wiremock::ResponseTemplate {
            let body = if self.requests.fetch_add(1, Ordering::Relaxed) == 0 {
                &self.first
            } else {
                &self.later
            };
            if request
                .headers
                .get(reqwest::header::RANGE.as_str())
                .is_some()
            {
                let end = body
                    .len()
                    .saturating_sub(1)
                    .min(crate::raw_probe::RAW_PROBE_RANGE_END as usize);
                return wiremock::ResponseTemplate::new(206)
                    .insert_header(
                        "Content-Range",
                        format!("bytes 0-{end}/{}", body.len()).as_str(),
                    )
                    .set_body_bytes(body[..=end].to_vec());
            }
            wiremock::ResponseTemplate::new(200).set_body_bytes(body.clone())
        }
    }

    fn analysis_registry(endpoint: &str, supports_raw_stream: bool) -> ServerHttpRegistry {
        use psysonic_core::server_http::{
            EndpointKind, ServerHttpContextSyncWire, ServerHttpEndpointWire,
        };

        let registry = ServerHttpRegistry::new();
        registry.sync(ServerHttpContextSyncWire {
            server_id: "canonical-server".into(),
            app_server_id: "profile-id".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: endpoint.into(),
                kind: EndpointKind::Public,
            }],
            custom_headers: Vec::new(),
            custom_headers_apply_to: None,
            supports_raw_stream,
        });
        registry
    }

    #[tokio::test]
    async fn backfill_probes_original_then_downloads_bounded_transcode() {
        use tauri::Manager;
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer};

        let server = MockServer::start().await;
        let mut original = vec![0x66; 24 * 1024];
        original[..4].copy_from_slice(b"fLaC");
        let transcode = vec![0x55; 12 * 1024];
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "raw"))
            .respond_with(RawOriginalResponder {
                body: original.clone(),
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "mp3"))
            .and(query_param("maxBitRate", "64"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(transcode.clone()))
            .mount(&server)
            .await;

        let registry = analysis_registry(&server.uri(), true);
        let app = tauri::test::mock_app();
        app.handle().manage(Arc::new(registry));
        app.handle()
            .manage(analysis_cache::AnalysisCache::open_in_memory());
        let stream_url = format!(
            "{}/rest/stream.view?id=t1&format=mp3&maxBitRate=64",
            server.uri()
        );
        assert_eq!(
            analysis_stream_format_hint(&stream_url).as_deref(),
            Some("mp3")
        );

        let download = analysis_backfill_download(
            app.handle(),
            "canonical-server",
            "t1",
            &stream_url,
            ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
        )
        .await
        .unwrap();

        assert_eq!(download.bytes, transcode);
        let trusted = download.trusted_revision.unwrap();
        assert_eq!(trusted.md5_16kb, analysis_cache::md5_first_16kb(&original));
        assert!(trusted.analysis_bytes_transcoded);
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 3, "raw probe before and after transcode");
        assert_eq!(
            requests
                .iter()
                .filter(|request| request
                    .url
                    .query_pairs()
                    .any(|(key, value)| { key == "format" && value == "raw" }))
                .count(),
            2
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request
                    .url
                    .query_pairs()
                    .any(|(key, value)| { key == "format" && value == "mp3" }))
                .count(),
            1
        );
        assert!(requests.iter().all(|request| !request
            .url
            .query_pairs()
            .any(|(key, _)| key == "estimateContentLength")));

        let oversized = analysis_backfill_download(
            app.handle(),
            "canonical-server",
            "oversized-transcode",
            &stream_url,
            8 * 1024,
        )
        .await;
        assert_eq!(
            oversized.unwrap_err(),
            AnalysisBackfillJobError::Terminal(
                "analysis transcode exceeds cap of 8192 bytes".to_string()
            )
        );
        let cache = app.handle().state::<analysis_cache::AnalysisCache>();
        assert_eq!(
            cache
                .get_latest_status_for_track("canonical-server", "oversized-transcode")
                .unwrap()
                .map(|(status, _)| status),
            Some("failed".to_string())
        );
    }

    #[tokio::test]
    async fn backfill_falls_back_to_original_download_when_transcode_fails() {
        use tauri::Manager;
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let mut original = vec![0x44; 24 * 1024];
        original[..4].copy_from_slice(b"fLaC");
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "raw"))
            .respond_with(RawOriginalResponder {
                body: original.clone(),
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "mp3"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/download.view"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(original.clone()))
            .mount(&server)
            .await;

        let app = tauri::test::mock_app();
        app.handle()
            .manage(Arc::new(analysis_registry(&server.uri(), true)));
        let stream_url = format!(
            "{}/rest/stream.view?id=t1&format=mp3&maxBitRate=64",
            server.uri()
        );

        let download = analysis_backfill_download(
            app.handle(),
            "canonical-server",
            "t1",
            &stream_url,
            ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
        )
        .await
        .unwrap();

        assert_eq!(download.bytes, original);
        assert_eq!(download.format_hint, None);
        let trusted = download.trusted_revision.unwrap();
        assert!(!trusted.analysis_bytes_transcoded);
        assert_eq!(
            trusted.md5_16kb,
            analysis_cache::md5_first_16kb(&download.bytes)
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 4);
    }

    #[tokio::test]
    async fn successful_raw_revalidation_wins_over_transcode_source_error() {
        use tauri::Manager;
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let mut original = vec![0x45; 24 * 1024];
        original[..4].copy_from_slice(b"fLaC");
        let source_error = br#"{"subsonic-response":{"status":"failed","error":{"code":0,"message":"open /private/music.flac: no such file or directory"}}}"#.to_vec();
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "raw"))
            .respond_with(RawOriginalResponder {
                body: original.clone(),
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "mp3"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(source_error))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/download.view"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(original.clone()))
            .mount(&server)
            .await;

        let app = tauri::test::mock_app();
        app.handle()
            .manage(Arc::new(analysis_registry(&server.uri(), true)));
        app.handle()
            .manage(analysis_cache::AnalysisCache::open_in_memory());
        let stream_url = format!(
            "{}/rest/stream.view?id=transcode-error&format=mp3",
            server.uri()
        );

        let download = analysis_backfill_download(
            app.handle(),
            "canonical-server",
            "transcode-source-error",
            &stream_url,
            ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
        )
        .await
        .unwrap();

        assert_eq!(download.bytes, original);
        let cache = app.handle().state::<analysis_cache::AnalysisCache>();
        assert_eq!(
            cache
                .get_latest_status_for_track("canonical-server", "transcode-source-error")
                .unwrap(),
            None
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 4);
    }

    #[tokio::test]
    async fn backfill_discards_transcode_when_original_changes_during_fetch() {
        use tauri::Manager;
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let mut original_a = vec![0x41; 24 * 1024];
        original_a[..4].copy_from_slice(b"fLaC");
        let mut original_b = vec![0x42; 24 * 1024];
        original_b[..4].copy_from_slice(b"fLaC");
        let raw_requests = Arc::new(AtomicUsize::new(0));
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "raw"))
            .respond_with(ChangingRawOriginalResponder {
                first: original_a,
                later: original_b.clone(),
                requests: raw_requests,
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "mp3"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0x55; 12 * 1024]))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/download.view"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(original_b.clone()))
            .mount(&server)
            .await;

        let app = tauri::test::mock_app();
        app.handle()
            .manage(Arc::new(analysis_registry(&server.uri(), true)));
        let stream_url = format!(
            "{}/rest/stream.view?id=t1&format=mp3&maxBitRate=64",
            server.uri()
        );

        let download = analysis_backfill_download(
            app.handle(),
            "canonical-server",
            "t1",
            &stream_url,
            ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
        )
        .await
        .unwrap();

        assert_eq!(download.bytes, original_b);
        let trusted = download.trusted_revision.unwrap();
        assert!(!trusted.analysis_bytes_transcoded);
        assert_eq!(
            trusted.md5_16kb,
            analysis_cache::md5_first_16kb(&download.bytes)
        );
        assert_eq!(server.received_requests().await.unwrap().len(), 4);
    }

    #[tokio::test]
    async fn oversized_download_does_not_fail_a_stale_raw_fingerprint() {
        use tauri::Manager;
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let mut probed_original = vec![0x41; 24 * 1024];
        probed_original[..4].copy_from_slice(b"fLaC");
        let mut downloaded_original = vec![0x42; 24 * 1024];
        downloaded_original[..4].copy_from_slice(b"fLaC");
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "raw"))
            .respond_with(RawOriginalResponder {
                body: probed_original,
            })
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "mp3"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/download.view"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(downloaded_original))
            .mount(&server)
            .await;

        let app = tauri::test::mock_app();
        app.handle()
            .manage(Arc::new(analysis_registry(&server.uri(), true)));
        app.handle()
            .manage(analysis_cache::AnalysisCache::open_in_memory());
        let stream_url = format!(
            "{}/rest/stream.view?id=t1&format=mp3&maxBitRate=64",
            server.uri()
        );

        let result = analysis_backfill_download(
            app.handle(),
            "canonical-server",
            "t1",
            &stream_url,
            8 * 1024,
        )
        .await;

        assert_eq!(
            result.unwrap_err(),
            AnalysisBackfillJobError::Retryable(
                "oversized original download does not match raw-probed identity".to_string()
            )
        );
        let cache = app.handle().state::<analysis_cache::AnalysisCache>();
        assert_eq!(
            cache
                .get_latest_status_for_track("canonical-server", "t1")
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn non_navidrome_backfill_uses_standard_original_download() {
        use tauri::Manager;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let original = vec![0x33; 12 * 1024];
        Mock::given(method("GET"))
            .and(path("/rest/download.view"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(original.clone()))
            .mount(&server)
            .await;

        let app = tauri::test::mock_app();
        app.handle()
            .manage(Arc::new(analysis_registry(&server.uri(), false)));
        app.handle()
            .manage(analysis_cache::AnalysisCache::open_in_memory());
        let stream_url = format!(
            "{}/rest/stream.view?id=t1&format=mp3&maxBitRate=64",
            server.uri()
        );

        let download = analysis_backfill_download(
            app.handle(),
            "canonical-server",
            "t1",
            &stream_url,
            ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
        )
        .await
        .unwrap();

        assert_eq!(download.bytes, original);
        let trusted = download.trusted_revision.unwrap();
        assert_eq!(
            trusted.md5_16kb,
            analysis_cache::md5_first_16kb(&download.bytes)
        );
        assert!(!trusted.analysis_bytes_transcoded);
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url.path(), "/rest/download.view");

        let oversized = analysis_backfill_download(
            app.handle(),
            "canonical-server",
            "oversized-original",
            &stream_url,
            8 * 1024,
        )
        .await;
        assert_eq!(
            oversized.unwrap_err(),
            AnalysisBackfillJobError::Terminal(
                "original download exceeds analysis cap of 8192 bytes".to_string()
            )
        );
        let cache = app.handle().state::<analysis_cache::AnalysisCache>();
        assert_eq!(
            cache
                .get_latest_status_for_track("canonical-server", "oversized-original")
                .unwrap()
                .map(|(status, _)| status),
            Some("failed".to_string())
        );
    }

    #[tokio::test]
    async fn permanent_original_download_http_failure_is_terminal() {
        use tauri::Manager;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/download.view"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let app = tauri::test::mock_app();
        app.handle()
            .manage(Arc::new(analysis_registry(&server.uri(), false)));
        let stream_url = format!("{}/rest/stream.view?id=missing", server.uri());

        assert_eq!(
            analysis_backfill_download(
                app.handle(),
                "canonical-server",
                "missing",
                &stream_url,
                ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
            )
            .await
            .unwrap_err(),
            AnalysisBackfillJobError::Terminal(
                "original download unavailable: HTTP 404".to_string()
            )
        );
    }

    #[tokio::test]
    async fn missing_source_is_recorded_without_original_download_fallback() {
        use tauri::Manager;
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let response = br#"{"subsonic-response":{"status":"failed","error":{"code":0,"message":"open /music/missing.flac: no such file or directory"}}}"#.to_vec();
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "raw"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(response))
            .mount(&server)
            .await;

        let app = tauri::test::mock_app();
        app.handle()
            .manage(Arc::new(analysis_registry(&server.uri(), true)));
        app.handle()
            .manage(analysis_cache::AnalysisCache::open_in_memory());
        let stream_url = format!("{}/rest/stream.view?id=missing&format=mp3", server.uri());

        let result = analysis_backfill_download(
            app.handle(),
            "canonical-server",
            "missing",
            &stream_url,
            ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
        )
        .await;

        let Err(AnalysisBackfillJobError::Terminal(message)) = result else {
            panic!("missing source should be a recoverable terminal backfill failure");
        };
        assert!(message.contains("Subsonic code 0"));
        assert!(message.contains("reason=no_such_file_or_directory"));
        assert!(!message.contains("/music/"));
        let cache = app.handle().state::<analysis_cache::AnalysisCache>();
        let failed = cache
            .list_failed_tracks("canonical-server", None)
            .unwrap();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].track_id, "missing");
        assert_eq!(failed[0].md5_16kb, ANALYSIS_SOURCE_UNAVAILABLE_REVISION);
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url.path(), "/rest/stream.view");
    }

    #[test]
    fn explicit_backfill_server_hint_beats_url_transport_scope() {
        assert_eq!(
            resolve_backfill_server_id(
                "https://lan.example:4533/nav/rest/stream.view?id=t1",
                Some("canonical.example/nav"),
            ),
            "canonical.example/nav"
        );
        assert_eq!(
            resolve_backfill_server_id("https://lan.example:4533/nav/rest/stream.view?id=t1", None,),
            "lan.example:4533/nav"
        );
    }

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
        s.in_progress
            .insert(seed_key("", "active"), AnalysisBackfillPriority::Low);
        assert!(s.is_reserved(&seed_key("", "queued")));
        assert!(s.is_reserved(&seed_key("", "active")));
        assert!(!s.is_reserved(&seed_key("", "other")));
    }

    #[test]
    fn backfill_try_pop_next_drains_high_then_middle_then_low() {
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(
            String::new(),
            "low".into(),
            "u".into(),
            AnalysisBackfillPriority::Low,
        );
        s.enqueue(
            String::new(),
            "mid".into(),
            "u".into(),
            AnalysisBackfillPriority::Middle,
        );
        s.enqueue(
            String::new(),
            "hi".into(),
            "u".into(),
            AnalysisBackfillPriority::High,
        );
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
    fn backfill_enqueue_same_track_id_on_two_servers_stays_two_jobs() {
        // Same Subsonic id on two servers is two different files: the second
        // enqueue must not be DuplicateSkipped nor steal the first job's scope.
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(
            "server-a".into(),
            "dup".into(),
            "url-a".into(),
            AnalysisBackfillPriority::Low,
        );
        let kind = s.enqueue(
            "server-b".into(),
            "dup".into(),
            "url-b".into(),
            AnalysisBackfillPriority::Low,
        );
        assert_eq!(kind, AnalysisBackfillEnqueueKind::NewLow);
        assert_eq!(s.queued_len(), 2, "one backfill job per server");
        let first = s.try_pop_next(4).unwrap();
        let second = s.try_pop_next(4).unwrap();
        assert_eq!((first.0.as_str(), first.2.as_str()), ("dup", "server-a"));
        assert_eq!((second.0.as_str(), second.2.as_str()), ("dup", "server-b"));
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
        // Same (server, track): a higher-priority re-enqueue reorders the job.
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(
            "server-1".into(),
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
            in_progress: HashMap::from([(seed_key("", "active"), AnalysisBackfillPriority::Low)]),
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
    fn backfill_transient_failure_defers_low_priority_retry() {
        let mut s = AnalysisBackfillQueueState::default();
        let key = seed_key("server-1", "retry");
        s.in_progress
            .insert(key.clone(), AnalysisBackfillPriority::Low);
        s.finish_job(&key, AnalysisBackfillFinish::RetryableFailure);

        let kind = s.enqueue(
            "server-1".into(),
            "retry".into(),
            "url".into(),
            AnalysisBackfillPriority::Low,
        );

        assert_eq!(kind, AnalysisBackfillEnqueueKind::RetryDeferred);
        assert_eq!(s.queued_len(), 0);
    }

    #[test]
    fn backfill_high_priority_retry_bypasses_and_clears_cooldown() {
        let mut s = AnalysisBackfillQueueState::default();
        let key = seed_key("server-1", "retry");
        s.in_progress
            .insert(key.clone(), AnalysisBackfillPriority::Low);
        s.finish_job(&key, AnalysisBackfillFinish::RetryableFailure);

        assert_eq!(
            s.enqueue(
                "server-1".into(),
                "retry".into(),
                "url".into(),
                AnalysisBackfillPriority::High,
            ),
            AnalysisBackfillEnqueueKind::NewHigh
        );
        let job = s.try_pop_next(1).unwrap();
        s.finish_job(
            &seed_key(&job.2, &job.0),
            AnalysisBackfillFinish::Success,
        );

        assert_eq!(
            s.enqueue(
                "server-1".into(),
                "retry".into(),
                "url".into(),
                AnalysisBackfillPriority::Low,
            ),
            AnalysisBackfillEnqueueKind::NewLow
        );
    }

    #[test]
    fn post_admission_failure_preserves_reservation_and_increments_backoff() {
        let mut state = AnalysisBackfillQueueState::default();
        let key = seed_key("server-1", "retry");
        state
            .in_progress
            .insert(key.clone(), AnalysisBackfillPriority::Low);
        state.finish_job(&key, AnalysisBackfillFinish::RetryableFailure);
        assert_eq!(
            state.retry_state.get(&key).map(|retry| retry.failures),
            Some(1)
        );

        assert_eq!(
            state.enqueue(
                "server-1".into(),
                "retry".into(),
                "url".into(),
                AnalysisBackfillPriority::High,
            ),
            AnalysisBackfillEnqueueKind::NewHigh
        );
        let job = state.try_pop_next(1).unwrap();
        state.mark_cpu_admitted(&key);

        assert!(state.awaiting_cpu.contains(&key));
        assert_eq!(
            state.enqueue(
                "server-1".into(),
                "retry".into(),
                "url".into(),
                AnalysisBackfillPriority::High,
            ),
            AnalysisBackfillEnqueueKind::RunningSkipped
        );

        state.finish_job(
            &seed_key(&job.2, &job.0),
            AnalysisBackfillFinish::RetryableFailure,
        );

        assert!(state.retry_deferred(&key));
        assert_eq!(
            state.retry_state.get(&key).map(|retry| retry.failures),
            Some(2)
        );
    }

    #[test]
    fn permanent_http_failure_suppresses_low_priority_until_high_priority_retries() {
        let mut state = AnalysisBackfillQueueState::default();
        let key = seed_key("server-1", "permanent");
        state
            .in_progress
            .insert(key.clone(), AnalysisBackfillPriority::Low);
        state.finish_job(&key, AnalysisBackfillFinish::TerminalFailure);

        assert_eq!(
            state.enqueue(
                "server-1".into(),
                "permanent".into(),
                "url".into(),
                AnalysisBackfillPriority::Low,
            ),
            AnalysisBackfillEnqueueKind::TerminalSkipped
        );
        assert_eq!(
            state.enqueue(
                "server-1".into(),
                "permanent".into(),
                "url".into(),
                AnalysisBackfillPriority::High,
            ),
            AnalysisBackfillEnqueueKind::NewHigh
        );
    }

    #[test]
    fn terminal_failure_cooldown_allows_a_later_low_priority_retry() {
        let mut state = AnalysisBackfillQueueState::default();
        let key = seed_key("server-1", "changed-after-terminal");
        state
            .in_progress
            .insert(key.clone(), AnalysisBackfillPriority::Low);
        state.finish_job(&key, AnalysisBackfillFinish::TerminalFailure);
        state.terminal_failures.insert(
            key,
            std::time::Instant::now() - std::time::Duration::from_secs(1),
        );

        assert_eq!(
            state.enqueue(
                "server-1".into(),
                "changed-after-terminal".into(),
                "url".into(),
                AnalysisBackfillPriority::Low,
            ),
            AnalysisBackfillEnqueueKind::NewLow
        );
        assert!(state.terminal_failures.is_empty());
    }

    #[test]
    fn forced_low_priority_retry_bypasses_terminal_cooldown() {
        let mut state = AnalysisBackfillQueueState::default();
        let key = seed_key("server-1", "manual-retry");
        state
            .in_progress
            .insert(key.clone(), AnalysisBackfillPriority::Low);
        state.finish_job(&key, AnalysisBackfillFinish::TerminalFailure);

        assert_eq!(
            state.enqueue_with_force(
                "server-1".into(),
                "manual-retry".into(),
                "url".into(),
                AnalysisBackfillPriority::Low,
                true,
            ),
            AnalysisBackfillEnqueueKind::NewLow
        );
    }

    #[test]
    fn clearing_failed_tracks_removes_matching_backfill_cooldowns() {
        let mut state = AnalysisBackfillQueueState::default();
        let bare_key = seed_key("server-1", "missing");
        let stream_key = seed_key("server-1", "stream:missing");
        let other_server_key = seed_key("server-2", "missing");
        state.record_retryable_failure(&bare_key);
        state.terminal_failures.insert(
            stream_key.clone(),
            std::time::Instant::now() + std::time::Duration::from_secs(60),
        );
        state.terminal_failures.insert(
            other_server_key.clone(),
            std::time::Instant::now() + std::time::Duration::from_secs(60),
        );

        state.clear_failure_state("server-1", &["missing".to_string()]);

        assert!(!state.retry_state.contains_key(&bare_key));
        assert!(!state.terminal_failures.contains_key(&stream_key));
        assert!(state.terminal_failures.contains_key(&other_server_key));
    }

    #[test]
    fn late_registration_cannot_replace_a_newer_trusted_revision() {
        let app = tauri::test::mock_app();
        let older_generation = next_trusted_generation();
        let newer_generation = next_trusted_generation();

        register_trusted_revision_generation(
            "generation-order-server",
            "t1",
            "newer-fingerprint",
            newer_generation,
        );
        register_trusted_revision_generation(
            "generation-order-server",
            "t1",
            "older-fingerprint",
            older_generation,
        );

        assert!(!activate_trusted_identity(
            app.handle(),
            "generation-order-server",
            "generation-order-server",
            "t1",
            "older-fingerprint",
            older_generation,
        ));
        assert!(activate_trusted_identity(
            app.handle(),
            "generation-order-server",
            "generation-order-server",
            "t1",
            "newer-fingerprint",
            newer_generation,
        ));
    }

    #[test]
    fn same_revision_reuses_the_current_generation() {
        let first_generation = next_trusted_generation();
        let second_generation = next_trusted_generation();
        let server_id = "same-revision-generation-server";
        let track_id = "same-revision-track";

        let first = register_trusted_revision_generation(
            server_id,
            track_id,
            "same-fingerprint",
            first_generation,
        );
        let second = register_trusted_revision_generation(
            server_id,
            track_id,
            "same-fingerprint",
            second_generation,
        );

        assert_eq!(first, first_generation);
        assert_eq!(second, first_generation);
        assert!(trusted_revision_generation_is_current(
            server_id,
            track_id,
            "same-fingerprint",
            first_generation,
        ));
    }

    #[test]
    fn stale_source_unavailable_response_does_not_write_failed_status() {
        use tauri::Manager;

        let app = tauri::test::mock_app();
        app.handle()
            .manage(analysis_cache::AnalysisCache::open_in_memory());
        let server_id = "stale-unavailable-server";
        let track_id = "stale-unavailable-track";
        let stale_generation = next_trusted_generation();
        let current_generation = next_trusted_generation();
        register_trusted_revision_generation(
            server_id,
            track_id,
            "current-fingerprint",
            current_generation,
        );

        let outcome = source_unavailable_failure(
            app.handle(),
            server_id,
            track_id,
            &crate::raw_probe::SubsonicStreamError {
                code: 0,
                message: "open /private/music.flac: no such file or directory".to_string(),
            },
            stale_generation,
        );

        assert_eq!(outcome, AnalysisBackfillJobError::Superseded);
        let cache = app.handle().state::<analysis_cache::AnalysisCache>();
        assert_eq!(
            cache
                .get_latest_status_for_track(server_id, track_id)
                .unwrap(),
            None
        );
    }

    #[test]
    fn backfill_try_pop_next_respects_max_concurrent() {
        let mut s = AnalysisBackfillQueueState::default();
        s.enqueue(
            String::new(),
            "a".into(),
            "u".into(),
            AnalysisBackfillPriority::Low,
        );
        s.enqueue(
            String::new(),
            "b".into(),
            "u".into(),
            AnalysisBackfillPriority::Low,
        );
        s.in_progress
            .insert("active".into(), AnalysisBackfillPriority::Low);
        assert!(s.try_pop_next(1).is_none());
        assert_eq!(s.try_pop_next(2).unwrap().0, "a");
    }

    #[test]
    fn backfill_prune_queued_not_in_drops_unkept_entries() {
        let mut s = AnalysisBackfillQueueState::default();
        for tid in ["a", "b", "c", "d"] {
            s.enqueue(
                String::new(),
                tid.into(),
                "u".into(),
                AnalysisBackfillPriority::Low,
            );
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
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (kind, _r2) = s.enqueue(
            String::new(),
            "hot".into(),
            vec![],
            None,
            None,
            AnalysisBackfillPriority::High,
            0,
        );
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewHigh);
        assert_eq!(s.try_pop_next().unwrap().track_id, "hot");
    }

    #[test]
    fn cpu_seed_enqueue_existing_low_prio_merges_at_back() {
        // Same (server, track, revision): the fresh submission merges into the
        // queued job — e.g. two transcoded plays carrying the SAME trusted
        // original fingerprint. Fresher bytes win, both waiters attach.
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(
            "server-a".into(),
            "dup".into(),
            vec![1, 2, 3],
            None,
            trusted_revision("rev-x", 1),
            AnalysisBackfillPriority::Low,
            0,
        );
        let (kind, _r2) = s.enqueue(
            "server-a".into(),
            "dup".into(),
            vec![4, 5, 6],
            None,
            trusted_revision("rev-x", 1),
            AnalysisBackfillPriority::Low,
            0,
        );
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::MergedQueued);
        assert_eq!(s.queued_len(), 1);
        let job = s.try_pop_next().unwrap();
        assert_eq!(job.bytes, vec![4, 5, 6], "fresh bytes overwrite");
        assert_eq!(job.waiters.len(), 2, "both waiters attached");
    }

    #[test]
    fn cpu_seed_merge_never_replaces_original_bytes_with_transcode() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _original_rx) = s.enqueue(
            "server-a".into(),
            "track".into(),
            vec![1, 2, 3],
            None,
            trusted_revision("revision", 1),
            AnalysisBackfillPriority::High,
            0,
        );
        let (kind, _transcode_rx) = s.enqueue(
            "server-a".into(),
            "track".into(),
            vec![9, 9, 9],
            Some("mp3".into()),
            trusted_transcode_revision("revision", 1),
            AnalysisBackfillPriority::Low,
            0,
        );

        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::MergedQueued);
        let job = s.try_pop_next().unwrap();
        assert_eq!(job.bytes, vec![1, 2, 3]);
        assert!(!job.trusted_revision.unwrap().analysis_bytes_transcoded);
        assert_eq!(job.waiters.len(), 2);
    }

    #[test]
    fn cpu_seed_running_job_does_not_swallow_a_different_content_revision() {
        // A job for revision A is RUNNING; a submission for the same track
        // with a DIFFERENT trusted fingerprint (new original revision) must be
        // queued as its own job — attaching it as a follower would discard its
        // bytes and fingerprint entirely.
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(
            "srv".into(),
            "t1".into(),
            vec![1],
            None,
            trusted_revision("revision-a", 1),
            AnalysisBackfillPriority::Low,
            0,
        );
        let job_a = s.try_pop_next().unwrap();
        assert_eq!(
            job_a
                .trusted_revision
                .as_ref()
                .map(|trusted| trusted.md5_16kb.as_str()),
            Some("revision-a")
        );
        // Mirror the worker: mark revision A as running.
        s.running.insert(
            seed_revision_key(&job_a.server_id, &job_a.track_id, &job_a.revision),
            Arc::new(Mutex::new(Vec::new())),
        );
        assert!(s.contains_revision("srv", "t1", "revision-a"));
        assert!(!s.contains_revision("srv", "t1", "revision-b"));

        let (kind, _r2) = s.enqueue(
            "srv".into(),
            "t1".into(),
            vec![2],
            None,
            trusted_revision("revision-b", 2),
            AnalysisBackfillPriority::Low,
            0,
        );
        assert_ne!(
            kind,
            AnalysisCpuSeedEnqueueKind::RunningFollower,
            "a different content revision must not be swallowed as a follower"
        );
        let job_b = s.try_pop_next().expect("revision B queued as its own job");
        assert_eq!(
            job_b
                .trusted_revision
                .as_ref()
                .map(|trusted| trusted.md5_16kb.as_str()),
            Some("revision-b")
        );
        assert_eq!(job_b.bytes, vec![2]);
    }

    #[test]
    fn cpu_seed_enqueue_same_track_id_on_two_servers_stays_two_jobs() {
        // The same Subsonic id on different servers is different content —
        // it must NOT merge into one decode or steal the other's scope.
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(
            "server-a".into(),
            "dup".into(),
            vec![1, 2, 3],
            None,
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (kind, _r2) = s.enqueue(
            "server-b".into(),
            "dup".into(),
            vec![4, 5, 6],
            None,
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewLow);
        assert_eq!(s.queued_len(), 2, "one job per server");
        let first = s.try_pop_next().unwrap();
        let second = s.try_pop_next().unwrap();
        assert_eq!(first.server_id, "server-a");
        assert_eq!(second.server_id, "server-b");
    }

    #[test]
    fn cpu_seed_enqueue_existing_low_prio_upgrades_to_high() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(
            String::new(),
            "first".into(),
            vec![],
            None,
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (_, _r2) = s.enqueue(
            String::new(),
            "dup".into(),
            vec![],
            None,
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (kind, _r3) = s.enqueue(
            String::new(),
            "dup".into(),
            vec![],
            None,
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
        s.running.insert(
            seed_revision_key("", "active", &analysis_cache::md5_first_16kb(&[])),
            followers.clone(),
        );
        let (kind, _rx) = s.enqueue(
            String::new(),
            "active".into(),
            vec![],
            None,
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::RunningFollower);
        assert_eq!(
            followers.lock().unwrap().len(),
            1,
            "follower channel attached"
        );
        assert_eq!(s.queued_len(), 0, "follower does not occupy a queue slot");
    }

    #[test]
    fn cpu_seed_finish_running_closes_follower_registration_before_drain() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let revision = analysis_cache::md5_first_16kb(&[]);
        let key = seed_revision_key("", "active", &revision);
        let followers = Arc::new(Mutex::new(Vec::new()));
        let (existing_tx, _existing_rx) = tokio::sync::oneshot::channel();
        followers.lock().unwrap().push(existing_tx);
        s.running.insert(key.clone(), followers);
        s.running_tiers
            .insert(key.clone(), AnalysisBackfillPriority::Low);

        let drained = s.finish_running(&key);
        assert_eq!(drained.len(), 1);
        assert!(!s.running.contains_key(&key));
        assert!(!s.running_tiers.contains_key(&key));

        let (kind, _rx) = s.enqueue(
            String::new(),
            "active".into(),
            vec![],
            None,
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewLow);
    }

    #[test]
    fn cpu_seed_prune_returns_removed_jobs_and_waiter_count() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(
            String::new(),
            "a".into(),
            vec![],
            None,
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (_, _r2) = s.enqueue(
            String::new(),
            "b".into(),
            vec![],
            None,
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (_, _r3) = s.enqueue(
            String::new(),
            "a".into(),
            vec![],
            None,
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let (_, _r4) = s.enqueue(
            String::new(),
            "c".into(),
            vec![],
            None,
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
            None,
            AnalysisBackfillPriority::Low,
            0,
        );
        let keep: HashSet<&str> = HashSet::new();
        let _ = s.prune_queued_not_in(&keep, None);
        let result = rx
            .blocking_recv()
            .expect("sender side should have closed cleanly");
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
        assert!(should_idle_for_cpu_backpressure(12, 0, 12, false));
        assert!(should_idle_for_cpu_backpressure(20, 0, 12, false));
    }

    #[test]
    fn backpressure_allows_pop_when_cpu_load_below_cap() {
        assert!(!should_idle_for_cpu_backpressure(11, 0, 12, false));
        assert!(!should_idle_for_cpu_backpressure(0, 0, 12, false));
        assert!(should_idle_for_cpu_backpressure(11, 1, 12, false));
    }

    #[test]
    fn backpressure_reserves_one_extra_slot_for_high_priority_jobs() {
        assert!(!should_idle_for_cpu_backpressure(12, 0, 12, true));
        assert!(should_idle_for_cpu_backpressure(12, 1, 12, true));
        assert!(should_idle_for_cpu_backpressure(13, 0, 12, true));
        assert!(should_idle_for_cpu_backpressure(100, 0, 12, true));
    }

    #[test]
    fn backpressure_admits_only_one_high_download_beyond_cpu_cap() {
        let mut state = AnalysisBackfillQueueState::default();
        state.enqueue(
            "backpressure-server".into(),
            "first".into(),
            "u1".into(),
            AnalysisBackfillPriority::High,
        );
        state.enqueue(
            "backpressure-server".into(),
            "second".into(),
            "u2".into(),
            AnalysisBackfillPriority::High,
        );

        assert!(state
            .try_pop_next_with_cpu_backpressure(20, 12, 12)
            .is_some());
        assert!(state
            .try_pop_next_with_cpu_backpressure(20, 12, 12)
            .is_none());
        assert_eq!(state.in_progress.len(), 1);
        assert_eq!(state.queued_len(), 1);
    }

    #[tokio::test]
    async fn trusted_fetch_reservation_waits_for_stream_track_alias_owner() {
        let first = reserve_trusted_analysis_fetch(
            "fetch-reservation-server",
            "stream:fetch-reservation-track",
            "fetch-reservation-revision",
        )
        .await;
        assert!(!first.waited());

        let mut waiter = tokio::spawn(async {
            reserve_trusted_analysis_fetch(
                "fetch-reservation-server",
                "fetch-reservation-track",
                "fetch-reservation-revision",
            )
            .await
        });
        let key = seed_revision_key(
            "fetch-reservation-server",
            "fetch-reservation-track",
            "fetch-reservation-revision",
        );
        loop {
            let registered = TRUSTED_ANALYSIS_FETCHES
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .unwrap()
                .get(&key)
                .is_some_and(|waiters| !waiters.is_empty());
            if registered {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(tokio::time::timeout(std::time::Duration::from_millis(10), &mut waiter)
            .await
            .is_err());

        drop(first);
        let second = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("waiter should wake when the owner releases")
            .expect("waiter task should complete");
        assert!(second.waited());
    }
}

#[cfg(test)]
mod complete_repair_tests {
    use super::*;
    use crate::analysis_cache::{AnalysisCache, LoudnessEntry, TrackKey, WaveformEntry};
    use tauri::Manager;

    fn key_for(server_id: &str, track_id: &str, md5: &str) -> TrackKey {
        TrackKey {
            server_id: server_id.into(),
            track_id: track_id.into(),
            md5_16kb: md5.into(),
        }
    }

    fn seed_complete_row_for(
        cache: &AnalysisCache,
        server_id: &str,
        track_id: &str,
        md5: &str,
        updated_at: i64,
    ) {
        let key = key_for(server_id, track_id, md5);
        cache.touch_track_status(&key, "ready").unwrap();
        cache
            .upsert_waveform(
                &key,
                &WaveformEntry {
                    bins: vec![1, 2, 3, 4, 5, 6],
                    bin_count: 3,
                    is_partial: false,
                    known_until_sec: 100.0,
                    duration_sec: 100.0,
                    updated_at,
                },
            )
            .unwrap();
        cache
            .upsert_loudness(
                &key,
                &LoudnessEntry {
                    integrated_lufs: -14.0,
                    true_peak: 0.5,
                    recommended_gain_db: 0.0,
                    target_lufs: -14.0,
                    updated_at,
                },
            )
            .unwrap();
    }

    /// Review scenario: a COMPLETE trusted row exists, then a backfill/legacy
    /// pass writes a transcode-variant row with a newer `updated_at`. A later
    /// trusted resolution hits the "already complete" branch — which must
    /// still purge the stale variant so latest-row reads return the trusted
    /// fingerprint, not the newest write.
    #[test]
    fn complete_trusted_row_purges_newer_stale_variant() {
        let app = tauri::test::mock_app();
        app.handle().manage(AnalysisCache::open_in_memory());
        let cache = app.handle().state::<AnalysisCache>();
        let server_id = "srv-complete-repair";

        seed_complete_row_for(&cache, server_id, "t1", "trusted-fp", 100);
        seed_complete_row_for(&cache, server_id, "t1", "stale-transcode-fp", 200); // newer wins reads today

        assert_eq!(
            cache
                .get_latest_md5_16kb_for_track(server_id, "t1")
                .unwrap()
                .as_deref(),
            Some("stale-transcode-fp"),
            "precondition: the stale variant is what reads currently select"
        );

        let generation = begin_trusted_revision(server_id, "t1", "trusted-fp");
        activate_trusted_identity(
            app.handle(),
            server_id,
            server_id,
            "t1",
            "trusted-fp",
            generation,
        );

        assert_eq!(
            cache
                .get_latest_md5_16kb_for_track(server_id, "t1")
                .unwrap()
                .as_deref(),
            Some("trusted-fp"),
            "the stale variant must be purged on the complete-repair path"
        );
    }

    #[test]
    fn trusted_revisions_completing_in_reverse_keep_the_newer_result() {
        let app = tauri::test::mock_app();
        app.handle().manage(AnalysisCache::open_in_memory());
        let recorded = Arc::new(Mutex::new(Vec::<String>::new()));
        let recorded_for_sink = recorded.clone();
        app.handle()
            .manage(psysonic_core::ports::ContentHashSink::new(
                move |_, _, hash| recorded_for_sink.lock().unwrap().push(hash.to_string()),
            ));
        let cache = app.handle().state::<AnalysisCache>();

        let older_generation = begin_trusted_revision("srv-reverse", "stream:t1", "older-fp");
        let newer_generation = begin_trusted_revision("srv-reverse", "t1", "newer-fp");
        seed_complete_row_for(&cache, "srv-reverse", "t1", "newer-fp", 200);
        assert!(activate_trusted_identity(
            app.handle(),
            "srv-reverse",
            "srv-reverse",
            "t1",
            "newer-fp",
            newer_generation,
        ));

        seed_complete_row_for(&cache, "srv-reverse", "t1", "older-fp", 300);
        assert!(!activate_trusted_identity(
            app.handle(),
            "srv-reverse",
            "srv-reverse",
            "stream:t1",
            "older-fp",
            older_generation,
        ));

        assert!(cache
            .content_cache_coverage("srv-reverse", "t1", "newer-fp")
            .unwrap()
            .complete());
        assert!(
            !cache
                .content_cache_coverage("srv-reverse", "t1", "older-fp")
                .unwrap()
                .has_waveform
        );
        assert_eq!(&*recorded.lock().unwrap(), &["newer-fp".to_string()]);
    }

    #[test]
    fn trusted_enrichment_commit_rejects_superseded_generation() {
        let server_id = "srv-enrichment-generation-guard";
        let track_id = "t1";
        let older_generation = begin_trusted_revision(server_id, track_id, "older-fp");
        let newer_generation = begin_trusted_revision(server_id, track_id, "newer-fp");
        let committed = std::sync::atomic::AtomicBool::new(false);

        assert!(commit_trusted_enrichment_if_current(
            server_id,
            track_id,
            "older-fp",
            older_generation,
            || committed.store(true, Ordering::Relaxed),
        )
        .is_none());
        assert!(!committed.load(Ordering::Relaxed));

        assert!(commit_trusted_enrichment_if_current(
            server_id,
            track_id,
            "newer-fp",
            newer_generation,
            || committed.store(true, Ordering::Relaxed),
        )
        .is_some());
        assert!(committed.load(Ordering::Relaxed));
    }

    #[test]
    fn successful_trusted_enrichment_repairs_hash_and_purges_variants() {
        let app = tauri::test::mock_app();
        app.handle().manage(AnalysisCache::open_in_memory());
        let recorded = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let recorded_for_sink = recorded.clone();
        app.handle()
            .manage(psysonic_core::ports::ContentHashSink::new(
                move |server_id, _, hash| {
                    recorded_for_sink
                        .lock()
                        .unwrap()
                        .push((server_id.to_string(), hash.to_string()))
                },
            ));
        let cache = app.handle().state::<AnalysisCache>();
        let server_id = "srv-enrichment-repair";
        seed_complete_row_for(&cache, server_id, "t1", "trusted-enrichment", 100);
        seed_complete_row_for(&cache, server_id, "t1", "stale-enrichment", 200);
        let generation = begin_trusted_revision(server_id, "t1", "trusted-enrichment");

        assert!(activate_trusted_enrichment(
            app.handle(),
            server_id,
            "library-scope",
            "t1",
            "trusted-enrichment",
            generation,
            TrackEnrichmentOutcome::Applied,
        ));
        assert_eq!(
            cache
                .get_latest_md5_16kb_for_track(server_id, "t1")
                .unwrap()
                .as_deref(),
            Some("trusted-enrichment")
        );
        assert_eq!(
            &*recorded.lock().unwrap(),
            &[(
                "library-scope".to_string(),
                "trusted-enrichment".to_string()
            )]
        );
    }
}
