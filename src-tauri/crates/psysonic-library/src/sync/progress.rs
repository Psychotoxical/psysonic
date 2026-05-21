//! C6 — progress channel for the sync runners (spec §6 emit limit
//! `≤2 events/s`). The runners call `Progress::emit` at phase
//! transitions and per-batch checkpoints; the supervisor wraps an
//! `mpsc::UnboundedSender` so the top crate (PR-5) can forward events
//! to Tauri's emit surface.
//!
//! Non-terminal events are rate-limited. `IngestPage` updates are
//! **coalesced** (latest `ingested_total` wins) so fast S1/N1 batches
//! do not leave the UI stuck on a stale count between throttled emits.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::repos::RemapEntry;

/// Per-batch ingest timings (DevTools + terminal diagnosis).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestBatchMetrics {
    pub offset: u32,
    pub strategy: String,
    pub fetch_ms: u32,
    pub write_ms: u32,
    pub lock_wait_ms: u32,
    pub sql_exec_ms: u32,
    pub persist_ms: u32,
    pub row_count: u32,
    pub bulk_ingest_active: bool,
}

/// Lean event union — server_id / library_scope context lives on the
/// channel side (one supervisor = one scope). Top-crate code wraps
/// these into Tauri events with their own envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgressEvent {
    PhaseChanged { phase: String },
    IngestPage {
        ingested_total: u32,
        batch_count: u32,
        metrics: Option<IngestBatchMetrics>,
    },
    Remapped { entries: Vec<RemapEntry> },
    Tombstoned { deleted_count: u32, checked_count: u32 },
    Completed { kind: String },
    Error { message: String },
}

impl ProgressEvent {
    /// Terminal events always bypass the throttle so callers never
    /// miss a "we're done" / "we crashed" signal.
    pub fn always_emit(&self) -> bool {
        matches!(self, Self::Completed { .. } | Self::Error { .. })
    }
}

pub trait Progress: Send + Sync {
    fn emit(&self, event: ProgressEvent);
}

/// No-op implementation. Used as the default when runners are called
/// outside a supervisor (tests, future ad-hoc invocations).
pub struct NoopProgress;

impl Progress for NoopProgress {
    fn emit(&self, _event: ProgressEvent) {}
}

/// `Progress` impl that forwards through a tokio mpsc channel,
/// throttling non-terminal events to the configured `min_interval`.
pub struct ChannelProgress {
    sender: tokio::sync::mpsc::UnboundedSender<ProgressEvent>,
    min_interval: Duration,
    last_emit: Mutex<Option<Instant>>,
    /// Latest ingest checkpoint held back while the throttle gate is closed.
    pending_ingest: Mutex<Option<(u32, u32, Option<IngestBatchMetrics>)>>,
}

impl ChannelProgress {
    /// 500 ms gate ≈ 2 events/s per spec §6.
    pub const DEFAULT_INTERVAL: Duration = Duration::from_millis(500);

    pub fn new(sender: tokio::sync::mpsc::UnboundedSender<ProgressEvent>) -> Self {
        Self::with_interval(sender, Self::DEFAULT_INTERVAL)
    }

    pub fn with_interval(
        sender: tokio::sync::mpsc::UnboundedSender<ProgressEvent>,
        min_interval: Duration,
    ) -> Self {
        Self {
            sender,
            min_interval,
            last_emit: Mutex::new(None),
            pending_ingest: Mutex::new(None),
        }
    }

    fn flush_pending_ingest(&self) {
        let pending = self
            .pending_ingest
            .lock()
            .expect("progress pending lock poisoned")
            .take();
        if let Some((ingested_total, batch_count, metrics)) = pending {
            let _ = self.sender.send(ProgressEvent::IngestPage {
                ingested_total,
                batch_count,
                metrics,
            });
        }
    }

    fn throttle_open(&self) -> bool {
        if self.min_interval.is_zero() {
            return true;
        }
        let last = self.last_emit.lock().expect("progress lock poisoned");
        match *last {
            None => true,
            Some(prev) if prev.elapsed() >= self.min_interval => true,
            Some(_) => false,
        }
    }

    fn mark_emitted(&self) {
        if self.min_interval.is_zero() {
            return;
        }
        *self
            .last_emit
            .lock()
            .expect("progress lock poisoned") = Some(Instant::now());
    }
}

