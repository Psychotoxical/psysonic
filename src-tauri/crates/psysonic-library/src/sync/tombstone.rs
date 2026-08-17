//! C4 — `TombstoneReconciler` (spec §6.7).
//!
//! Streams a chunk of local track ids, hits `getSong` per id, and
//! marks `track.deleted = 1` for every `SubsonicError::NotFound`
//! (error code 70). Designed for two callers:
//!
//! - **Mode A (manual integrity check):** Settings → "Verify library
//!   integrity" loops `reconcile_chunk(N)` until it returns
//!   `checked == 0`.
//! - **Mode B (auto, threshold-triggered):** the delta scheduler
//!   tests `should_auto_reconcile` against the count drop, then loops
//!   `reconcile_chunk(budget)` once per delta tick until the gap
//!   closes.
//!
//! Streaming so memory stays bounded at 500k: `LIMIT N ORDER BY
//! synced_at ASC` picks the next chunk; PR-3c keeps the loop entirely
//! caller-driven so cancellation is checked between chunks.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use psysonic_integration::subsonic::{SubsonicClient, SubsonicError};

use super::backoff::{jitter_salt, with_jitter, Backoff};
use super::error::SyncError;
use crate::repos::TrackRepository;
use crate::store::LibraryStore;

const MAX_ATTEMPTS_PER_BATCH: u32 = 5;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TombstoneReport {
    pub checked: u32,
    pub deleted: u32,
}

pub struct TombstoneReconciler<'a> {
    store: &'a LibraryStore,
    subsonic: &'a SubsonicClient,
    server_id: String,
    library_scope: String,
    cancel: Option<Arc<std::sync::atomic::AtomicBool>>,
    sleep_enabled: bool,
}

impl<'a> TombstoneReconciler<'a> {
    pub fn new(
        store: &'a LibraryStore,
        subsonic: &'a SubsonicClient,
        server_id: impl Into<String>,
    ) -> Self {
        Self {
            store,
            subsonic,
            server_id: server_id.into(),
            library_scope: String::new(),
            cancel: None,
            sleep_enabled: true,
        }
    }

    pub fn with_library_scope(mut self, library_scope: impl Into<String>) -> Self {
        self.library_scope = library_scope.into();
        self
    }

    pub fn with_cancellation(mut self, flag: Arc<std::sync::atomic::AtomicBool>) -> Self {
        self.cancel = Some(flag);
        self
    }

    pub fn with_sleep_disabled(mut self) -> Self {
        self.sleep_enabled = false;
        self
    }

    /// Process up to `budget` not-yet-checked tracks. Returns counts
    /// for this call only — caller loops until `checked == 0` to
    /// complete a Mode A pass, or stops at any budget for Mode B
    /// sampled passes. Order: oldest `synced_at` first so the most
    /// stale rows get re-validated soonest.
    pub async fn reconcile_chunk(&self, budget: u32) -> Result<TombstoneReport, SyncError> {
        if budget == 0 {
            return Ok(TombstoneReport::default());
        }
        let ids = self.next_candidates(budget)?;
        self.reconcile_ids(ids).await
    }

    /// Complete one bounded full pass over the rows that were live when the
    /// pass began. The captured max id and keyset cursor guarantee termination
    /// even though successful probes refresh `synced_at`.
    pub async fn reconcile_full_pass(&self, batch_size: u32) -> Result<TombstoneReport, SyncError> {
        if batch_size == 0 {
            return Ok(TombstoneReport::default());
        }
        let Some(cutoff_id) = self.capture_cutoff_id()? else {
            return Ok(TombstoneReport::default());
        };
        let mut report = TombstoneReport::default();
        let mut after_id: Option<String> = None;
        loop {
            let ids = self.next_candidates_after(after_id.as_deref(), &cutoff_id, batch_size)?;
            if ids.is_empty() {
                break;
            }
            after_id = ids.last().cloned();
            let chunk = self.reconcile_ids(ids).await?;
            report.checked = report.checked.saturating_add(chunk.checked);
            report.deleted = report.deleted.saturating_add(chunk.deleted);
        }
        Ok(report)
    }

    async fn reconcile_ids(&self, ids: Vec<String>) -> Result<TombstoneReport, SyncError> {
        let mut report = TombstoneReport::default();
        let mut alive_ids = Vec::new();
        let mut deleted_ids = Vec::new();
        for id in ids {
            self.check_cancellation()?;
            report.checked = report.checked.saturating_add(1);
            let outcome = retry_with_backoff(
                self,
                || self.subsonic.get_song(&id),
                |e: SubsonicError| -> SyncError { e.into() },
            )
            .await;
            match outcome {
                Ok(_) => {
                    alive_ids.push(id);
                }
                Err(SyncError::NotFound) => {
                    deleted_ids.push(id);
                    report.deleted = report.deleted.saturating_add(1);
                }
                Err(other) => return Err(other),
            }
        }
        TrackRepository::new(self.store)
            .apply_tombstone_results(
                &self.server_id,
                &self.library_scope,
                &alive_ids,
                &deleted_ids,
            )
            .map_err(SyncError::Storage)?;
        Ok(report)
    }

    fn check_cancellation(&self) -> Result<(), SyncError> {
        if let Some(flag) = &self.cancel {
            if flag.load(Ordering::SeqCst) {
                return Err(SyncError::Cancelled);
            }
        }
        Ok(())
    }

