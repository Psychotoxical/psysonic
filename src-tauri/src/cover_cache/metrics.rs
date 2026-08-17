use super::backfill_worker;
use super::cache_state::{CoverCacheState, COVER_CPU_UI_CONCURRENCY, COVER_HTTP_CONCURRENCY};
use super::dto::{CoverCacheEnsureArgs, CoverPipelineQueueStatsDto};
use psysonic_core::cover_cache_layout::{
    count_entities_with_canonical_tier, cover_root_disk_usage, cover_server_dir,
    server_cover_disk_usage,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;

/// Cumulative count of covers newly produced by on-demand (UI) ensures — the
/// source for the Performance Probe "on-demand (ui)" throughput. Library
/// backfill (`library_bulk`) is excluded; it reports via `cover:library-progress`.
static UI_ENSURE_PRODUCED: AtomicU64 = AtomicU64::new(0);

/// Snapshot of covers produced by on-demand UI ensures since process start.
pub(super) fn ui_ensure_produced_total() -> u64 {
    UI_ENSURE_PRODUCED.load(Ordering::Relaxed)
}

/// Count one freshly produced on-demand cover. Called from `ensure_inner` on the
/// produce-success path only (past the early cache-hit gate), so pure cache hits
/// and library backfill (`library_bulk`) are excluded.
pub(super) fn note_ui_cover_produced(args: &CoverCacheEnsureArgs) {
    if !args.library_bulk {
        UI_ENSURE_PRODUCED.fetch_add(1, Ordering::Relaxed);
    }
}

fn sem_active(sem: &Semaphore, max: u32) -> u32 {
    max.saturating_sub(sem.available_permits() as u32)
}

pub(crate) fn cover_pipeline_queue_stats(
    cache: &CoverCacheState,
    backfill: Option<&backfill_worker::CoverBackfillWorker>,
) -> CoverPipelineQueueStatsDto {
    let (library_backfill_http_max, library_backfill_http_active, library_backfill_pass_running) =
        backfill
            .map(backfill_worker::CoverBackfillWorker::pipeline_http_stats)
            .unwrap_or((0, 0, false));
    CoverPipelineQueueStatsDto {
        http_max: COVER_HTTP_CONCURRENCY as u32,
        http_active: sem_active(&cache.http_sem, COVER_HTTP_CONCURRENCY as u32),
        cpu_ui_max: COVER_CPU_UI_CONCURRENCY as u32,
        cpu_ui_active: sem_active(&cache.cover_cpu_ui_sem, COVER_CPU_UI_CONCURRENCY as u32),
        cpu_backfill_max: cache.cover_backfill_cpu_parallel() as u32,
        cpu_backfill_active: sem_active(
            &cache.cover_cpu_backfill_sem,
            cache.cover_backfill_cpu_parallel() as u32,
        ),
        library_backfill_http_max,
        library_backfill_http_active,
        library_backfill_pass_running,
        ui_ensured_total: super::ui_ensure_produced_total(),
    }
}

/// Entity dirs with canonical `800.webp` under `album/` and `artist/` (segment layout).
/// Per-server only — must not borrow counts from sibling buckets (multi-server UI stats).
pub(crate) fn count_cached_cover_ids(root: &Path, server_index_key: &str) -> i64 {
    count_entities_with_canonical_tier(&cover_server_dir(root, server_index_key))
}

pub(crate) fn dir_usage_for_server(root: &Path, server_index_key: &str) -> (u64, u64) {
    server_cover_disk_usage(&cover_server_dir(root, server_index_key))
}

/// TTL-memoized per-server cover dir walk. The "offline & cache" settings menu
/// polls byte usage + cached count every few seconds for every server; on a full
/// cache that is several full directory walks per tick. Reuse a recent walk so we
/// don't re-stat thousands of files when nothing has changed. Active backfill still
/// pushes live numbers through the `cover:library-progress` event, so a short TTL
/// only de-dupes the idle polling, it does not hide real progress.
const DIR_USAGE_CACHE_TTL: Duration = Duration::from_secs(10);

type DirUsageCache = std::sync::Mutex<HashMap<String, (std::time::Instant, (u64, u64))>>;

fn dir_usage_cache() -> &'static DirUsageCache {
    static CACHE: std::sync::OnceLock<DirUsageCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub(crate) fn cached_dir_usage_for_server(root: &Path, server_index_key: &str) -> (u64, u64) {
    if let Ok(map) = dir_usage_cache().lock() {
        if let Some((at, value)) = map.get(server_index_key) {
            if at.elapsed() < DIR_USAGE_CACHE_TTL {
                return *value;
            }
        }
    }
    let value = dir_usage_for_server(root, server_index_key);
    if let Ok(mut map) = dir_usage_cache().lock() {
        map.insert(
            server_index_key.to_string(),
            (std::time::Instant::now(), value),
        );
    }
    value
}

pub(crate) fn invalidate_dir_usage_cache(server_index_key: &str) {
    if let Ok(mut map) = dir_usage_cache().lock() {
        map.remove(server_index_key);
    }
}

pub(crate) fn clear_dir_usage_cache() {
    if let Ok(mut map) = dir_usage_cache().lock() {
        map.clear();
    }
}

pub(crate) fn dir_usage_at_root(root: &Path) -> (u64, u64) {
    cover_root_disk_usage(root)
}

#[cfg(test)]
mod tests {
    use super::count_cached_cover_ids;
    use crate::cover_cache::disk::cover_dir;
    use crate::cover_cache::test_support::fresh_tmpdir;
    use psysonic_core::cover_cache_layout::CANONICAL_PROGRESS_TIER;
    use std::fs;

    #[test]
    fn count_cached_cover_ids_is_per_server_bucket() {
        let root = fresh_tmpdir("count-per-server");
        let home = cover_dir(&root, "music.home.example", "album", "al-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join(format!("{CANONICAL_PROGRESS_TIER}.webp")), b"x").unwrap();
        assert_eq!(count_cached_cover_ids(&root, "music.home.example"), 1);
        assert_eq!(count_cached_cover_ids(&root, "music.other.example"), 0);
        let _ = fs::remove_dir_all(&root);
    }
}
