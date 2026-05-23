use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{Emitter, Manager};

use psysonic_core::user_agent::subsonic_wire_user_agent;

use crate::analysis_cache;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformUpdatedPayload {
    pub track_id: String,
    pub is_partial: bool,
}

// ─── HTTP backfill queue: download tracks + seed analysis cache ──────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisBackfillEnqueueKind {
    /// New job at the tail of the queue.
    NewBack,
    /// New job for the currently playing track (head).
    NewFront,
    /// Same track was already waiting; moved to head with the latest URL.
    ReorderedFront,
    /// Low-priority duplicate while the track is already queued or running.
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
    pub deque: VecDeque<BackfillJob>,
    /// Set while this `track_id` is inside `analysis_backfill_download_and_seed` (not in deque).
    pub in_progress: Option<String>,
}

impl AnalysisBackfillQueueState {
    fn is_reserved(&self, tid: &str) -> bool {
        self.in_progress.as_deref() == Some(tid)
            || self.deque.iter().any(|(t, _, _)| t.as_str() == tid)
    }

    fn try_pop_next(&mut self) -> Option<BackfillJob> {
        let job = self.deque.pop_front()?;
        self.in_progress = Some(job.0.clone());
        Some(job)
    }

    fn finish_job(&mut self, tid: &str) {
        if self.in_progress.as_deref() == Some(tid) {
            self.in_progress = None;
        }
    }

    pub fn enqueue(
        &mut self,
        server_id: String,
        tid: String,
        url: String,
        high_priority: bool,
    ) -> AnalysisBackfillEnqueueKind {
        let tref = tid.as_str();
        if self.is_reserved(tref) {
            if !high_priority {
                return AnalysisBackfillEnqueueKind::DuplicateSkipped;
            }
            if self.in_progress.as_deref() == Some(tref) {
                return AnalysisBackfillEnqueueKind::RunningSkipped;
            }
            self.deque.retain(|(t, _, _)| t != &tid);
            self.deque.push_front((tid, url, server_id));
            return AnalysisBackfillEnqueueKind::ReorderedFront;
        }
        if high_priority {
            self.deque.push_front((tid, url, server_id));
            AnalysisBackfillEnqueueKind::NewFront
        } else {
            self.deque.push_back((tid, url, server_id));
            AnalysisBackfillEnqueueKind::NewBack
        }
    }

    pub fn prune_queued_not_in(&mut self, keep_track_ids: &HashSet<&str>) -> usize {
        let before = self.deque.len();
        self.deque
            .retain(|(track_id, _, _)| keep_track_ids.contains(track_id.as_str()));
        before.saturating_sub(self.deque.len())
    }
}

pub struct AnalysisBackfillShared {
    pub state: Mutex<AnalysisBackfillQueueState>,
    wake_tx: tokio::sync::mpsc::UnboundedSender<()>,
}

impl AnalysisBackfillShared {
    pub fn ping_worker(&self) {
        let _ = self.wake_tx.send(());
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
            });
            let app = app.clone();
            let sh = shared.clone();
            tauri::async_runtime::spawn(analysis_backfill_worker_loop(app, sh, wake_rx));
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
    high_priority: bool,
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
            high_priority,
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
        run_track_enrichment_from_bytes(app, server_id, track_id, bytes).await;
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
) {
    if server_id.is_empty() {
        return;
    }
    let app = app.clone();
    let sid = server_id.to_string();
    let tid = track_id.to_string();
    let data = bytes.to_vec();
    let _ = tokio::task::spawn_blocking(move || {
        crate::track_enrichment::run_track_enrichment_if_needed(&app, &sid, &tid, &data);
    })
    .await;
}

/// Read a local file and run [`enqueue_track_analysis`] (hot cache, offline, spill promote).
pub async fn enqueue_track_analysis_from_file(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    file_path: &std::path::Path,
    high_priority: bool,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    let bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Ok(EnqueueTrackAnalysisOutcome::Complete);
    }
    enqueue_track_analysis(app, server_id, track_id, &bytes, high_priority).await
}

