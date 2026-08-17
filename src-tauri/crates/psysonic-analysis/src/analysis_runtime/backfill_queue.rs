use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use super::cpu_seed::{analysis_track_in_cpu_pipeline, requested_pipeline_parallelism, seed_key};
use super::http_backfill::{analysis_backfill_worker_loop, should_idle_for_cpu_backpressure};
use super::types::{
    clamp_pipeline_parallelism, AnalysisBackfillEnqueueKind, AnalysisBackfillPriority,
    AnalysisTierCounts,
};

/// One queued HTTP-backfill job: `(track_id, url, server_id)`. Dedup is by
/// `(server_id, track_id)` so identical Subsonic ids on different servers do
/// not share downloads or cache writes.
pub(super) type BackfillJob = (String, String, String);

pub(super) const ANALYSIS_BACKFILL_RETRY_BASE_SECS: u64 = 30;
pub(super) const ANALYSIS_BACKFILL_RETRY_MAX_SECS: u64 = 30 * 60;
// A track id can later point at new content, so even terminal HTTP/size
// failures must not suppress automatic analysis for the whole app session.
pub(super) const ANALYSIS_BACKFILL_TERMINAL_RETRY_SECS: u64 = 60 * 60;

#[derive(Debug, Clone, Copy)]
pub(super) struct AnalysisBackfillRetryState {
    pub(super) failures: u32,
    pub(super) retry_after: std::time::Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AnalysisBackfillFinish {
    Success,
    RetryableFailure,
    TerminalFailure,
}

#[derive(Default)]
pub struct AnalysisBackfillQueueState {
    pub(super) high: VecDeque<BackfillJob>,
    pub(super) middle: VecDeque<BackfillJob>,
    pub(super) low: VecDeque<BackfillJob>,
    /// Active HTTP downloads keyed by track id (tier kept for pipeline stats).
    pub in_progress: HashMap<String, AnalysisBackfillPriority>,
    /// HTTP download completed and the corresponding CPU seed is still pending.
    /// This reservation prevents a second download without consuming an HTTP slot.
    pub(super) awaiting_cpu: HashSet<String>,
    pub(super) retry_state: HashMap<String, AnalysisBackfillRetryState>,
    pub(super) terminal_failures: HashMap<String, std::time::Instant>,
}

impl AnalysisBackfillQueueState {
    pub(super) fn queued_len(&self) -> usize {
        self.high.len() + self.middle.len() + self.low.len()
    }

    pub(super) fn queued_tier_counts(&self) -> AnalysisTierCounts {
        AnalysisTierCounts {
            high: self.high.len(),
            middle: self.middle.len(),
            low: self.low.len(),
        }
    }

    pub(super) fn in_progress_tier_counts(&self) -> AnalysisTierCounts {
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

    pub(super) fn tier_deque(&self, tier: AnalysisBackfillPriority) -> &VecDeque<BackfillJob> {
        match tier {
            AnalysisBackfillPriority::High => &self.high,
            AnalysisBackfillPriority::Middle => &self.middle,
            AnalysisBackfillPriority::Low => &self.low,
        }
    }

    pub(super) fn tier_deque_mut(
        &mut self,
        tier: AnalysisBackfillPriority,
    ) -> &mut VecDeque<BackfillJob> {
        match tier {
            AnalysisBackfillPriority::High => &mut self.high,
            AnalysisBackfillPriority::Middle => &mut self.middle,
            AnalysisBackfillPriority::Low => &mut self.low,
        }
    }

    pub(super) fn locate_queued(&self, key: &str) -> Option<AnalysisBackfillPriority> {
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

    pub(super) fn remove_queued(&mut self, key: &str) -> Option<BackfillJob> {
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

    pub(super) fn push_new(&mut self, priority: AnalysisBackfillPriority, job: BackfillJob) {
        match priority {
            AnalysisBackfillPriority::High => self.high.push_front(job),
            AnalysisBackfillPriority::Middle => self.middle.push_back(job),
            AnalysisBackfillPriority::Low => self.low.push_back(job),
        }
    }

    pub(super) fn is_reserved(&self, key: &str) -> bool {
        self.in_progress.contains_key(key)
            || self.awaiting_cpu.contains(key)
            || self.locate_queued(key).is_some()
    }

    pub(super) fn try_pop_next(&mut self, max_concurrent: usize) -> Option<BackfillJob> {
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

    pub(super) fn try_pop_next_with_cpu_backpressure(
        &mut self,
        max_concurrent: usize,
        cpu_load: usize,
        cpu_cap: usize,
    ) -> Option<BackfillJob> {
        let high_pending = !self.high.is_empty();
        if should_idle_for_cpu_backpressure(cpu_load, self.in_progress.len(), cpu_cap, high_pending)
        {
            return None;
        }
        self.try_pop_next(max_concurrent)
    }

    pub(super) fn record_retryable_failure(&mut self, key: &str) {
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

    pub(super) fn finish_job(&mut self, key: &str, finish: AnalysisBackfillFinish) {
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

    pub(super) fn mark_cpu_admitted(&mut self, key: &str) {
        self.in_progress.remove(key);
        self.awaiting_cpu.insert(key.to_string());
    }

    pub(super) fn retry_deferred(&self, key: &str) -> bool {
        self.retry_state
            .get(key)
            .is_some_and(|state| state.retry_after > std::time::Instant::now())
    }

    pub(super) fn terminal_deferred(&self, key: &str) -> bool {
        self.terminal_failures
            .get(key)
            .is_some_and(|retry_after| *retry_after > std::time::Instant::now())
    }

    pub(super) fn clear_failure_state(&mut self, server_id: &str, track_ids: &[String]) {
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

    pub(super) fn enqueue_with_force(
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
    pub(super) wake_tx: tokio::sync::mpsc::UnboundedSender<()>,
    pub(super) max_parallel: AtomicUsize,
}

impl AnalysisBackfillShared {
    pub fn ping_worker(&self) {
        let _ = self.wake_tx.send(());
    }

    pub(super) fn max_parallel(&self) -> usize {
        clamp_pipeline_parallelism(self.max_parallel.load(Ordering::Relaxed))
    }
}

pub(super) static ANALYSIS_BACKFILL: OnceLock<Arc<AnalysisBackfillShared>> = OnceLock::new();

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
