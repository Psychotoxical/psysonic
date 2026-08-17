use std::sync::atomic::Ordering;
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use super::LibraryStore;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ReadOpTiming {
    pub lock_wait_ms: u64,
    pub exec_ms: u64,
    pub blocked_by: Option<ReadOpOwner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ReadOpOwner {
    pub file: &'static str,
    pub line: u32,
}

struct ReadOpOwnerGuard<'a> {
    owner: &'a Mutex<Option<ReadOpOwner>>,
}

impl Drop for ReadOpOwnerGuard<'_> {
    fn drop(&mut self) {
        match self.owner.lock() {
            Ok(mut current) => *current = None,
            Err(poisoned) => *poisoned.into_inner() = None,
        }
    }
}

impl LibraryStore {
    pub(crate) fn set_bulk_ingest_active(&self, active: bool) {
        self.bulk_ingest_active.store(active, Ordering::Release);
    }

    pub(crate) fn bulk_ingest_active(&self) -> bool {
        self.bulk_ingest_active.load(Ordering::Acquire)
    }

    fn swap_in_progress(&self) -> bool {
        self.swap_in_progress.load(Ordering::Acquire)
    }

    fn lock_write_conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        if self.swap_in_progress() {
            return Err("library database swap in progress".to_string());
        }
        match self.write_conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                crate::app_eprintln!("[library-db] write lock was poisoned — recovering");
                Ok(poisoned.into_inner())
            }
        }
    }

    fn lock_read_conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        if self.swap_in_progress() {
            return Err("library database swap in progress".to_string());
        }
        match self.read_conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                crate::app_eprintln!("[library-db] read lock was poisoned — recovering");
                Ok(poisoned.into_inner())
            }
        }
    }

    fn lock_mainstage_read_conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        if self.swap_in_progress() {
            return Err("library database swap in progress".to_string());
        }
        match self.mainstage_read_conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                crate::app_eprintln!("[library-db] mainstage read lock was poisoned — recovering");
                Ok(poisoned.into_inner())
            }
        }
    }

    fn lock_scope_detail_read_conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        if self.swap_in_progress() {
            return Err("library database swap in progress".to_string());
        }
        match self.scope_detail_read_conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                crate::app_eprintln!(
                    "[library-db] scope detail read lock was poisoned — recovering"
                );
                Ok(poisoned.into_inner())
            }
        }
    }

    /// Writer connection — sync ingest, migrations, mutations.
    ///
    /// `op` is logged on slow writes (`[library-db] SLOW write op=…`) — use a
    /// stable `module.action` label (e.g. `sync_state.set_sync_phase`,
    /// `track.upsert_batch_remap`), not the generic `"misc"`, so production
    /// stalls can be attributed to a specific call site.
    pub(crate) fn with_conn<R>(
        &self,
        op: &'static str,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let lock_start = std::time::Instant::now();
        let conn = self.lock_write_conn()?;
        let lock_wait_ms = lock_start.elapsed().as_millis();
        let exec_start = std::time::Instant::now();
        let out = run_conn_closure(&conn, f);
        let exec_ms = exec_start.elapsed().as_millis();
        log_write_op(op, lock_wait_ms, exec_ms);
        out
    }

    /// Read-only connection — search, status, hydrate; does not block on sync writes.
    #[track_caller]
    pub(crate) fn with_read_conn<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let conn = self.lock_read_conn()?;
        let _owner = self.mark_read_owner(std::panic::Location::caller());
        run_conn_closure(&conn, f)
    }

    #[track_caller]
    pub(crate) fn with_read_conn_timed<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<(R, ReadOpTiming), String> {
        let blocked_by = self.read_op_owner();
        let lock_start = std::time::Instant::now();
        let conn = self.lock_read_conn()?;
        let lock_wait_ms = lock_start.elapsed().as_millis() as u64;
        let _owner = self.mark_read_owner(std::panic::Location::caller());
        let exec_start = std::time::Instant::now();
        let value = run_conn_closure(&conn, f)?;
        let exec_ms = exec_start.elapsed().as_millis() as u64;
        Ok((
            value,
            ReadOpTiming {
                lock_wait_ms,
                exec_ms,
                blocked_by: (lock_wait_ms > 0).then_some(blocked_by).flatten(),
            },
        ))
    }

    /// Isolated reader for wide Mainstage scans. All other browse paths retain
    /// `read_conn`, keeping short local reads responsive while Home loads.
    ///
    /// Always reports how long the caller queued for the connection and who held
    /// it. Several unrelated surfaces share this reader — the chronological
    /// feeds, the genre-count aggregate that accompanies them, the hot-release
    /// overlay and the sidebar unread badge. When one of them is slow the others
    /// simply stop, and from the outside that is indistinguishable from a slow
    /// query of their own. `blocked_by` names the caller that held the lock, so
    /// the distinction survives into the log. There is deliberately no untimed
    /// variant: the measurement costs two `Instant::now` calls, and every caller
    /// here is a surface where the answer has already been needed once.
    #[track_caller]
    pub(crate) fn with_mainstage_read_conn_timed<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<(R, ReadOpTiming), String> {
        let blocked_by = self.mainstage_read_op_owner();
        let lock_start = std::time::Instant::now();
        let conn = self.lock_mainstage_read_conn()?;
        let lock_wait_ms = lock_start.elapsed().as_millis() as u64;
        let _owner = self.mark_mainstage_read_owner(std::panic::Location::caller());
        let exec_start = std::time::Instant::now();
        let value = run_conn_closure(&conn, f)?;
        let exec_ms = exec_start.elapsed().as_millis() as u64;
        Ok((
            value,
            ReadOpTiming {
                lock_wait_ms,
                exec_ms,
                blocked_by: (lock_wait_ms > 0).then_some(blocked_by).flatten(),
            },
        ))
    }

    /// Isolated reader for heavy derived reads, which can be much wider than
    /// ordinary browse reads even when their result page is small.
    pub(crate) fn with_scope_detail_read_conn<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let conn = self.lock_scope_detail_read_conn()?;
        run_conn_closure(&conn, f)
    }

    fn read_op_owner(&self) -> Option<ReadOpOwner> {
        match self.read_op_owner.lock() {
            Ok(owner) => *owner,
            Err(poisoned) => *poisoned.into_inner(),
        }
    }

    fn mark_read_owner(
        &self,
        caller: &'static std::panic::Location<'static>,
    ) -> ReadOpOwnerGuard<'_> {
        let owner = ReadOpOwner {
            file: caller.file(),
            line: caller.line(),
        };
        match self.read_op_owner.lock() {
            Ok(mut current) => *current = Some(owner),
            Err(poisoned) => *poisoned.into_inner() = Some(owner),
        }
        ReadOpOwnerGuard {
            owner: &self.read_op_owner,
        }
    }

    fn mainstage_read_op_owner(&self) -> Option<ReadOpOwner> {
        match self.mainstage_read_op_owner.lock() {
            Ok(owner) => *owner,
            Err(poisoned) => *poisoned.into_inner(),
        }
    }

    fn mark_mainstage_read_owner(
        &self,
        caller: &'static std::panic::Location<'static>,
    ) -> ReadOpOwnerGuard<'_> {
        let owner = ReadOpOwner {
            file: caller.file(),
            line: caller.line(),
        };
        match self.mainstage_read_op_owner.lock() {
            Ok(mut current) => *current = Some(owner),
            Err(poisoned) => *poisoned.into_inner() = Some(owner),
        }
        ReadOpOwnerGuard {
            owner: &self.mainstage_read_op_owner,
        }
    }

    pub(crate) fn with_conn_mut<R>(
        &self,
        op: &'static str,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        self.with_conn_mut_timed(op, f).map(|(value, _)| value)
    }

    pub(crate) fn with_conn_mut_timed<R>(
        &self,
        op: &'static str,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<R>,
    ) -> Result<(R, WriteOpTiming), String> {
        let lock_start = std::time::Instant::now();
        let mut conn = self.lock_write_conn()?;
        let lock_wait_ms = lock_start.elapsed().as_millis() as u64;
        let exec_start = std::time::Instant::now();
        let out = run_conn_mut_closure(&mut conn, f)?;
        let exec_ms = exec_start.elapsed().as_millis() as u64;
        log_write_op(op, lock_wait_ms as u128, exec_ms as u128);
        Ok((
            out,
            WriteOpTiming {
                lock_wait_ms,
                exec_ms,
            },
        ))
    }

    pub(crate) fn checkpoint_wal(&self, op: &'static str) -> Result<(), String> {
        self.with_conn_mut(op, |conn| {
            super::open::checkpoint_wal_conn(conn, op)?;
            Ok(())
        })
    }
}