/// Decode `bytes` for `track_id` via the cpu-seed queue. Prefer [`enqueue_track_analysis`].
pub async fn enqueue_analysis_seed(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
) -> Result<bool, String> {
    let high = analysis_backfill_is_current_track(app, track_id);
    let outcome = enqueue_track_analysis(app, server_id, track_id, bytes, high).await?;
    Ok(!matches!(outcome, EnqueueTrackAnalysisOutcome::Complete))
}

async fn analysis_backfill_download_and_seed(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    url: &str,
) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("empty response".to_string());
    }
    enqueue_analysis_seed(app, server_id, track_id, &bytes).await
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
        while let Some((track_id, url, server_id)) = {
            let mut st = shared
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            st.try_pop_next()
        } {
            crate::app_deprintln!("[analysis] backfill worker: start track_id={}", track_id);
            let result = analysis_backfill_download_and_seed(&app, &server_id, &track_id, &url).await;
            match &result {
                Ok(has_loudness) => crate::app_deprintln!(
                    "[analysis] backfill ready: {} (has_loudness={})",
                    track_id,
                    has_loudness
                ),
                Err(e) => crate::app_eprintln!("[analysis] backfill failed for {}: {}", track_id, e),
            }
            let mut st = shared
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            st.finish_job(&track_id);
        }
    }
}

pub fn analysis_backfill_is_current_track(app: &tauri::AppHandle, track_id: &str) -> bool {
    app.try_state::<psysonic_core::ports::PlaybackQueryHandle>()
        .is_some_and(|p| p.is_track_currently_playing(track_id))
}

// ─── Full-track waveform + loudness: single CPU worker (mirrors HTTP backfill queue) ─
// One `spawn_blocking` decode at a time; current playback is high-priority (front + reorder).
// Same `track_id` queued again merges waiters onto one job; while decode runs, same-id
// submitters attach to `running` followers so they all get the same outcome.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisCpuSeedEnqueueKind {
    NewBack,
    NewFront,
    ReorderedFront,
    RunningFollower,
    MergedQueued,
}

type SeedDoneSender =
    tokio::sync::oneshot::Sender<Result<analysis_cache::SeedFromBytesOutcome, String>>;
type RunningSeedJob = (String, Arc<Mutex<Vec<SeedDoneSender>>>);

struct AnalysisCpuSeedJob {
    /// Playback server scope for the write key. Empty = legacy '' (caller did not
    /// know the server); the read path's fallback + lazy re-tag covers it.
    server_id: String,
    track_id: String,
    bytes: Vec<u8>,
    waiters: Vec<SeedDoneSender>,
}

#[derive(Default)]
struct AnalysisCpuSeedQueueState {
    deque: VecDeque<AnalysisCpuSeedJob>,
    /// Decode in progress — same-id callers wait here for the same outcome.
    running: Option<RunningSeedJob>,
}

impl AnalysisCpuSeedQueueState {
    fn enqueue(
        &mut self,
        server_id: String,
        track_id: String,
        bytes: Vec<u8>,
        high_priority: bool,
    ) -> (
        AnalysisCpuSeedEnqueueKind,
        tokio::sync::oneshot::Receiver<Result<analysis_cache::SeedFromBytesOutcome, String>>,
    ) {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let tid = track_id.as_str();

        if let Some((rtid, followers)) = &self.running {
            if rtid == tid {
                followers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(done_tx);
                return (AnalysisCpuSeedEnqueueKind::RunningFollower, done_rx);
            }
        }

        if let Some(pos) = self.deque.iter().position(|j| j.track_id == track_id) {
            let mut job = self.deque.remove(pos).unwrap();
            // Latest submission wins for both bytes and server scope.
            job.server_id = server_id;
            job.bytes = bytes;
            job.waiters.push(done_tx);
            let kind = if high_priority {
                self.deque.push_front(job);
                AnalysisCpuSeedEnqueueKind::ReorderedFront
            } else {
                self.deque.push_back(job);
                AnalysisCpuSeedEnqueueKind::MergedQueued
            };
            return (kind, done_rx);
        }

        let job = AnalysisCpuSeedJob {
            server_id,
            track_id: track_id.clone(),
            bytes,
            waiters: vec![done_tx],
        };
        let kind = if high_priority {
            self.deque.push_front(job);
            AnalysisCpuSeedEnqueueKind::NewFront
        } else {
            self.deque.push_back(job);
            AnalysisCpuSeedEnqueueKind::NewBack
        };
        (kind, done_rx)
    }