    fn next_candidates(&self, budget: u32) -> Result<Vec<String>, SyncError> {
        self.store
            .with_conn("tombstone.next_candidates", |c| {
                if self.library_scope.is_empty() {
                    let mut stmt = c.prepare(
                        "SELECT id FROM track \
                         WHERE server_id = ?1 AND deleted = 0 \
                         ORDER BY synced_at ASC, id ASC LIMIT ?2",
                    )?;
                    let rows = stmt
                        .query_map(rusqlite::params![self.server_id, budget as i64], |r| {
                            r.get::<_, String>(0)
                        })?
                        .collect();
                    rows
                } else {
                    let mut stmt = c.prepare(
                        "SELECT id FROM track \
                         WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0 \
                         ORDER BY synced_at ASC, id ASC LIMIT ?3",
                    )?;
                    let rows = stmt
                        .query_map(
                            rusqlite::params![self.server_id, self.library_scope, budget as i64],
                            |r| r.get::<_, String>(0),
                        )?
                        .collect();
                    rows
                }
            })
            .map_err(SyncError::Storage)
    }

    fn capture_cutoff_id(&self) -> Result<Option<String>, SyncError> {
        self.store
            .with_conn("tombstone.capture_cutoff", |c| {
                if self.library_scope.is_empty() {
                    c.query_row(
                        "SELECT MAX(id) FROM track WHERE server_id = ?1 AND deleted = 0",
                        rusqlite::params![self.server_id],
                        |row| row.get(0),
                    )
                } else {
                    c.query_row(
                        "SELECT MAX(id) FROM track \
                         WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0",
                        rusqlite::params![self.server_id, self.library_scope],
                        |row| row.get(0),
                    )
                }
            })
            .map_err(SyncError::Storage)
    }

    fn next_candidates_after(
        &self,
        after_id: Option<&str>,
        cutoff_id: &str,
        budget: u32,
    ) -> Result<Vec<String>, SyncError> {
        self.store
            .with_conn("tombstone.next_candidates_after", |c| {
                if self.library_scope.is_empty() {
                    let mut statement = c.prepare(
                        "SELECT id FROM track \
                         WHERE server_id = ?1 AND deleted = 0 AND id <= ?2 \
                           AND (?3 IS NULL OR id > ?3) \
                         ORDER BY id ASC LIMIT ?4",
                    )?;
                    let rows = statement
                        .query_map(
                            rusqlite::params![self.server_id, cutoff_id, after_id, budget as i64],
                            |row| row.get::<_, String>(0),
                        )?
                        .collect();
                    rows
                } else {
                    let mut statement = c.prepare(
                        "SELECT id FROM track \
                         WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0 \
                           AND id <= ?3 AND (?4 IS NULL OR id > ?4) \
                         ORDER BY id ASC LIMIT ?5",
                    )?;
                    let rows = statement
                        .query_map(
                            rusqlite::params![
                                self.server_id,
                                self.library_scope,
                                cutoff_id,
                                after_id,
                                budget as i64
                            ],
                            |row| row.get::<_, String>(0),
                        )?
                        .collect();
                    rows
                }
            })
            .map_err(SyncError::Storage)
    }

    async fn sleep(&self, d: Duration) {
        if self.sleep_enabled && !d.is_zero() {
            tokio::time::sleep(d).await;
        }
    }
}

/// §6.7 Mode B threshold check — returns `true` when the local /
/// server count gap exceeds the configured percentage. `server_count
/// == 0` is treated as "no signal" → `false` (no spurious reconcile
/// on a fresh server response).
pub fn should_auto_reconcile(local_count: u32, server_count: u32, threshold_pct: u32) -> bool {
    if server_count == 0 {
        return false;
    }
    let gap = local_count.saturating_sub(server_count);
    let ratio_x100 = gap.saturating_mul(100) / server_count;
    ratio_x100 > threshold_pct
}

/// Scope-aware Mode B threshold check. `getScanStatus.count` is server-wide,
/// so scoped runs use the explicit full Verify pass instead of count mismatch.
pub fn should_auto_reconcile_scope(
    library_scope: &str,
    local_count: u32,
    server_count: u32,
    threshold_pct: u32,
) -> bool {
    library_scope.is_empty() && should_auto_reconcile(local_count, server_count, threshold_pct)
}

async fn retry_with_backoff<'a, F, FFut, T, E>(
    reconciler: &TombstoneReconciler<'a>,
    mut build: F,
    map_err: impl Fn(E) -> SyncError,
) -> Result<T, SyncError>
where
    F: FnMut() -> FFut,
    FFut: std::future::Future<Output = Result<T, E>>,
{
    let mut backoff = Backoff::default();
    let mut attempt = 0u32;
    loop {
        reconciler.check_cancellation()?;
        attempt += 1;
        match build().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                let mapped = map_err(e);
                if !is_retryable(&mapped) || attempt >= MAX_ATTEMPTS_PER_BATCH {
                    return Err(mapped);
                }
                let delay = backoff.next_delay();
                let jittered = with_jitter(delay, jitter_salt(attempt));
                reconciler.sleep(jittered).await;
            }
        }
    }
}

fn is_retryable(e: &SyncError) -> bool {
    matches!(e, SyncError::Transport(_) | SyncError::Navidrome(_))
}

#[cfg(test)]
mod tests;
