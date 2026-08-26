use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::analysis_cache;

#[derive(Default)]
struct AdmissionState {
    readers: usize,
    writer_active: bool,
    waiting_writers: usize,
}

#[derive(Default)]
struct AnalysisQueueAdmission {
    state: Mutex<AdmissionState>,
    changed: Condvar,
}

impl AnalysisQueueAdmission {
    fn ordinary_guard(self: &Arc<Self>) -> OrdinaryAdmissionGuard {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        while state.writer_active || state.waiting_writers > 0 {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
        state.readers += 1;
        OrdinaryAdmissionGuard {
            admission: Arc::clone(self),
        }
    }

    fn migration_guard(
        self: &Arc<Self>,
        timeout: Duration,
    ) -> Result<MigrationAdmissionGuard, String> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.waiting_writers += 1;
        self.changed.notify_all();
        let started = Instant::now();
        while state.writer_active || state.readers > 0 {
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                state.waiting_writers = state.waiting_writers.saturating_sub(1);
                self.changed.notify_all();
                return Err("timed out acquiring exclusive analysis migration admission".to_string());
            }
            let (next, wait) = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|error| error.into_inner());
            state = next;
            if wait.timed_out() && (state.writer_active || state.readers > 0) {
                state.waiting_writers = state.waiting_writers.saturating_sub(1);
                self.changed.notify_all();
                return Err("timed out acquiring exclusive analysis migration admission".to_string());
            }
        }
        state.waiting_writers -= 1;
        state.writer_active = true;
        Ok(MigrationAdmissionGuard {
            admission: Arc::clone(self),
        })
    }

    #[cfg(test)]
    fn wait_for_migration_waiter(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        while state.waiting_writers == 0 {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }
}

pub(super) struct OrdinaryAdmissionGuard {
    admission: Arc<AnalysisQueueAdmission>,
}

impl Drop for OrdinaryAdmissionGuard {
    fn drop(&mut self) {
        let mut state = self
            .admission
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.readers = state.readers.saturating_sub(1);
        if state.readers == 0 {
            self.admission.changed.notify_all();
        }
    }
}

struct MigrationAdmissionGuard {
    admission: Arc<AnalysisQueueAdmission>,
}

impl Drop for MigrationAdmissionGuard {
    fn drop(&mut self) {
        let mut state = self
            .admission
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.writer_active = false;
        self.admission.changed.notify_all();
    }
}

pub struct AnalysisMigrationAdmissionGuard {
    _guard: MigrationAdmissionGuard,
}

fn analysis_queue_admission() -> Arc<AnalysisQueueAdmission> {
    static ADMISSION: OnceLock<Arc<AnalysisQueueAdmission>> = OnceLock::new();
    Arc::clone(ADMISSION.get_or_init(|| Arc::new(AnalysisQueueAdmission::default())))
}

#[cfg(test)]
pub(super) async fn admission_test_guard() -> tokio::sync::OwnedMutexGuard<()> {
    static TEST_LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    Arc::clone(TEST_LOCK.get_or_init(|| Arc::new(tokio::sync::Mutex::new(()))))
        .lock_owned()
        .await
}

#[cfg(test)]
pub(super) fn ordinary_admission_guard_for_test() -> OrdinaryAdmissionGuard {
    analysis_queue_admission().ordinary_guard()
}

fn ensure_queue_write_allowed(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
        cache.ensure_ordinary_write_allowed()?;
    }
    Ok(())
}

pub(super) fn ordinary_queue_admission_guard(
    app: &tauri::AppHandle,
) -> Result<OrdinaryAdmissionGuard, String> {
    ensure_queue_write_allowed(app)?;
    let guard = analysis_queue_admission().ordinary_guard();
    if let Err(error) = ensure_queue_write_allowed(app) {
        drop(guard);
        return Err(error);
    }
    Ok(guard)
}

pub(super) async fn ordinary_queue_admission_guard_async(
    app: &tauri::AppHandle,
) -> Result<OrdinaryAdmissionGuard, String> {
    ensure_queue_write_allowed(app)?;
    let admission = analysis_queue_admission();
    let guard = tokio::task::spawn_blocking(move || admission.ordinary_guard())
        .await
        .map_err(|error| format!("analysis queue admission task failed: {error}"))?;
    if let Err(error) = ensure_queue_write_allowed(app) {
        drop(guard);
        return Err(error);
    }
    Ok(guard)
}