    fn prune_queued_not_in(&mut self, keep_track_ids: &HashSet<&str>) -> (usize, usize) {
        let mut kept = VecDeque::with_capacity(self.deque.len());
        let mut removed_jobs = 0usize;
        let mut removed_waiters = 0usize;
        while let Some(job) = self.deque.pop_front() {
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
        self.deque = kept;
        (removed_jobs, removed_waiters)
    }
}

struct AnalysisCpuSeedShared {
    state: Mutex<AnalysisCpuSeedQueueState>,
    wake_tx: tokio::sync::mpsc::UnboundedSender<()>,
}

impl AnalysisCpuSeedShared {
    fn ping_worker(&self) {
        let _ = self.wake_tx.send(());
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
            });
            let app = app.clone();
            let sh = shared.clone();
            tauri::async_runtime::spawn(analysis_cpu_seed_worker_loop(app, sh, wake_rx));
            shared
        })
        .clone()
}

/// HTTP backfill + CPU seed queue sizes (debug log only — `app_deprintln!`).
fn emit_analysis_queue_snapshot_line() {
    let http = if let Some(arc) = ANALYSIS_BACKFILL.get() {
        let st = arc.state.lock().unwrap_or_else(|e| e.into_inner());
        format!(
            "http_backfill={{queued:{} download_active:{:?}}}",
            st.deque.len(),
            st.in_progress.as_deref()
        )
    } else {
        "http_backfill={{not_started}}".to_string()
    };

    let cpu = if let Some(arc) = ANALYSIS_CPU_SEED.get() {
        let st = arc.state.lock().unwrap_or_else(|e| e.into_inner());
        let queued_jobs = st.deque.len();
        let pending_in_queued_jobs: usize = st.deque.iter().map(|j| j.waiters.len()).sum();
        let (decoding_tid, decoding_extra_waiters) = match &st.running {
            Some((tid, fl)) => (
                Some(tid.as_str()),
                fl.lock().map(|g| g.len()).unwrap_or(0),
            ),
            None => (None, 0usize),
        };
        format!(
            "cpu_seed={{queued_jobs:{} pending_channels_in_queue:{} decoding_tid:{:?} extra_waiters_same_id:{}}}",
            queued_jobs,
            pending_in_queued_jobs,
            decoding_tid,
            decoding_extra_waiters
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
        loop {
            let (job, followers) = {
                let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                let Some(j) = st.deque.pop_front() else {
                    break;
                };
                let fl = Arc::new(Mutex::new(Vec::new()));
                st.running = Some((j.track_id.clone(), fl.clone()));
                (j, fl)
            };
            let tid_log = job.track_id.clone();
            let app2 = app.clone();
            let sid = job.server_id.clone();
            let tid = job.track_id.clone();
            let bytes = job.bytes;
            let outcome = tokio::task::spawn_blocking(move || {
                analysis_cache::seed_from_bytes_execute(&app2, &sid, &tid, &bytes)
            })
            .await
            .unwrap_or_else(|e| Err(format!("cpu-seed spawn_blocking: {e}")));

            let mut extra = followers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .drain(..)
                .collect::<Vec<_>>();
            for tx in job.waiters {
                let _ = tx.send(outcome.clone());
            }
            for tx in extra.drain(..) {
                let _ = tx.send(outcome.clone());
            }

            {
                let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                st.running = None;
            }
            let ok = outcome.as_ref().map(|o| *o == analysis_cache::SeedFromBytesOutcome::Upserted).unwrap_or(false);
            crate::app_deprintln!(
                "[analysis] cpu-seed worker: done track_id={} upserted={}",
                tid_log,
                ok
            );
        }
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
) -> Result<(usize, usize, usize), String> {
    let http_removed = if let Some(shared) = ANALYSIS_BACKFILL.get() {
        let mut st = shared
            .state
            .lock()
            .map_err(|_| "analysis backfill lock poisoned".to_string())?;
        st.prune_queued_not_in(keep_track_ids)
    } else {
        0
    };

    let (cpu_removed_jobs, cpu_removed_waiters) = if let Some(shared) = ANALYSIS_CPU_SEED.get() {
        let mut st = shared
            .state
            .lock()
            .map_err(|_| "analysis cpu-seed lock poisoned".to_string())?;
        st.prune_queued_not_in(keep_track_ids)
    } else {
        (0, 0)
    };

    Ok((http_removed, cpu_removed_jobs, cpu_removed_waiters))
}

/// Submit full-buffer analysis; serializes with other producers. `high_priority` mirrors
/// HTTP backfill head insertion for the currently playing track.
///
/// Emits `analysis:waveform-updated` when analysis **wrote** new waveform data (`Upserted`).
/// Cache-hit skips (`SkippedWaveformCacheHit`) omit the event so the frontend does not
/// re-run loudness refresh / waveform IPC for rows that were already current.
pub async fn submit_analysis_cpu_seed(
    app: tauri::AppHandle,
    server_id: String,
    track_id: String,
    bytes: Vec<u8>,
    high_priority: bool,
) -> Result<analysis_cache::SeedFromBytesOutcome, String> {
    let shared = analysis_cpu_seed_shared(&app);
    let rx = {
        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let (kind, rx) = st.enqueue(server_id, track_id.clone(), bytes, high_priority);
        crate::app_deprintln!("[analysis] cpu-seed submit: kind={kind:?} high_priority={high_priority}");
        drop(st);
        shared.ping_worker();
        rx
    };
    let outcome = match rx.await {
        Ok(res) => res?,
        Err(_) => return Err("cpu-seed: result channel dropped".to_string()),
    };
    if matches!(outcome, analysis_cache::SeedFromBytesOutcome::Upserted) {
        let _ = app.emit(
            "analysis:waveform-updated",
            WaveformUpdatedPayload {
                track_id: track_id.clone(),
                is_partial: false,
            },
        );
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── AnalysisBackfillQueueState ────────────────────────────────────────────

    #[test]
    fn backfill_default_state_has_empty_deque_and_no_in_progress() {
        let s = AnalysisBackfillQueueState::default();
        assert!(s.deque.is_empty());
        assert!(s.in_progress.is_none());
    }

    #[test]
    fn backfill_is_reserved_checks_both_deque_and_in_progress() {
        let mut s = AnalysisBackfillQueueState::default();
        s.deque.push_back(("queued".into(), "u".into(), String::new()));
        s.in_progress = Some("active".into());
        assert!(s.is_reserved("queued"));
        assert!(s.is_reserved("active"));
        assert!(!s.is_reserved("other"));
    }

    #[test]
    fn backfill_try_pop_next_promotes_head_to_in_progress() {
        let mut s = AnalysisBackfillQueueState::default();
        s.deque.push_back(("a".into(), "ua".into(), String::new()));
        s.deque.push_back(("b".into(), "ub".into(), String::new()));
        let popped = s.try_pop_next().unwrap();
        assert_eq!(popped.0, "a");
        assert_eq!(s.in_progress.as_deref(), Some("a"));
        assert_eq!(s.deque.len(), 1);
    }

    #[test]
    fn backfill_try_pop_next_returns_none_for_empty_deque() {
        let mut s = AnalysisBackfillQueueState::default();
        assert!(s.try_pop_next().is_none());
        assert!(s.in_progress.is_none());
    }

    #[test]
    fn backfill_finish_job_only_clears_when_id_matches() {
        let mut s = AnalysisBackfillQueueState {
            in_progress: Some("active".into()),
            ..Default::default()
        };
        s.finish_job("other");
        assert_eq!(s.in_progress.as_deref(), Some("active"));
        s.finish_job("active");
        assert!(s.in_progress.is_none());
    }

    #[test]
    fn backfill_enqueue_low_priority_appends_to_back() {
        let mut s = AnalysisBackfillQueueState::default();
        s.deque.push_back(("first".into(), "u".into(), String::new()));
        let kind = s.enqueue(String::new(), "second".into(), "u2".into(), false);
        assert_eq!(kind, AnalysisBackfillEnqueueKind::NewBack);
        assert_eq!(s.deque.back().unwrap().0, "second");
    }

    #[test]
    fn backfill_enqueue_high_priority_pushes_to_front() {
        let mut s = AnalysisBackfillQueueState::default();
        s.deque.push_back(("old".into(), "u".into(), String::new()));
        let kind = s.enqueue(String::new(), "hot".into(), "u2".into(), true);
        assert_eq!(kind, AnalysisBackfillEnqueueKind::NewFront);
        assert_eq!(s.deque.front().unwrap().0, "hot");
    }

    #[test]
    fn backfill_enqueue_returns_duplicate_skipped_for_low_prio_dup() {
        let mut s = AnalysisBackfillQueueState::default();
        s.deque.push_back(("dup".into(), "u".into(), String::new()));
        let kind = s.enqueue(String::new(), "dup".into(), "u2".into(), false);
        assert_eq!(kind, AnalysisBackfillEnqueueKind::DuplicateSkipped);
        assert_eq!(s.deque.len(), 1);
    }

    #[test]
    fn backfill_enqueue_returns_running_skipped_for_high_prio_active_track() {
        let mut s = AnalysisBackfillQueueState {
            in_progress: Some("active".into()),
            ..Default::default()
        };
        let kind = s.enqueue(String::new(), "active".into(), "u".into(), true);
        assert_eq!(kind, AnalysisBackfillEnqueueKind::RunningSkipped);
    }

    #[test]
    fn backfill_enqueue_high_prio_dup_in_deque_reorders_to_front_with_new_url() {
        let mut s = AnalysisBackfillQueueState::default();
        s.deque.push_back(("a".into(), "u_a".into(), String::new()));
        s.deque.push_back(("dup".into(), "old_url".into(), String::new()));
        s.deque.push_back(("c".into(), "u_c".into(), String::new()));
        let kind = s.enqueue("server-1".into(), "dup".into(), "fresh_url".into(), true);
        assert_eq!(kind, AnalysisBackfillEnqueueKind::ReorderedFront);
        assert_eq!(
            s.deque.front().unwrap(),
            &("dup".to_string(), "fresh_url".to_string(), "server-1".to_string())
        );
        assert_eq!(s.deque.iter().filter(|(t, _, _)| t == "dup").count(), 1, "no duplicate left behind");
    }

    #[test]
    fn backfill_prune_queued_not_in_drops_unkept_entries() {
        let mut s = AnalysisBackfillQueueState::default();
        for tid in ["a", "b", "c", "d"] {
            s.deque.push_back((tid.into(), "u".into(), String::new()));
        }
        let keep: HashSet<&str> = ["a", "c"].iter().copied().collect();
        let removed = s.prune_queued_not_in(&keep);
        assert_eq!(removed, 2);
        let remaining: Vec<&str> = s.deque.iter().map(|(t, _, _)| t.as_str()).collect();
        assert_eq!(remaining, vec!["a", "c"]);
    }

    // ── AnalysisCpuSeedQueueState ─────────────────────────────────────────────

    #[test]
    fn cpu_seed_enqueue_low_prio_appends_to_back() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (kind, _rx) = s.enqueue(String::new(), "a".into(), vec![], false);
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewBack);
        assert_eq!(s.deque.len(), 1);
    }

    #[test]
    fn cpu_seed_enqueue_high_prio_pushes_to_front() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(String::new(), "first".into(), vec![], false);
        let (kind, _r2) = s.enqueue(String::new(), "hot".into(), vec![], true);
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewFront);
        assert_eq!(s.deque.front().unwrap().track_id, "hot");
    }

    #[test]
    fn cpu_seed_enqueue_existing_low_prio_merges_at_back() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue("server-a".into(), "dup".into(), vec![1, 2, 3], false);
        let (kind, _r2) = s.enqueue("server-b".into(), "dup".into(), vec![4, 5, 6], false);
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::MergedQueued);
        assert_eq!(s.deque.len(), 1);
        assert_eq!(s.deque[0].bytes, vec![4, 5, 6], "fresh bytes overwrite");
        assert_eq!(s.deque[0].server_id, "server-b", "latest server scope wins on merge");
        assert_eq!(s.deque[0].waiters.len(), 2, "both waiters attached");
    }

    #[test]
    fn cpu_seed_enqueue_existing_high_prio_reorders_to_front() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(String::new(), "first".into(), vec![], false);
        let (_, _r2) = s.enqueue(String::new(), "dup".into(), vec![], false);
        let (kind, _r3) = s.enqueue(String::new(), "dup".into(), vec![], true);
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::ReorderedFront);
        assert_eq!(s.deque.front().unwrap().track_id, "dup");
    }

    #[test]
    fn cpu_seed_enqueue_running_id_attaches_as_follower() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let followers = Arc::new(Mutex::new(Vec::new()));
        s.running = Some(("active".into(), followers.clone()));
        let (kind, _rx) = s.enqueue(String::new(), "active".into(), vec![], false);
        assert_eq!(kind, AnalysisCpuSeedEnqueueKind::RunningFollower);
        assert_eq!(followers.lock().unwrap().len(), 1, "follower channel attached");
        assert_eq!(s.deque.len(), 0, "follower does not occupy a queue slot");
    }

    #[test]
    fn cpu_seed_prune_returns_removed_jobs_and_waiter_count() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, _r1) = s.enqueue(String::new(), "a".into(), vec![], false);
        let (_, _r2) = s.enqueue(String::new(), "b".into(), vec![], false);
        let (_, _r3) = s.enqueue(String::new(), "a".into(), vec![], false); // merged: 2 waiters on a
        let (_, _r4) = s.enqueue(String::new(), "c".into(), vec![], false);

        let keep: HashSet<&str> = ["a"].iter().copied().collect();
        let (removed_jobs, removed_waiters) = s.prune_queued_not_in(&keep);
        assert_eq!(removed_jobs, 2, "b and c removed");
        assert_eq!(removed_waiters, 2, "one waiter on b + one on c");
        let remaining: Vec<&str> = s.deque.iter().map(|j| j.track_id.as_str()).collect();
        assert_eq!(remaining, vec!["a"]);
    }

    #[test]
    fn cpu_seed_prune_sends_err_to_dropped_waiters() {
        let mut s = AnalysisCpuSeedQueueState::default();
        let (_, rx) = s.enqueue(String::new(), "doomed".into(), vec![], false);
        let keep: HashSet<&str> = HashSet::new();
        let _ = s.prune_queued_not_in(&keep);
        // After pruning, the waiter receives the cancellation Err.
        let result = rx.blocking_recv().expect("sender side should have closed cleanly");
        assert!(result.is_err(), "pruned job must yield Err, got {result:?}");
    }
}