/// Timing split returned to ingest progress (DevTools / terminal).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WriteOpTiming {
    pub lock_wait_ms: u64,
    pub exec_ms: u64,
}

impl WriteOpTiming {
    pub fn total_ms(&self) -> u64 {
        self.lock_wait_ms.saturating_add(self.exec_ms)
    }
}

fn log_write_op(op: &str, lock_wait_ms: u128, exec_ms: u128) {
    if lock_wait_ms >= 1000 || exec_ms >= 1000 {
        crate::app_eprintln!(
            "[library-db] SLOW write op={op} lock_wait_ms={lock_wait_ms} exec_ms={exec_ms}"
        );
    } else if lock_wait_ms >= 50 || exec_ms >= 200 {
        crate::app_eprintln!(
            "[library-db] write op={op} lock_wait_ms={lock_wait_ms} exec_ms={exec_ms}"
        );
    }
}

fn run_conn_closure<R>(
    conn: &Connection,
    f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
) -> Result<R, String> {
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(conn)));
    match out {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(payload) => {
            let detail = panic_payload_to_string(payload);
            crate::app_eprintln!("[library-db] connection query panicked: {detail}");
            Err(format!("library connection query panicked: {detail}"))
        }
    }
}

fn run_conn_mut_closure<R>(
    conn: &mut Connection,
    f: impl FnOnce(&mut Connection) -> rusqlite::Result<R>,
) -> Result<R, String> {
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(conn)));
    match out {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(payload) => {
            let detail = panic_payload_to_string(payload);
            crate::app_eprintln!("[library-db] connection mutation panicked: {detail}");
            Err(format!("library connection mutation panicked: {detail}"))
        }
    }
}

fn panic_payload_to_string(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(msg) = payload.downcast_ref::<&str>() {
        msg.to_string()
    } else if let Some(msg) = payload.downcast_ref::<String>() {
        msg.clone()
    } else {
        "unknown panic payload".to_string()
    }
}
