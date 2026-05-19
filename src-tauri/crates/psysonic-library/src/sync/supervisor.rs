//! C5 — `SyncSupervisor`. Wraps the spawn / cancel / join lifecycle
//! the top crate (PR-5) will use to run an `InitialSyncRunner` or
//! `DeltaSyncRunner` from a Tauri command. The supervisor owns the
//! cancellation `AtomicBool` and the `mpsc` receiver carrying
//! progress events.
//!
//! Stays pure library — no Tauri imports here; PR-5 hooks the
//! receiver to `AppHandle::emit`.

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::error::SyncError;
use super::progress::{ChannelProgress, Progress, ProgressEvent};

pub struct SyncSupervisor {
    cancel: Arc<AtomicBool>,
    handle: Option<tokio::task::JoinHandle<Result<(), SyncError>>>,
    progress_rx: Option<tokio::sync::mpsc::UnboundedReceiver<ProgressEvent>>,
}

impl SyncSupervisor {
    /// Spawn a sync workload. `task` receives the cancellation flag
    /// and a `Progress` handle backed by an internal mpsc channel.
    /// Caller drives the receiver via `progress_receiver()` and waits
    /// for completion via `join().await`.
    pub fn spawn<F, Fut>(task: F) -> Self
    where
        F: FnOnce(Arc<AtomicBool>, Arc<dyn Progress + Send + Sync>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), SyncError>> + Send + 'static,
    {
        Self::spawn_with_interval(task, ChannelProgress::DEFAULT_INTERVAL)
    }

    /// Variant that overrides the throttle interval — tests pass
    /// `Duration::ZERO` so every event observed in
    /// `progress_receiver()` matches the runner's emit order.
    pub fn spawn_with_interval<F, Fut>(task: F, throttle: std::time::Duration) -> Self
    where
        F: FnOnce(Arc<AtomicBool>, Arc<dyn Progress + Send + Sync>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), SyncError>> + Send + 'static,
    {
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let progress: Arc<dyn Progress + Send + Sync> =
            Arc::new(ChannelProgress::with_interval(tx, throttle));
        let cancel_clone = Arc::clone(&cancel);
        let handle = tokio::task::spawn(async move { task(cancel_clone, progress).await });
        Self {
            cancel,
            handle: Some(handle),
            progress_rx: Some(rx),
        }
    }

    /// Trip the cancellation flag. Runners check it between batches
    /// and bail out with `SyncError::Cancelled` on the next iteration.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Take the progress receiver. Single consumer only — the
    /// `Option::take` semantics mean later calls return `None`.
    pub fn progress_receiver(
        &mut self,
    ) -> Option<tokio::sync::mpsc::UnboundedReceiver<ProgressEvent>> {
        self.progress_rx.take()
    }

    /// Wait for the spawned task. Returns the task's `Result` —
    /// `Ok(Ok(()))` on clean exit, `Ok(Err(SyncError))` on a
    /// runner-level failure, `Err(JoinError)` only if the task
    /// panicked, in which case we surface that as `SyncError::Storage`
    /// so callers never need to know about tokio internals.
    pub async fn join(mut self) -> Result<(), SyncError> {
        let handle = self
            .handle
            .take()
            .ok_or_else(|| SyncError::Storage("supervisor already joined".into()))?;
        match handle.await {
            Ok(inner) => inner,
            Err(join_err) => Err(SyncError::Storage(format!(
                "sync task panicked: {join_err}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread")]
    async fn supervisor_runs_task_to_completion_and_emits_progress() {
        let mut sup = SyncSupervisor::spawn_with_interval(
            |_cancel, progress| async move {
                progress.emit(ProgressEvent::PhaseChanged { phase: "ingest".into() });
                progress.emit(ProgressEvent::Completed {
                    kind: "initial_sync".into(),
                });
                Ok(())
            },
            Duration::ZERO,
        );
        let mut rx = sup.progress_receiver().expect("receiver still in place");
        let result = sup.join().await;
        assert!(result.is_ok());
        let mut events = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            events.push(ev);
        }
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], ProgressEvent::PhaseChanged { .. }));
        assert!(matches!(events[1], ProgressEvent::Completed { .. }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn supervisor_cancel_trips_atomic_flag_before_task_joins() {
        let started = Arc::new(tokio::sync::Notify::new());
        let started_clone = Arc::clone(&started);
        let sup = SyncSupervisor::spawn(move |cancel, _progress| {
            let started = started_clone;
            async move {
                started.notify_one();
                // Spin until cancelled or 2s timeout.
                for _ in 0..200 {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(SyncError::Cancelled);
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Ok(())
            }
        });
        started.notified().await;
        sup.cancel();
        assert!(sup.is_cancelled());
        let result = sup.join().await;
        assert!(matches!(result, Err(SyncError::Cancelled)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn supervisor_propagates_task_panic_as_sync_error() {
        let sup = SyncSupervisor::spawn(|_cancel, _progress| async move {
            panic!("simulated task panic");
        });
        let result = sup.join().await;
        assert!(matches!(result, Err(SyncError::Storage(_))));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn progress_receiver_take_returns_none_after_first_call() {
        let mut sup = SyncSupervisor::spawn(|_cancel, _progress| async move { Ok(()) });
        let first = sup.progress_receiver();
        let second = sup.progress_receiver();
        assert!(first.is_some());
        assert!(second.is_none());
        sup.join().await.unwrap();
    }
}
