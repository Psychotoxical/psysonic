//! Cover art disk cache — WebP tiers, prefetch, revalidation (phase B).

mod backfill_worker;
mod bucket;
mod cache_state;
mod disk;
mod dto;
mod encode;
mod ensure;
mod external;
mod external_ensure;
mod fetch;
#[cfg(test)]
mod layout_tests;
mod metrics;
mod peek;
#[cfg(test)]
mod test_support;

use bucket::{purge_external_files, rename_bucket_inner, reset_cover_cache_for_index_key_layout};
use cache_state::state;
pub use cache_state::CoverCacheState;
use disk::cover_dir;
pub use dto::{
    CoverCacheEnsureArgs, CoverCacheEnsureResult, CoverCachePeekItem, CoverCacheStatsDto,
    CoverPipelineQueueStatsDto,
};
use ensure::decode_image_bytes;
use metrics::{
    cached_dir_usage_for_server, clear_dir_usage_cache, cover_pipeline_queue_stats,
    dir_usage_at_root, invalidate_dir_usage_cache,
};
pub(crate) use metrics::{count_cached_cover_ids, dir_usage_for_server};
use peek::peek_plain_cover_tier;
use peek::{peek_fallback_tiers, peek_tier_path};
use psysonic_core::cover_cache_layout::cover_server_dir;
use psysonic_library::cover_backfill::{
    clear_cover_fetch_failures, collect_cover_backfill_batch, collect_cover_progress,
    count_distinct_cover_ids, LibraryCoverBackfillBatchDto, LibraryCoverProgressDto,
};
use psysonic_library::LibraryRuntime;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

pub use backfill_worker::{
    pulse_backfill, setup_library_sync_idle_listener, try_schedule_full_pass,
    CoverBackfillPulseDto, CoverBackfillRunDto, CoverBackfillSession, CoverBackfillWorker,
};

pub fn ui_ensure_produced_total() -> u64 {
    metrics::ui_ensure_produced_total()
}

