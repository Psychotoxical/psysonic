//! C6 — progress channel for the sync runners (spec §6 emit limit
//! `≤2 events/s`). The runners call `Progress::emit` at phase
//! transitions and per-batch checkpoints; the supervisor wraps an
//! `mpsc::UnboundedSender` so the top crate (PR-5) can forward events
//! to Tauri's emit surface.
//!
//! The throttle is intentionally simple — last-emit timestamp +
//! min-interval gate, terminal events (Completed / Error) bypass the
//! gate so the caller always sees the final state.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::repos::RemapEntry;

/// Lean event union — server_id / library_scope context lives on the
/// channel side (one supervisor = one scope). Top-crate code wraps
/// these into Tauri events with their own envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgressEvent {
    PhaseChanged { phase: String },
    IngestPage { ingested_total: u32, batch_count: u32 },
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
        }
    }
}

impl Progress for ChannelProgress {
    fn emit(&self, event: ProgressEvent) {
        if !event.always_emit() && !self.min_interval.is_zero() {
            let mut last = self.last_emit.lock().expect("progress lock poisoned");
            if let Some(prev) = *last {
                if prev.elapsed() < self.min_interval {
                    return; // dropped — too soon since last non-terminal emit
                }
            }
            *last = Some(Instant::now());
        }
        // Receiver may have closed (consumer disconnected); ignoring
        // the SendError is the right call — runner keeps going.
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
        // Two terminal events in quick succession — both must arrive.
        p.emit(ProgressEvent::Completed { kind: "delta_sync".into() });
        p.emit(ProgressEvent::Error { message: "boom".into() });
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
        // First emit lands. Second comes immediately after → throttled.
        p.emit(ProgressEvent::PhaseChanged { phase: "a".into() });
        p.emit(ProgressEvent::PhaseChanged { phase: "b".into() });
        assert!(matches!(
            rx.try_recv(),
            Ok(ProgressEvent::PhaseChanged { ref phase }) if phase == "a"
        ));
        assert!(rx.try_recv().is_err(), "second emit must have been dropped");

        // After the gate expires, the next emit goes through.
        thread::sleep(Duration::from_millis(120));
        p.emit(ProgressEvent::PhaseChanged { phase: "c".into() });
        assert!(matches!(
            rx.try_recv(),
            Ok(ProgressEvent::PhaseChanged { ref phase }) if phase == "c"
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closed_receiver_does_not_panic_the_sender() {
        let (tx, rx) = mpsc::unbounded_channel();
        let p = ChannelProgress::with_interval(tx, Duration::ZERO);
        drop(rx); // consumer goes away
        p.emit(ProgressEvent::PhaseChanged { phase: "x".into() });
        // Test passes if we get here.
    }

    #[test]
    fn always_emit_true_for_terminal_events() {
        assert!(ProgressEvent::Completed { kind: "k".into() }.always_emit());
        assert!(ProgressEvent::Error { message: "m".into() }.always_emit());
        assert!(!ProgressEvent::PhaseChanged { phase: "p".into() }.always_emit());
    }
}