/// Lock ordering for canonical migration is library migration admission/state,
/// activated library generation, filesystem migration writer, then this guard.
/// Taking analysis exclusivity before the filesystem writer can deadlock an
/// in-flight filesystem holder that still needs ordinary analysis admission.
pub async fn analysis_migration_admission_guard(
    timeout: Duration,
) -> Result<AnalysisMigrationAdmissionGuard, String> {
    let admission = analysis_queue_admission();
    let guard = tokio::task::spawn_blocking(move || admission.migration_guard(timeout))
        .await
        .map_err(|error| format!("analysis migration admission task failed: {error}"))??;
    Ok(AnalysisMigrationAdmissionGuard { _guard: guard })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use tokio::sync::oneshot;

    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn in_flight_enqueue_finishes_before_activation_and_none_cross_drain() {
        let admission = Arc::new(AnalysisQueueAdmission::default());
        let barrier_active = Arc::new(AtomicBool::new(false));
        let queue = Arc::new(Mutex::new(Vec::<String>::new()));

        let (insertion_started_tx, insertion_started_rx) = oneshot::channel();
        let (continue_insertion_tx, continue_insertion_rx) = mpsc::channel();
        let admission_for_inflight = Arc::clone(&admission);
        let barrier_for_inflight = Arc::clone(&barrier_active);
        let queue_for_inflight = Arc::clone(&queue);
        let inflight = std::thread::spawn(move || {
            assert!(!barrier_for_inflight.load(Ordering::Acquire));
            let _guard = admission_for_inflight.ordinary_guard();
            assert!(!barrier_for_inflight.load(Ordering::Acquire));
            insertion_started_tx.send(()).unwrap();
            continue_insertion_rx.recv().unwrap();
            queue_for_inflight.lock().unwrap().push("legacy".into());
        });
        insertion_started_rx.await.unwrap();

        let (activation_tx, mut activation_rx) = oneshot::channel();
        let (drained_tx, drained_rx) = oneshot::channel();
        let (release_migration_tx, release_migration_rx) = oneshot::channel();
        let admission_for_migration = Arc::clone(&admission);
        let barrier_for_migration = Arc::clone(&barrier_active);
        let queue_for_migration = Arc::clone(&queue);
        let migration = tokio::spawn(async move {
            let admission_for_blocking = Arc::clone(&admission_for_migration);
            let _guard = tokio::task::spawn_blocking(move || {
                admission_for_blocking.migration_guard(Duration::from_secs(1))
            })
            .await
            .unwrap()
            .unwrap();
            barrier_for_migration.store(true, Ordering::Release);
            activation_tx.send(()).unwrap();
            queue_for_migration.lock().unwrap().clear();
            drained_tx.send(()).unwrap();
            release_migration_rx.await.unwrap();
        });

        let admission_for_waiter = Arc::clone(&admission);
        tokio::task::spawn_blocking(move || admission_for_waiter.wait_for_migration_waiter())
            .await
            .unwrap();

        let (late_prechecked_tx, late_prechecked_rx) = oneshot::channel();
        let admission_for_late = Arc::clone(&admission);
        let barrier_for_late = Arc::clone(&barrier_active);
        let queue_for_late = Arc::clone(&queue);
        let mut late = tokio::spawn(async move {
            assert!(!barrier_for_late.load(Ordering::Acquire));
            late_prechecked_tx.send(()).unwrap();
            let admission_for_blocking = Arc::clone(&admission_for_late);
            let guard = tokio::task::spawn_blocking(move || {
                admission_for_blocking.ordinary_guard()
            })
            .await
            .unwrap();
            if barrier_for_late.load(Ordering::Acquire) {
                drop(guard);
                return Err("migration barrier active");
            }
            queue_for_late.lock().unwrap().push("late-legacy".into());
            Ok(())
        });
        late_prechecked_rx.await.unwrap();

        assert!(tokio::time::timeout(Duration::from_millis(50), &mut activation_rx)
            .await
            .is_err());
        continue_insertion_tx.send(()).unwrap();
        inflight.join().unwrap();

        activation_rx.await.unwrap();
        drained_rx.await.unwrap();
        assert!(queue.lock().unwrap().is_empty());
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut late)
            .await
            .is_err());

        release_migration_tx.send(()).unwrap();
        migration.await.unwrap();
        assert_eq!(late.await.unwrap(), Err("migration barrier active"));
        assert!(queue.lock().unwrap().is_empty());
    }

    #[test]
    fn timed_out_writer_stops_blocking_new_ordinary_admission() {
        let admission = Arc::new(AnalysisQueueAdmission::default());
        let ordinary = admission.ordinary_guard();

        let error = admission
            .migration_guard(Duration::from_millis(10))
            .err()
            .expect("exclusive admission should time out");
        assert!(error.contains("timed out"));

        let second_ordinary = admission.ordinary_guard();
        drop(second_ordinary);
        drop(ordinary);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn enrichment_ordinary_admission_blocks_migration_until_work_finishes() {
        let _serial = admission_test_guard().await;
        let enrichment = ordinary_admission_guard_for_test();

        let error = analysis_migration_admission_guard(Duration::from_millis(20))
            .await
            .err()
            .expect("in-flight enrichment must block migration admission");
        assert!(error.contains("timed out"));

        drop(enrichment);
        let migration = analysis_migration_admission_guard(Duration::from_secs(1))
            .await
            .unwrap();
        drop(migration);
    }
}