pub fn init_cover_cache(app: &AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cover-cache");
    reset_cover_cache_for_index_key_layout(&root)?;
    app.manage(Arc::new(Mutex::new(CoverCacheState::new(root)?)));
    app.manage(Arc::new(CoverBackfillWorker::new()));
    setup_library_sync_idle_listener(app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn library_cover_backfill_run_full_pass(
    app: AppHandle,
    force: Option<bool>,
) -> Result<CoverBackfillRunDto, String> {
    Ok(CoverBackfillRunDto {
        started: try_schedule_full_pass(&app, force.unwrap_or(false)).await,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn library_cover_backfill_pulse(app: AppHandle) -> Result<CoverBackfillPulseDto, String> {
    let worker = app
        .try_state::<Arc<CoverBackfillWorker>>()
        .ok_or_else(|| "cover backfill worker not initialized".to_string())?;
    Ok(pulse_backfill(&app, &worker).await)
}

#[tauri::command]
#[specta::specta]
pub async fn library_cover_backfill_reset_cursor(app: AppHandle) -> Result<(), String> {
    let worker = app
        .try_state::<Arc<CoverBackfillWorker>>()
        .ok_or_else(|| "cover backfill worker not initialized".to_string())?;
    worker.reset_cursor().await;
    Ok(())
}

/// Pause library backfill while the user navigates / visible covers load (Rust pass yields).
#[tauri::command]
#[specta::specta]
pub async fn library_cover_backfill_set_ui_priority(
    app: AppHandle,
    hold: bool,
) -> Result<(), String> {
    let worker = app
        .try_state::<Arc<CoverBackfillWorker>>()
        .ok_or_else(|| "cover backfill worker not initialized".to_string())?;
    worker.set_ui_priority_hold(hold);
    Ok(())
}

/// Perf-probe tuning knob: set how many threads cover backfill uses (download
/// + encode pools move together). Not exposed in app Settings by design.
/// Returns the clamped value actually applied.
#[tauri::command]
#[specta::specta]
pub async fn library_cover_backfill_set_parallel(
    app: AppHandle,
    threads: usize,
) -> Result<u32, String> {
    let worker = app
        .try_state::<Arc<CoverBackfillWorker>>()
        .ok_or_else(|| "cover backfill worker not initialized".to_string())?;
    let applied = worker.set_parallel(threads);
    if let Ok(cache) = state(&app) {
        cache.lock().await.set_backfill_cpu_parallel(applied);
    }
    Ok(applied as u32)
}

#[tauri::command]
#[specta::specta]
pub async fn library_cover_backfill_configure(
    app: AppHandle,
    enabled: bool,
    server_index_key: String,
    library_server_id: String,
    rest_base_url: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let worker = app
        .try_state::<Arc<CoverBackfillWorker>>()
        .ok_or_else(|| "cover backfill worker not initialized".to_string())?;
    let session = if enabled && !library_server_id.is_empty() && !server_index_key.is_empty() {
        Some(CoverBackfillSession {
            server_index_key,
            library_server_id,
            username,
            password,
        })
    } else {
        None
    };
    worker
        .set_session(enabled && session.is_some(), session, rest_base_url)
        .await;
    if enabled {
        let _ = try_schedule_full_pass(&app, false).await;
    }
    Ok(())
}

/// Push the current reachable connect URL without rebuilding the backfill
/// session. The worklist holds URL-agnostic items and each fetch reads this
/// value live, so a LAN→public flip is honoured by the in-flight pass too.
/// When the URL actually changes, the stale `.fetch-failed` backoff (covers that
/// timed out against the old address) is cleared and a pass is kicked so they
/// retry on the now-reachable endpoint.
#[tauri::command]
#[specta::specta]
pub async fn library_cover_backfill_set_base_url(
    app: AppHandle,
    rest_base_url: String,
) -> Result<(), String> {
    let worker = app
        .try_state::<Arc<CoverBackfillWorker>>()
        .ok_or_else(|| "cover backfill worker not initialized".to_string())?;
    if !worker.set_base_url(rest_base_url) {
        return Ok(());
    }
    // Forced retry: bypass the idle gate and clear the `.fetch-failed` backoff so
    // covers that timed out against the old address are re-attempted on the new
    // one. If a pass is in flight it already adopted the new URL live; the forced
    // pass is queued to run right after it.
    worker.rearm_idle_gate().await;
    let _ = try_schedule_full_pass(&app, true).await;
    Ok(())
}

/// Best-effort disk hit without network (exact tier, then largest tier on disk ≤ wanted).
#[tauri::command]
#[specta::specta]
pub async fn cover_cache_peek_batch(
    app: AppHandle,
    items: Vec<CoverCachePeekItem>,
) -> Result<HashMap<String, String>, String> {
    let st = state(&app)?;
    let root = {
        let guard = st.lock().await;
        guard.root.clone()
    };
    let mut out = HashMap::new();
    for item in items {
        let dir = cover_dir(
            &root,
            &item.server_index_key,
            &item.cache_kind,
            &item.cache_entity_id,
        );
        // Plain-cover peek (no surface in the batch DTO): full-res is exact-only,
        // so a 2000 request never returns a smaller tier to seed the grid cache.
        let path = peek_plain_cover_tier(&dir, item.tier);
        if let Some(p) = path {
            out.insert(item.storage_key, p.to_string_lossy().into_owned());
        }
    }
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn cover_cache_ensure(
    app: AppHandle,
    args: CoverCacheEnsureArgs,
) -> Result<CoverCacheEnsureResult, String> {
    let st = state(&app)?;
    CoverCacheState::ensure_inner(&st, &app, &args, None).await
}

#[tauri::command]
#[specta::specta]
pub async fn cover_cache_ensure_batch(
    app: AppHandle,
    items: Vec<CoverCacheEnsureArgs>,
) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let st = state(&app)?;
    for item in items {
        let st = st.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = CoverCacheState::ensure_inner(&st, &app, &item, None).await;
        });
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn cover_cache_stats(app: AppHandle) -> Result<CoverCacheStatsDto, String> {
    let st = state(&app)?;
    let root = {
        let guard = st.lock().await;
        guard.root.clone()
    };
    let (bytes, entry_count) =
        tauri::async_runtime::spawn_blocking(move || dir_usage_at_root(&root))
            .await
            .map_err(|e| e.to_string())?;
    let st = state(&app)?;
    let guard = st.lock().await;
    let (pressure, auto_download_enabled) = guard.pressure_from_bytes(bytes);
    Ok(CoverCacheStatsDto {
        bytes,
        count: entry_count,
        pressure,
        auto_download_enabled,
        entry_count,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn cover_cache_evict_tick(_app: AppHandle) -> Result<u32, String> {
    Ok(0)
}

#[tauri::command]
#[specta::specta]
pub async fn cover_cache_stats_server(
    app: AppHandle,
    server_index_key: String,
) -> Result<CoverCacheStatsDto, String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    let (bytes, entry_count) = cached_dir_usage_for_server(&guard.root, &server_index_key);
    let (pressure, auto_download_enabled) = guard.pressure_from_bytes(bytes);
    Ok(CoverCacheStatsDto {
        bytes,
        count: entry_count,
        pressure,
        auto_download_enabled,
        entry_count,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn cover_cache_get_pipeline_queue_stats(
    app: AppHandle,
) -> Result<CoverPipelineQueueStatsDto, String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    let backfill = app.try_state::<Arc<backfill_worker::CoverBackfillWorker>>();
    Ok(cover_pipeline_queue_stats(
        &guard,
        backfill.as_ref().map(|w| w.as_ref()),
    ))
}

#[tauri::command]
#[specta::specta]
pub async fn cover_cache_clear_server(
    app: AppHandle,
    server_index_key: String,
) -> Result<(), String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    let path = cover_server_dir(&guard.root, &server_index_key);
    if path.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }
    invalidate_dir_usage_cache(&server_index_key);
    drop(guard);
    // §12/B.4: the on-disk external tiers (`{tier}-fanart.webp` / `-banner.webp`)
    // + `.miss-*` markers went with the dir removal above; also drop the
    // `artist_artwork_lookup` rows for this server so no resolution state lingers.
    if let Some(rt) = app.try_state::<LibraryRuntime>() {
        let store = rt.store.clone();
        let key = server_index_key.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            psysonic_library::artist_artwork::clear_artist_artwork_for_server(&store, &key)
        })
        .await;
    }
    // Clearing drops files the cheap idle-gate signature can't see, so re-arm
    // the backfill worker — otherwise the next sync-idle would skip the rescan.
    if let Some(worker) = app.try_state::<Arc<CoverBackfillWorker>>() {
        worker.rearm_idle_gate().await;
    }
    let _ = app.emit(
        "cover:cache-cleared",
        serde_json::json!({ "serverIndexKey": server_index_key }),
    );
    Ok(())
}

/// Opt-out purge (§9, §12, Appendix B.4): drop every external artwork artifact
/// for a server — `{tier}-{provider}.webp`, `.miss-{provider}`, and the
/// `artist_artwork_lookup` rows — while leaving the canonical Navidrome covers
/// intact. Fired when the user turns the External Artwork toggle off. Unlike
/// `cover_cache_clear_server`, Navidrome tiers survive.
#[tauri::command]
#[specta::specta]
pub async fn cover_cache_purge_external(
    app: AppHandle,
    server_index_key: String,
) -> Result<(), String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    let path = cover_server_dir(&guard.root, &server_index_key);
    if path.is_dir() {
        purge_external_files(&path);
    }
    invalidate_dir_usage_cache(&server_index_key);
    drop(guard);
    if let Some(rt) = app.try_state::<LibraryRuntime>() {
        let store = rt.store.clone();
        let key = server_index_key.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            psysonic_library::artist_artwork::clear_artist_artwork_for_server(&store, &key)
        })
        .await;
    }
    Ok(())
}

/// Rename a server's cover-cache bucket on disk after the user edits the
/// primary URL (and the derived index key changes). Used by the URL-change
/// remigration pipeline (dual-server-address spec §8.3) so cached covers
/// stay reachable under the new key.
///
/// Sanitization: rejects path-separator characters and `..` components — keys
/// flow from `serverIndexKeyFromUrl(url)` which strips schemes and trailing
/// slashes, but defense in depth at the FS boundary is cheap.
///
/// Behaviour:
/// - `old_key == new_key` → no-op success.
/// - Old bucket missing → no-op success (nothing to migrate).
/// - New bucket missing → simple `rename` (fastest path).
/// - Both exist → recursive merge, **prefer existing** in destination (the
///   newer bucket wins on collision; the surviving file count goes up, never
///   loses data).
///
/// Always emits `cover:bucket-renamed` with `{oldKey, newKey}` on success so
/// the frontend in-memory disk-src cache can invalidate stale entries.
#[tauri::command]
#[specta::specta]
pub async fn cover_cache_rename_server_bucket(
    app: AppHandle,
    old_key: String,
    new_key: String,
) -> Result<(), String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    rename_bucket_inner(&guard.root, &old_key, &new_key)?;
    drop(guard);
    let _ = app.emit(
        "cover:bucket-renamed",
        serde_json::json!({ "oldKey": old_key, "newKey": new_key }),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn cover_cache_configure(
    app: AppHandle,
    max_mb: u64,
    high_watermark_pct: u64,
    resume_watermark_pct: u64,
) -> Result<(), String> {
    let st = state(&app)?;
    let mut guard = st.lock().await;
    guard.max_bytes = max_mb.saturating_mul(1024 * 1024);
    guard.high_watermark_pct = high_watermark_pct.clamp(50, 99);
    guard.resume_watermark_pct = resume_watermark_pct.clamp(40, 95);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn cover_cache_clear(app: AppHandle) -> Result<(), String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    if guard.root.exists() {
        for entry in std::fs::read_dir(&guard.root)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let name = entry.file_name();
            if name.to_string_lossy() == ".storage-layout" {
                continue;
            }
            if entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            } else {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    drop(guard);
    clear_dir_usage_cache();
    if let Some(worker) = app.try_state::<Arc<CoverBackfillWorker>>() {
        worker.rearm_idle_gate().await;
    }
    let _ = app.emit("cover:cache-cleared", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn library_cover_backfill_batch(
    app: AppHandle,
    server_index_key: String,
    library_server_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<LibraryCoverBackfillBatchDto, String> {
    let runtime = app
        .try_state::<LibraryRuntime>()
        .ok_or_else(|| "LibraryRuntime not initialized".to_string())?;
    let st = state(&app)?;
    let root = {
        let guard = st.lock().await;
        guard.root.clone()
    };
    let store = runtime.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        collect_cover_backfill_batch(
            &store,
            &library_server_id,
            &root,
            &server_index_key,
            cursor.as_deref(),
            limit,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn library_cover_progress(
    app: AppHandle,
    server_index_key: String,
    library_server_id: String,
) -> Result<LibraryCoverProgressDto, String> {
    let runtime = app
        .try_state::<LibraryRuntime>()
        .ok_or_else(|| "LibraryRuntime not initialized".to_string())?;
    let st = state(&app)?;
    let root = {
        let guard = st.lock().await;
        guard.root.clone()
    };
    let index_key = server_index_key.clone();
    let store = runtime.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cached_dirs = cached_dir_usage_for_server(&root, &index_key).1 as i64;
        collect_cover_progress(&store, &library_server_id, &root, &index_key, cached_dirs)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn library_cover_clear_fetch_failures(
    app: AppHandle,
    server_index_key: String,
) -> Result<u32, String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    Ok(clear_cover_fetch_failures(&guard.root, &server_index_key))
}

#[tauri::command]
#[specta::specta]
pub async fn library_cover_catalog_size(
    app: AppHandle,
    library_server_id: String,
) -> Result<i64, String> {
    let runtime = app
        .try_state::<LibraryRuntime>()
        .ok_or_else(|| "LibraryRuntime not initialized".to_string())?;
    let store = runtime.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        count_distinct_cover_ids(&store, &library_server_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub fn cover_revalidate_enqueue() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn cover_revalidate_tick(_cycle_days: Option<u32>) -> Result<u32, String> {
    Ok(0)
}

#[tauri::command]
pub fn cover_revalidate_batch() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "cursor": null,
        "processed": 0,
        "changed": 0
    }))
}
