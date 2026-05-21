//! Concurrent fetch helpers for initial-sync ingest (C11 parallelism budget).

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use psysonic_integration::subsonic::{Album, SubsonicClient};
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

use super::backoff::{jitter_salt, with_jitter, Backoff};
use super::bandwidth::ParallelismBudget;
use super::error::SyncError;

const MAX_ATTEMPTS_PER_BATCH: u32 = 5;

pub fn check_cancel_flag(cancel: &Option<Arc<std::sync::atomic::AtomicBool>>) -> Result<(), SyncError> {
    if cancel.as_ref().is_some_and(|f| f.load(Ordering::SeqCst)) {
        return Err(SyncError::Cancelled);
    }
    Ok(())
}

fn is_retryable(e: &SyncError) -> bool {
    matches!(e, SyncError::Transport(_) | SyncError::Navidrome(_))
}

/// How many linear pages to keep in flight (`1` = sequential).
pub fn linear_prefetch_depth(budget: &ParallelismBudget) -> usize {
    if budget.bulk_paused() {
        return 1;
    }
    budget.max_concurrent.max(1) as usize
}

pub async fn sleep_request_gap(budget: &ParallelismBudget, sleep_enabled: bool) {
    if sleep_enabled && budget.min_request_gap_ms > 0 {
        tokio::time::sleep(Duration::from_millis(budget.min_request_gap_ms as u64)).await;
    }
}

pub async fn wait_while_bulk_paused(
    budget: &ParallelismBudget,
    sleep_enabled: bool,
    mut check_cancel: impl FnMut() -> Result<(), SyncError>,
) -> Result<(), SyncError> {
    while budget.bulk_paused() {
        check_cancel()?;
        if sleep_enabled {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    Ok(())
}

/// Standalone retry loop for spawned prefetch tasks (no `InitialSyncRunner` ref).
pub async fn retry_fetch<T, F, Fut, E>(
    sleep_enabled: bool,
    mut check_cancel: impl FnMut() -> Result<(), SyncError>,
    mut build: F,
    map_err: impl Fn(E) -> SyncError,
) -> Result<T, SyncError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let mut backoff = Backoff::default();
    let mut attempt = 0u32;
    loop {
        check_cancel()?;
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
                if sleep_enabled && !jittered.is_zero() {
                    tokio::time::sleep(jittered).await;
                }
            }
        }
    }
}

/// Ordered in-flight page queue for N1/S1 linear ingest.
pub struct LinearPrefetchQueue<T> {
    depth: usize,
    batch_size: u32,
    next_enqueue_offset: u32,
    exhausted: bool,
    inflight: BTreeMap<u32, JoinHandle<Result<T, SyncError>>>,
}

impl<T: Send + 'static> LinearPrefetchQueue<T> {
    pub fn new(budget: &ParallelismBudget, batch_size: u32, start_offset: u32) -> Self {
        Self {
            depth: linear_prefetch_depth(budget),
            batch_size,
            next_enqueue_offset: start_offset,
            exhausted: false,
            inflight: BTreeMap::new(),
        }
    }

    pub fn mark_exhausted(&mut self) {
        self.exhausted = true;
    }

    pub fn pump<F>(
        &mut self,
        mut check_cancel: impl FnMut() -> Result<(), SyncError>,
        mut spawn: F,
    ) -> Result<(), SyncError>
    where
        F: FnMut(u32) -> JoinHandle<Result<T, SyncError>>,
    {
        while !self.exhausted && self.inflight.len() < self.depth {
            check_cancel()?;
            let offset = self.next_enqueue_offset;
            self.next_enqueue_offset = offset.saturating_add(self.batch_size);
            let handle = spawn(offset);
            self.inflight.insert(offset, handle);
        }
        Ok(())
    }

    pub async fn take_at(
        &mut self,
        offset: u32,
        mut check_cancel: impl FnMut() -> Result<(), SyncError>,
    ) -> Result<Option<T>, SyncError> {
        check_cancel()?;
        let Some(handle) = self.inflight.remove(&offset) else {
            return Ok(None);
        };
        let value = handle
            .await
            .map_err(|e| SyncError::Transport(format!("prefetch join: {e}")))??;
        Ok(Some(value))
    }
}

/// Fetch `getAlbum` bodies for a page with at most `budget.max_concurrent`
/// requests in flight. Results preserve input order.
#[derive(Clone)]
pub struct ParallelAlbumFetchOpts {
    pub budget: ParallelismBudget,
    pub sleep_enabled: bool,
    pub cancel: Option<Arc<AtomicBool>>,
}

pub async fn fetch_albums_parallel(
    subsonic: &SubsonicClient,
    album_ids: &[String],
    opts: ParallelAlbumFetchOpts,
) -> Result<Vec<(Album, Value)>, SyncError> {
    if album_ids.is_empty() {
        return Ok(Vec::new());
    }
    wait_while_bulk_paused(&opts.budget, opts.sleep_enabled, || check_cancel_flag(&opts.cancel)).await?;
    let max = opts.budget.max_concurrent.max(1) as usize;
    let client = subsonic.clone();
    let sem = Arc::new(Semaphore::new(max));
    let mut handles: Vec<JoinHandle<Result<(Album, Value), SyncError>>> =
        Vec::with_capacity(album_ids.len());

    for id in album_ids {
        check_cancel_flag(&opts.cancel)?;
        sleep_request_gap(&opts.budget, opts.sleep_enabled).await;
        let permit = sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| SyncError::Transport("parallel fetch semaphore closed".into()))?;
        let client = client.clone();
        let id = id.clone();
        let cancel = opts.cancel.clone();
        let sleep_enabled = opts.sleep_enabled;
        handles.push(tokio::spawn(async move {
            let _permit = permit;
            retry_fetch(
                sleep_enabled,
                || check_cancel_flag(&cancel),
                || async {
                    client
                        .get_album_with_raw(&id)
                        .await
                        .map_err(SyncError::from)
                },
                |e| e,
            )
            .await
        }));
    }

    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        check_cancel_flag(&opts.cancel)?;
        out.push(
            handle
                .await
                .map_err(|e| SyncError::Transport(format!("parallel album fetch join: {e}")))??
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_prefetch_depth_respects_budget() {
        let idle = ParallelismBudget::resolve(super::super::bandwidth::PlaybackHint::Idle);
        assert_eq!(linear_prefetch_depth(&idle), 4);
        let playing = ParallelismBudget::resolve(super::super::bandwidth::PlaybackHint::Playing);
        assert_eq!(linear_prefetch_depth(&playing), 1);
    }
}