impl Progress for ChannelProgress {
    fn emit(&self, event: ProgressEvent) {
        if event.always_emit() {
            self.flush_pending_ingest();
            let _ = self.sender.send(event);
            return;
        }

        if let ProgressEvent::IngestPage {
            ingested_total,
            batch_count,
            metrics,
        } = event
        {
            let gate_open = self.throttle_open();
            {
                let mut pending = self
                    .pending_ingest
                    .lock()
                    .expect("progress pending lock poisoned");
                if gate_open {
                    if let Some((total, batch, m)) = pending.take() {
                        let _ = self.sender.send(ProgressEvent::IngestPage {
                            ingested_total: total,
                            batch_count: batch,
                            metrics: m,
                        });
                    }
                }
                *pending = Some((ingested_total, batch_count, metrics));
            }
            if gate_open {
                self.mark_emitted();
                self.flush_pending_ingest();
            }
            return;
        }

        if !self.min_interval.is_zero() && !self.throttle_open() {
            return;
        }
        self.flush_pending_ingest();
        self.mark_emitted();
        let _ = self.sender.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;
    use tokio::sync::mpsc;

    #[test]
    fn noop_progress_swallows_events_without_panicking() {
        let p = NoopProgress;
        p.emit(ProgressEvent::PhaseChanged { phase: "ingest".into() });
        p.emit(ProgressEvent::Completed { kind: "initial_sync".into() });
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn zero_interval_channel_emits_every_event() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let p = ChannelProgress::with_interval(tx, Duration::ZERO);
        for i in 0..10 {
            p.emit(ProgressEvent::IngestPage {
                ingested_total: i,
                batch_count: 1,
                metrics: None,
            });
        }
        let mut received = 0;
        while rx.try_recv().is_ok() {
            received += 1;
        }
        assert_eq!(received, 10, "ZERO interval must not drop anything");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn terminal_events_bypass_throttle() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let p = ChannelProgress::with_interval(tx, Duration::from_secs(60));
        p.emit(ProgressEvent::IngestPage {
            ingested_total: 999,
            batch_count: 3,
                metrics: None,
        });
        p.emit(ProgressEvent::Completed { kind: "delta_sync".into() });
        p.emit(ProgressEvent::Error { message: "boom".into() });
        assert!(matches!(
            rx.try_recv(),
            Ok(ProgressEvent::IngestPage {
                ingested_total: 999,
                ..
            })
        ));
        assert!(matches!(
            rx.try_recv(),
            Ok(ProgressEvent::Completed { .. })
        ));
        assert!(matches!(rx.try_recv(), Ok(ProgressEvent::Error { .. })));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn non_terminal_events_collapse_under_throttle() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let p = ChannelProgress::with_interval(tx, Duration::from_millis(100));
        p.emit(ProgressEvent::PhaseChanged { phase: "a".into() });
        p.emit(ProgressEvent::PhaseChanged { phase: "b".into() });
        assert!(matches!(
            rx.try_recv(),
            Ok(ProgressEvent::PhaseChanged { ref phase }) if phase == "a"
        ));
        assert!(rx.try_recv().is_err(), "second emit must have been dropped");

        thread::sleep(Duration::from_millis(120));
        p.emit(ProgressEvent::PhaseChanged { phase: "c".into() });
        assert!(matches!(
            rx.try_recv(),
            Ok(ProgressEvent::PhaseChanged { ref phase }) if phase == "c"
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ingest_pages_coalesce_to_latest_within_throttle_window() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let p = ChannelProgress::with_interval(tx, Duration::from_millis(100));
        p.emit(ProgressEvent::IngestPage {
            ingested_total: 500,
            batch_count: 1,
                metrics: None,
        });
        p.emit(ProgressEvent::IngestPage {
            ingested_total: 2500,
            batch_count: 5,
                metrics: None,
        });
        p.emit(ProgressEvent::IngestPage {
            ingested_total: 5000,
            batch_count: 10,
                metrics: None,
        });
        assert!(matches!(
            rx.try_recv(),
            Ok(ProgressEvent::IngestPage {
                ingested_total: 500,
                ..
            })
        ));
        assert!(rx.try_recv().is_err(), "bursts must coalesce, not stack");

        thread::sleep(Duration::from_millis(120));
        p.emit(ProgressEvent::IngestPage {
            ingested_total: 5500,
            batch_count: 11,
                metrics: None,
        });
        assert!(
            matches!(
                rx.try_recv(),
                Ok(ProgressEvent::IngestPage {
                    ingested_total: 5000,
                    ..
                })
            ),
            "latest pending count must flush when the gate opens"
        );
        assert!(matches!(
            rx.try_recv(),
            Ok(ProgressEvent::IngestPage {
                ingested_total: 5500,
                ..
            })
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closed_receiver_does_not_panic_the_sender() {
        let (tx, rx) = mpsc::unbounded_channel();
        let p = ChannelProgress::with_interval(tx, Duration::ZERO);
        drop(rx);
        p.emit(ProgressEvent::PhaseChanged { phase: "x".into() });
    }

    #[test]
    fn always_emit_true_for_terminal_events() {
        assert!(ProgressEvent::Completed { kind: "k".into() }.always_emit());
        assert!(ProgressEvent::Error { message: "m".into() }.always_emit());
        assert!(!ProgressEvent::PhaseChanged { phase: "p".into() }.always_emit());
    }
}
