use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::analysis_cache;
use crate::analysis_perf::AnalysisSeedTimings;

use super::super::types::{
    clamp_pipeline_parallelism, AnalysisBackfillPriority, AnalysisCpuSeedEnqueueKind,
    AnalysisTierCounts, TrustedAnalysisRevision,
};
use super::{analysis_cpu_seed_worker_loop, requested_pipeline_parallelism};

pub(in crate::analysis_runtime) type SeedDoneSender = tokio::sync::oneshot::Sender<
    Result<(analysis_cache::SeedFromBytesOutcome, AnalysisSeedTimings), String>,
>;
pub(in crate::analysis_runtime) type SeedDoneReceiver = tokio::sync::oneshot::Receiver<
    Result<(analysis_cache::SeedFromBytesOutcome, AnalysisSeedTimings), String>,
>;
pub(in crate::analysis_runtime) type RunningSeedJob = Arc<Mutex<Vec<SeedDoneSender>>>;

pub(in crate::analysis_runtime) struct AnalysisCpuSeedJob {
    /// Playback server scope for the write key.
    pub(in crate::analysis_runtime) server_id: String,
    pub(in crate::analysis_runtime) track_id: String,
    pub(in crate::analysis_runtime) bytes: Vec<u8>,
    pub(in crate::analysis_runtime) format_hint: Option<String>,
    /// Verified fingerprint of the ORIGINAL file associated with `bytes`.
    /// Advanced backfill may decode its explicit server transcode; `None`
    /// means the bytes own their identity (local/offline paths).
    pub(in crate::analysis_runtime) trusted_revision: Option<TrustedAnalysisRevision>,
    /// Content revision this job represents: the trusted fingerprint when
    /// present, else the bytes' own fingerprint. Part of the dedup identity —
    /// a submission for a DIFFERENT revision of the same track must never be
    /// swallowed as a follower of a running job.
    pub(in crate::analysis_runtime) revision: String,
    pub(in crate::analysis_runtime) waiters: Vec<SeedDoneSender>,
    /// HTTP download time when this job came from the backfill worker.
    pub(in crate::analysis_runtime) fetch_ms: u64,
    pub(in crate::analysis_runtime) priority: AnalysisBackfillPriority,
}

#[derive(Default)]
pub(in crate::analysis_runtime) struct AnalysisCpuSeedQueueState {
    pub(in crate::analysis_runtime) high: VecDeque<AnalysisCpuSeedJob>,
    pub(in crate::analysis_runtime) middle: VecDeque<AnalysisCpuSeedJob>,
    pub(in crate::analysis_runtime) low: VecDeque<AnalysisCpuSeedJob>,
    /// Decodes in progress — same-id callers wait on the matching entry.
    pub(in crate::analysis_runtime) running: HashMap<String, RunningSeedJob>,
    pub(in crate::analysis_runtime) running_tiers: HashMap<String, AnalysisBackfillPriority>,
}

/// Scope key for cpu-seed dedup/merge: same track id on different servers is
/// different content. `\u{1f}` cannot appear in server ids or Subsonic ids.
pub(in crate::analysis_runtime) fn seed_key(server_id: &str, track_id: &str) -> String {
    format!("{server_id}\u{1f}{track_id}")
}

/// Full cpu-seed dedup identity: (server, track, content revision).
pub(in crate::analysis_runtime) fn seed_revision_key(
    server_id: &str,
    track_id: &str,
    revision: &str,
) -> String {
    format!("{server_id}\u{1f}{track_id}\u{1f}{revision}")
}

impl AnalysisCpuSeedQueueState {
    pub(in crate::analysis_runtime) fn queued_len(&self) -> usize {
        self.high.len() + self.middle.len() + self.low.len()
    }

    pub(in crate::analysis_runtime) fn queued_tier_counts(&self) -> AnalysisTierCounts {
        AnalysisTierCounts {
            high: self.high.len(),
            middle: self.middle.len(),
            low: self.low.len(),
        }
    }

    pub(in crate::analysis_runtime) fn running_tier_counts(&self) -> AnalysisTierCounts {
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

    pub(in crate::analysis_runtime) fn tier_deque(
        &self,
        tier: AnalysisBackfillPriority,
    ) -> &VecDeque<AnalysisCpuSeedJob> {
        match tier {
            AnalysisBackfillPriority::High => &self.high,
            AnalysisBackfillPriority::Middle => &self.middle,
            AnalysisBackfillPriority::Low => &self.low,
        }
    }

    pub(in crate::analysis_runtime) fn tier_deque_mut(
        &mut self,
        tier: AnalysisBackfillPriority,
    ) -> &mut VecDeque<AnalysisCpuSeedJob> {
        match tier {
            AnalysisBackfillPriority::High => &mut self.high,
            AnalysisBackfillPriority::Middle => &mut self.middle,
            AnalysisBackfillPriority::Low => &mut self.low,
        }
    }

    pub(in crate::analysis_runtime) fn locate_queued(
        &self,
        key: &str,
    ) -> Option<(AnalysisBackfillPriority, usize)> {
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

    pub(in crate::analysis_runtime) fn contains_revision(
        &self,
        server_id: &str,
        track_id: &str,
        revision: &str,
    ) -> bool {
        let key = seed_revision_key(server_id, track_id, revision);
        self.running.contains_key(&key) || self.locate_queued(&key).is_some()
    }

    pub(in crate::analysis_runtime) fn push_new(
        &mut self,
        priority: AnalysisBackfillPriority,
        job: AnalysisCpuSeedJob,
    ) {
        match priority {
            AnalysisBackfillPriority::High => self.high.push_front(job),
            AnalysisBackfillPriority::Middle => self.middle.push_back(job),
            AnalysisBackfillPriority::Low => self.low.push_back(job),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(in crate::analysis_runtime) fn enqueue(
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

    pub(in crate::analysis_runtime) fn prune_queued_not_in(
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

    pub(in crate::analysis_runtime) fn try_pop_next(&mut self) -> Option<AnalysisCpuSeedJob> {
        self.high
            .pop_front()
            .or_else(|| self.middle.pop_front())
            .or_else(|| self.low.pop_front())
    }

    pub(in crate::analysis_runtime) fn finish_running(&mut self, key: &str) -> Vec<SeedDoneSender> {
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

pub(in crate::analysis_runtime) struct AnalysisCpuSeedShared {
    pub(in crate::analysis_runtime) state: Mutex<AnalysisCpuSeedQueueState>,
    pub(in crate::analysis_runtime) wake_tx: tokio::sync::mpsc::UnboundedSender<()>,
    pub(in crate::analysis_runtime) max_parallel: AtomicUsize,
}

impl AnalysisCpuSeedShared {
    pub(in crate::analysis_runtime) fn ping_worker(&self) {
        let _ = self.wake_tx.send(());
    }

    pub(in crate::analysis_runtime) fn max_parallel(&self) -> usize {
        clamp_pipeline_parallelism(self.max_parallel.load(Ordering::Relaxed))
    }
}

pub(in crate::analysis_runtime) static ANALYSIS_CPU_SEED: OnceLock<Arc<AnalysisCpuSeedShared>> =
    OnceLock::new();

pub(in crate::analysis_runtime) fn analysis_cpu_seed_shared(
    app: &tauri::AppHandle,
) -> Arc<AnalysisCpuSeedShared> {
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
