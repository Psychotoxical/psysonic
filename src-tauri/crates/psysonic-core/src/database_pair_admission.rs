use std::cell::Cell;
use std::marker::PhantomData;
use std::rc::Rc;
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};

#[derive(Debug, Default)]
struct AdmissionState {
    active_readers: usize,
    waiting_writers: usize,
    writer_active: bool,
}

#[derive(Debug, Default)]
struct DatabasePairAdmission {
    state: Mutex<AdmissionState>,
    changed: Condvar,
}

thread_local! {
    static READ_DEPTH: Cell<usize> = const { Cell::new(0) };
    static WRITE_DEPTH: Cell<usize> = const { Cell::new(0) };
}

fn admission() -> &'static DatabasePairAdmission {
    static ADMISSION: OnceLock<DatabasePairAdmission> = OnceLock::new();
    ADMISSION.get_or_init(DatabasePairAdmission::default)
}

fn lock_state() -> MutexGuard<'static, AdmissionState> {
    admission()
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Holds process-wide admission for a cross-store operation.
///
/// The guard is deliberately thread-bound because same-thread nesting is
/// tracked with thread-local depth.
pub struct DatabasePairReadGuard {
    _thread_bound: PhantomData<Rc<()>>,
}

impl Drop for DatabasePairReadGuard {
    fn drop(&mut self) {
        READ_DEPTH.with(|depth| {
            let current = depth.get();
            debug_assert!(current > 0, "database-pair read depth underflow");
            depth.set(current.saturating_sub(1));
        });

        let mut state = lock_state();
        debug_assert!(state.active_readers > 0, "database-pair reader underflow");
        state.active_readers = state.active_readers.saturating_sub(1);
        if state.active_readers == 0 {
            admission().changed.notify_all();
        }
    }
}

/// Holds exclusive process-wide admission while the active library/analysis
/// database pair is being transitioned.
pub struct DatabasePairWriteGuard {
    _thread_bound: PhantomData<Rc<()>>,
}

impl Drop for DatabasePairWriteGuard {
    fn drop(&mut self) {
        WRITE_DEPTH.with(|depth| {
            debug_assert_eq!(depth.get(), 1, "database-pair write depth mismatch");
            depth.set(0);
        });

        let mut state = lock_state();
        debug_assert!(state.writer_active, "database-pair writer was not active");
        state.writer_active = false;
        admission().changed.notify_all();
    }
}

/// Admit a cross-store reader. New readers wait behind queued writers, while a
/// reader already admitted on this thread may nest without deadlocking.
pub fn database_pair_read_scope() -> DatabasePairReadGuard {
    let nested = READ_DEPTH.with(|depth| depth.get() > 0);
    WRITE_DEPTH.with(|depth| {
        assert_eq!(
            depth.get(),
            0,
            "database-pair read scope cannot be acquired inside a write scope"
        );
    });

    let mut state = lock_state();
    while !nested && (state.writer_active || state.waiting_writers > 0) {
        state = admission()
            .changed
            .wait(state)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    debug_assert!(!state.writer_active);
    state.active_readers += 1;
    READ_DEPTH.with(|depth| depth.set(depth.get() + 1));
    DatabasePairReadGuard {
        _thread_bound: PhantomData,
    }
}

/// Admit the sole database-pair writer. Writes are intentionally not
/// reentrant; callers must keep verification inside the existing write scope.
pub fn database_pair_write_scope() -> DatabasePairWriteGuard {
    READ_DEPTH.with(|depth| {
        assert_eq!(
            depth.get(),
            0,
            "database-pair write scope cannot be acquired inside a read scope"
        );
    });
    WRITE_DEPTH.with(|depth| {
        assert_eq!(depth.get(), 0, "database-pair write scopes are not reentrant");
    });

    let mut state = lock_state();
    state.waiting_writers += 1;
    admission().changed.notify_all();
    while state.writer_active || state.active_readers > 0 {
        state = admission()
            .changed
            .wait(state)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
    state.waiting_writers -= 1;
    state.writer_active = true;
    WRITE_DEPTH.with(|depth| depth.set(1));
    DatabasePairWriteGuard {
        _thread_bound: PhantomData,
    }
}

pub fn with_database_pair_read_scope<R>(operation: impl FnOnce() -> R) -> R {
    let _guard = database_pair_read_scope();
    operation()
}

pub fn with_database_pair_write_scope<R>(operation: impl FnOnce() -> R) -> R {
    let _guard = database_pair_write_scope();
    operation()
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::*;

    fn test_serial_guard() -> MutexGuard<'static, ()> {
        static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wait_for_queued_writer() {
        let mut state = lock_state();
        while state.waiting_writers == 0 {
            state = admission()
                .changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    #[test]
    fn queued_writer_precedes_new_reader() {
        let _serial = test_serial_guard();
        let first_reader = database_pair_read_scope();
        let (writer_acquired_tx, writer_acquired_rx) = mpsc::channel();
        let (release_writer_tx, release_writer_rx) = mpsc::channel();
        let writer = thread::spawn(move || {
            let _writer = database_pair_write_scope();
            writer_acquired_tx.send(()).unwrap();
            release_writer_rx.recv().unwrap();
        });
        wait_for_queued_writer();

        let (reader_acquired_tx, reader_acquired_rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let _reader = database_pair_read_scope();
            reader_acquired_tx.send(()).unwrap();
        });

        drop(first_reader);
        writer_acquired_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("queued writer should acquire after the active reader");
        assert!(reader_acquired_rx.try_recv().is_err());
        release_writer_tx.send(()).unwrap();
        reader_acquired_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("reader should acquire after the writer releases");

        writer.join().unwrap();
        reader.join().unwrap();
    }

    #[test]
    fn nested_reader_is_admitted_while_writer_waits() {
        let _serial = test_serial_guard();
        let outer = database_pair_read_scope();
        let (writer_acquired_tx, writer_acquired_rx) = mpsc::channel();
        let writer = thread::spawn(move || {
            let _writer = database_pair_write_scope();
            writer_acquired_tx.send(()).unwrap();
        });
        wait_for_queued_writer();

        let nested = database_pair_read_scope();
        drop(nested);
        assert!(writer_acquired_rx.try_recv().is_err());
        drop(outer);
        writer_acquired_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("writer should acquire after the outer reader releases");
        writer.join().unwrap();
    }
}
