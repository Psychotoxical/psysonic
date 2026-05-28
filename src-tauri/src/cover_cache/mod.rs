//! Cover art disk cache — WebP tiers, prefetch, revalidation (phase B).

mod backfill_worker;
mod disk;
mod encode;
mod fetch;

use disk::{cover_dir, tier_exists, tier_path, DERIVE_TIERS};
use encode::write_webp_tier;
use fetch::build_cover_art_url;
use image::{DynamicImage, ImageReader};
use psysonic_core::cover_cache_layout::{
    count_entities_with_canonical_tier, cover_root_disk_usage, cover_server_dir,
    server_cover_disk_usage,
};
use psysonic_library::cover_backfill::{
    clear_cover_fetch_failures, collect_cover_backfill_batch, collect_cover_progress,
    count_distinct_cover_ids, cover_fetch_recently_failed, LibraryCoverBackfillBatchDto,
    LibraryCoverProgressDto, COVER_FETCH_FAIL_MARKER,
};
use psysonic_library::LibraryRuntime;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheEnsureResult {
    pub hit: bool,
    pub path: String,
    pub tier: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheStatsDto {
    pub bytes: u64,
    pub count: u64,
    pub pressure: String,
    pub auto_download_enabled: bool,
    pub entry_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheEnsureArgs {
    pub server_index_key: String,
    /// `album` or `artist` — with `cache_entity_id` selects the SHA-256 cache directory.
    pub cache_kind: String,
    pub cache_entity_id: String,
    /// Navidrome / Subsonic `getCoverArt` id (`al-*`, `ar-*`, …).
    pub cover_art_id: String,
    pub tier: u32,
    pub rest_base_url: String,
    pub username: String,
    pub password: String,
    /// Library backfill: all derived tiers, no `cover:tier-ready` floods to the webview.
    #[serde(default)]
    pub library_bulk: bool,
}

fn cover_dir_for_args(root: &Path, args: &CoverCacheEnsureArgs) -> PathBuf {
    cover_dir(root, &args.server_index_key, &args.cache_kind, &args.cache_entity_id)
}

/// Cap concurrent cover HTTP fetches for visible UI routes (library backfill uses its own pool).
const COVER_HTTP_CONCURRENCY: usize = 16;
/// UI-visible decode + WebP encode (grid, hero, player) — not shared with library backfill.
const COVER_CPU_UI_CONCURRENCY: usize = 2;
/// Library backfill encode ladder — separate pool so bulk warm-up cannot starve the webview.
const COVER_CPU_BACKFILL_CONCURRENCY: usize = 2;

pub struct CoverCacheState {
    pub root: PathBuf,
    pub client: Client,
    pub max_bytes: u64,
    pub high_watermark_pct: u64,
    pub resume_watermark_pct: u64,
    pub http_sem: Arc<Semaphore>,
    pub cover_cpu_ui_sem: Arc<Semaphore>,
    pub cover_cpu_backfill_sem: Arc<Semaphore>,
}

impl CoverCacheState {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let client = Client::builder()
            .timeout(Duration::from_secs(25))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            root,
            client,
            max_bytes: 10 * 1024 * 1024 * 1024,
            high_watermark_pct: 90,
            resume_watermark_pct: 85,
            http_sem: Arc::new(Semaphore::new(COVER_HTTP_CONCURRENCY)),
            cover_cpu_ui_sem: Arc::new(Semaphore::new(COVER_CPU_UI_CONCURRENCY)),
            cover_cpu_backfill_sem: Arc::new(Semaphore::new(COVER_CPU_BACKFILL_CONCURRENCY)),
        })
    }

    fn cpu_sem_for(&self, library_bulk: bool) -> Arc<Semaphore> {
        if library_bulk {
            self.cover_cpu_backfill_sem.clone()
        } else {
            self.cover_cpu_ui_sem.clone()
        }
    }

    fn pressure_from_bytes(&self, _bytes: u64) -> (String, bool) {
        ("ok".into(), true)
    }

    fn pressure(&self) -> (String, bool) {
        let (bytes, _) = dir_usage_at_root(&self.root);
        self.pressure_from_bytes(bytes)
    }

    pub(crate) async fn ensure_inner(
        state: &Arc<Mutex<CoverCacheState>>,
        app: &AppHandle,
        args: &CoverCacheEnsureArgs,
        http_sem_override: Option<Arc<Semaphore>>,
    ) -> Result<CoverCacheEnsureResult, String> {
        let this = state.lock().await;
        let dir = cover_dir_for_args(&this.root, args);
        if let Some(path) = peek_tier_path(&dir, args.tier) {
            return Ok(CoverCacheEnsureResult {
                hit: true,
                path: path.to_string_lossy().into_owned(),
                tier: args.tier,
            });
        }

        let (_, auto_dl) = this.pressure();
        if !auto_dl && args.tier != 2000 {
            return Ok(CoverCacheEnsureResult {
                hit: false,
                path: String::new(),
                tier: args.tier,
            });
        }

        let client = this.client.clone();
        let root = this.root.clone();
        let http_sem = http_sem_override.unwrap_or_else(|| this.http_sem.clone());
        let cover_cpu_sem = this.cpu_sem_for(args.library_bulk);
        drop(this);

        if cover_fetch_recently_failed(&dir) {
            return Ok(CoverCacheEnsureResult {
                hit: false,
                path: String::new(),
                tier: args.tier,
            });
        }

        let requested = args.tier;
        let quiet = args.library_bulk;
        let tiers_now: Vec<u32> = if args.library_bulk {
            DERIVE_TIERS
                .iter()
                .copied()
                .filter(|t| *t <= requested)
                .collect()
        } else if requested == 2000 {
            vec![2000]
        } else {
            DERIVE_TIERS
                .iter()
                .copied()
                .filter(|t| *t <= requested)
                .collect()
        };

        enum CoverSource {
            Image(DynamicImage),
            Bytes(Vec<u8>),
        }

        let source = if let Some(img) = load_image_from_disk(&dir) {
            CoverSource::Image(img)
        } else {
            match download_cover_payload(&dir, &client, &http_sem, args).await {
                Ok(bytes) => CoverSource::Bytes(bytes),
                Err(_) => {
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::write(dir.join(COVER_FETCH_FAIL_MARKER), b"1");
                    return Ok(CoverCacheEnsureResult {
                        hit: false,
                        path: String::new(),
                        tier: args.tier,
                    });
                }
            }
        };

        let dir_bg = dir.clone();
        let cover_cpu_sem_bg = cover_cpu_sem.clone();
        let tiers_bg = tiers_now.clone();
        let (mut wrote_requested, fresh_tiers) = tauri::async_runtime::spawn_blocking(
            move || -> Result<(bool, Vec<(u32, PathBuf)>), String> {
                let rt = tokio::runtime::Handle::current();
                let _permit = rt
                    .block_on(cover_cpu_sem_bg.acquire())
                    .map_err(|e| e.to_string())?;
                let img = match source {
                    CoverSource::Image(i) => i,
                    CoverSource::Bytes(b) => decode_image_bytes(&b)?,
                };
                std::fs::create_dir_all(&dir_bg).map_err(|e| e.to_string())?;
                let mut wrote_requested = false;
                let mut fresh = Vec::new();
                if quiet {
                    disk::write_derived_webp_tiers(&dir_bg, &img, requested)?;
                    wrote_requested = tier_exists(&dir_bg, requested).is_some();
                } else {
                    for tier in tiers_bg {
                        if tier_exists(&dir_bg, tier).is_some() {
                            if tier == requested {
                                wrote_requested = true;
                            }
                            continue;
                        }
                        let path = tier_path(&dir_bg, tier);
                        write_webp_tier(&img, tier, &path)?;
                        fresh.push((tier, path));
                        if tier == requested {
                            wrote_requested = true;
                        }
                    }
                }
                Ok((wrote_requested, fresh))
            },
        )
        .await
        .map_err(|e| e.to_string())??;

        if !quiet {
            for (tier, path) in fresh_tiers {
                emit_tier_ready(app, args, tier, &path);
            }
        }

        if !wrote_requested && tier_exists(&dir, requested).is_some() {
            wrote_requested = true;
        }

        let out_path = tier_path(&dir, requested);
        if wrote_requested || out_path.is_file() {
            if !quiet {
                if let Some(img) = load_image_from_disk(&dir) {
                    spawn_derive_remaining_tiers(
                        app.clone(),
                        state.clone(),
                        root,
                        args.clone(),
                        img,
                        requested,
                    );
                }
            }
            return Ok(CoverCacheEnsureResult {
                hit: true,
                path: out_path.to_string_lossy().into_owned(),
                tier: requested,
            });
        }

        Ok(CoverCacheEnsureResult {
            hit: false,
            path: String::new(),
            tier: requested,
        })
    }
}

fn emit_tier_ready(app: &AppHandle, args: &CoverCacheEnsureArgs, tier: u32, path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if !meta.is_file() || meta.len() == 0 {
        return;
    }
    let _ = app.emit(
        "cover:tier-ready",
        serde_json::json!({
            "serverIndexKey": args.server_index_key,
            "cacheKind": args.cache_kind,
            "cacheEntityId": args.cache_entity_id,
            "tier": tier,
            "path": path.to_string_lossy(),
        }),
    );
}

fn decode_image_bytes(bytes: &[u8]) -> Result<DynamicImage, String> {
    ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())
}

fn load_image_from_disk(dir: &Path) -> Option<DynamicImage> {
    for tier in [800u32, 512, 256, 128] {
        if let Some(path) = tier_exists(dir, tier) {
            if let Ok(img) = image::open(&path) {
                return Some(img);
            }
        }
    }
    None
}

async fn download_cover_payload(
    _dir: &Path,
    client: &Client,
    http_sem: &Semaphore,
    args: &CoverCacheEnsureArgs,
) -> Result<Vec<u8>, String> {
    let _permit = http_sem
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let fetch_size = if args.tier >= 2000 {
        2000
    } else {
        800
    };
    let url = build_cover_art_url(
        &args.rest_base_url,
        &args.username,
        &args.password,
        &args.cover_art_id,
        fetch_size,
    );
    fetch::fetch_cover_bytes(client, &url).await
}

fn spawn_derive_remaining_tiers(
    app: AppHandle,
    state: Arc<Mutex<CoverCacheState>>,
    _root: PathBuf,
    args: CoverCacheEnsureArgs,
    img: DynamicImage,
    requested: u32,
) {
    let tiers_bg: Vec<u32> = if requested == 2000 {
        vec![]
    } else {
        DERIVE_TIERS
            .iter()
            .copied()
            .filter(|t| *t > requested && *t <= 800)
            .collect()
    };
    if tiers_bg.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let (dir, cover_cpu_sem) = {
            let guard = state.lock().await;
            (
                cover_dir_for_args(&guard.root, &args),
                guard.cpu_sem_for(args.library_bulk),
            )
        };
        let written = tauri::async_runtime::spawn_blocking(move || -> Vec<(u32, PathBuf)> {
            let rt = tokio::runtime::Handle::current();
            let Ok(_permit) = rt.block_on(cover_cpu_sem.acquire()) else {
                return Vec::new();
            };
            let mut fresh = Vec::new();
            for tier in tiers_bg {
                if tier_exists(&dir, tier).is_some() {
                    continue;
                }
                let path = tier_path(&dir, tier);
                if write_webp_tier(&img, tier, &path).is_ok() {
                    fresh.push((tier, path));
                }
            }
            fresh
        })
        .await
        .unwrap_or_default();
        for (tier, path) in written {
            emit_tier_ready(&app, &args, tier, &path);
        }
    });
}

/// Entity dirs with canonical `800.webp` under `album/` and `artist/` (segment layout).
pub(crate) fn count_cached_cover_ids(root: &Path, server_index_key: &str) -> i64 {
    let keyed = count_entities_with_canonical_tier(&cover_server_dir(root, server_index_key));
    if keyed > 0 {
        return keyed;
    }
    // Host alias / legacy bucket name — pick the best segment count among siblings.
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            e.path().is_dir() && e.file_name().to_string_lossy() != ".storage-layout"
        })
        .map(|e| count_entities_with_canonical_tier(&e.path()))
        .max()
        .unwrap_or(0)
}

pub(crate) fn dir_usage_for_server(root: &Path, server_index_key: &str) -> (u64, u64) {
    server_cover_disk_usage(&cover_server_dir(root, server_index_key))
}

pub(crate) fn dir_usage_at_root(root: &Path) -> (u64, u64) {
    cover_root_disk_usage(root)
}

fn state(app: &AppHandle) -> Result<Arc<Mutex<CoverCacheState>>, String> {
    app.try_state::<Arc<Mutex<CoverCacheState>>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "cover cache not initialized".into())
}

const COVER_CACHE_LAYOUT_STAMP: &str = psysonic_core::cover_cache_layout::LAYOUT_STAMP;

/// Drop legacy profile-uuid directories when switching to host index keys (no migration).
fn reset_cover_cache_for_index_key_layout(root: &Path) -> Result<(), String> {
    let stamp = root.join(".storage-layout");
    if stamp.is_file() {
        if let Ok(s) = std::fs::read_to_string(&stamp) {
            if s.trim() == COVER_CACHE_LAYOUT_STAMP {
                return Ok(());
            }
        }
    }
    if root.exists() {
        for entry in std::fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            if path.file_name().and_then(|n| n.to_str()) == Some(".storage-layout") {
                continue;
            }
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    std::fs::write(&stamp, COVER_CACHE_LAYOUT_STAMP).map_err(|e| e.to_string())?;
    Ok(())
}

pub use backfill_worker::{
    pulse_backfill, setup_library_sync_idle_listener, try_schedule_full_pass, CoverBackfillPulseDto,
    CoverBackfillRunDto, CoverBackfillSession, CoverBackfillWorker,
};

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
pub async fn library_cover_backfill_run_full_pass(app: AppHandle) -> Result<CoverBackfillRunDto, String> {
    Ok(CoverBackfillRunDto {
        started: try_schedule_full_pass(&app).await,
    })
}

#[tauri::command]
pub async fn library_cover_backfill_pulse(app: AppHandle) -> Result<CoverBackfillPulseDto, String> {
    let worker = app
        .try_state::<Arc<CoverBackfillWorker>>()
        .ok_or_else(|| "cover backfill worker not initialized".to_string())?;
    Ok(pulse_backfill(&app, &worker).await)
}

#[tauri::command]
pub async fn library_cover_backfill_reset_cursor(app: AppHandle) -> Result<(), String> {
    let worker = app
        .try_state::<Arc<CoverBackfillWorker>>()
        .ok_or_else(|| "cover backfill worker not initialized".to_string())?;
    worker.reset_cursor().await;
    Ok(())
}

/// Pause library backfill while the user navigates / visible covers load (Rust pass yields).
#[tauri::command]
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

#[tauri::command]
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
            rest_base_url,
            username,
            password,
        })
    } else {
        None
    };
    worker
        .set_session(enabled && session.is_some(), session)
        .await;
    if enabled {
        let _ = try_schedule_full_pass(&app).await;
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverCachePeekItem {
    pub server_index_key: String,
    pub cache_kind: String,
    pub cache_entity_id: String,
    pub tier: u32,
    /// Frontend `coverStorageKey` — echoed in the batch result map.
    pub storage_key: String,
}

/// Best-effort disk hit without network (exact tier, then largest tier on disk ≤ wanted).
#[tauri::command]
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
        let path = peek_tier_path(&dir, item.tier);
        if let Some(p) = path {
            out.insert(item.storage_key, p.to_string_lossy().into_owned());
        }
    }
    Ok(out)
}

fn peek_fallback_tiers(want: u32) -> &'static [u32] {
    match want {
        512 => &[800, 256, 128],
        256 => &[800, 512, 128],
        128 => &[256, 512, 800],
        64 => &[128, 256, 512, 800],
        w if w > 512 && w < 800 => &[800, 512, 256, 128],
        w if w > 800 => &[512, 256, 128],
        _ => &[800, 512, 256, 128],
    }
}

/// Disk-only: exact tier, then grid-friendly upscales (512 → 800 before 128).
fn peek_tier_path(dir: &Path, want: u32) -> Option<PathBuf> {
    if let Some(p) = tier_exists(dir, want) {
        return Some(p);
    }
    for &tier in peek_fallback_tiers(want) {
        if let Some(p) = tier_exists(dir, tier) {
            return Some(p);
        }
    }
    None
}

#[tauri::command]
pub async fn cover_cache_ensure(
    app: AppHandle,
    args: CoverCacheEnsureArgs,
) -> Result<CoverCacheEnsureResult, String> {
    let st = state(&app)?;
    CoverCacheState::ensure_inner(&st, &app, &args, None).await
}

#[tauri::command]
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
pub async fn cover_cache_stats(app: AppHandle) -> Result<CoverCacheStatsDto, String> {
    let st = state(&app)?;
    let root = {
        let guard = st.lock().await;
        guard.root.clone()
    };
    let (bytes, entry_count) = tauri::async_runtime::spawn_blocking(move || dir_usage_at_root(&root))
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
pub async fn cover_cache_evict_tick(_app: AppHandle) -> Result<u32, String> {
    Ok(0)
}

#[tauri::command]
pub async fn cover_cache_stats_server(
    app: AppHandle,
    server_index_key: String,
) -> Result<CoverCacheStatsDto, String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    let (bytes, entry_count) = dir_usage_for_server(&guard.root, &server_index_key);
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
    drop(guard);
    let _ = app.emit(
        "cover:cache-cleared",
        serde_json::json!({ "serverIndexKey": server_index_key }),
    );
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

/// FS-only worker for `cover_cache_rename_server_bucket`, lifted out so the
/// command-level behaviour (sanitization + every short-circuit + the merge
/// branch) is testable against a real `tempdir` without spinning up Tauri
/// State. The command wrapper above adds nothing the tests need to cover
/// except the event emit.
fn rename_bucket_inner(root: &std::path::Path, old_key: &str, new_key: &str) -> Result<(), String> {
    if old_key.is_empty() || new_key.is_empty() {
        return Err("cover_cache_rename_server_bucket: empty key".into());
    }
    if !is_safe_index_key(old_key) || !is_safe_index_key(new_key) {
        return Err("cover_cache_rename_server_bucket: key contains path separator".into());
    }
    if old_key == new_key {
        return Ok(());
    }

    let old_dir = root.join(old_key);
    let new_dir = root.join(new_key);

    if !old_dir.is_dir() {
        return Ok(());
    }

    if !new_dir.exists() {
        std::fs::rename(&old_dir, &new_dir).map_err(|e| e.to_string())?;
    } else {
        merge_cover_bucket(&old_dir, &new_dir)?;
        let _ = std::fs::remove_dir_all(&old_dir);
    }
    Ok(())
}

fn is_safe_index_key(key: &str) -> bool {
    // Real index keys are `host[:port][/sub/path]` shape — forward slashes
    // are legitimate path components (Navidrome behind a reverse-proxy
    // subpath, etc.). Everything below is defense-in-depth at the FS
    // boundary; real keys come out of `serverIndexKeyFromUrl` and never
    // start with a separator or carry the patterns we reject here.
    if key.is_empty() {
        return false;
    }
    // Absolute-path leaders — `root.join("/etc/...")` and `root.join("\\foo\\")`
    // on Unix / Windows respectively REPLACE the base path with the absolute
    // argument. Reject before that ever happens.
    if key.starts_with('/') || key.starts_with('\\') {
        return false;
    }
    // Windows drive-letter root (`C:`, `c:`). `Path::join("C:")` is also
    // treated as absolute on Windows.
    let bytes = key.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return false;
    }
    // Backslash anywhere — separators are forward-slash only.
    if key.contains('\\') {
        return false;
    }
    // No `..` segments anywhere — would escape the cover-cache root.
    for segment in key.split('/') {
        if segment == ".." {
            return false;
        }
    }
    true
}

fn merge_cover_bucket(old_dir: &std::path::Path, new_dir: &std::path::Path) -> Result<(), String> {
    let entries = std::fs::read_dir(old_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = new_dir.join(entry.file_name());
        if to.exists() {
            // Prefer existing in destination — newer bucket wins.
            continue;
        }
        if from.is_dir() {
            std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            merge_cover_bucket(&from, &to)?;
        } else {
            std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
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
pub async fn cover_cache_clear(app: AppHandle) -> Result<(), String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    if guard.root.exists() {
        for entry in std::fs::read_dir(&guard.root).map_err(|e| e.to_string())?.flatten() {
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
    let _ = app.emit("cover:cache-cleared", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
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
        let cached_dirs = count_cached_cover_ids(&root, &index_key);
        collect_cover_progress(
            &store,
            &library_server_id,
            &root,
            &index_key,
            cached_dirs,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn library_cover_clear_fetch_failures(
    app: AppHandle,
    server_index_key: String,
) -> Result<u32, String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    Ok(clear_cover_fetch_failures(&guard.root, &server_index_key))
}

#[tauri::command]
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
pub fn cover_revalidate_enqueue() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
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

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{ImageBuffer, ImageFormat, Rgba};

    use super::decode_image_bytes;
    use super::disk::{cover_dir, tier_path};
    use super::{is_safe_index_key, merge_cover_bucket, rename_bucket_inner};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn disk_layout_paths() {
        let root = std::path::Path::new("/tmp/cover-test");
        let dir = cover_dir(root, "srv", "album", "al-1");
        assert_eq!(dir, root.join("srv").join("album").join("al-1"));
        assert_eq!(tier_path(&dir, 512), dir.join("512.webp"));
    }

    #[test]
    fn decode_image_bytes_accepts_png() {
        let img = ImageBuffer::from_pixel(2, 2, Rgba([1u8, 2, 3, 255]));
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png).expect("png encode");
        let decoded = decode_image_bytes(buf.get_ref()).expect("png decode");
        assert_eq!(decoded.width(), 2);
        assert_eq!(decoded.height(), 2);
    }

    #[test]
    fn safe_index_key_accepts_real_keys() {
        assert!(is_safe_index_key("music.example.com"));
        assert!(is_safe_index_key("192.168.0.10:4533"));
        assert!(is_safe_index_key("music.example.com/navidrome"));
        assert!(is_safe_index_key("[fe80::1]:4533"));
    }

    #[test]
    fn safe_index_key_rejects_path_traversal_and_backslashes() {
        assert!(!is_safe_index_key("../etc"));
        assert!(!is_safe_index_key("a/../b"));
        assert!(!is_safe_index_key("a\\b"));
        assert!(!is_safe_index_key("..\\evil"));
    }

    #[test]
    fn safe_index_key_rejects_absolute_paths_and_drive_letters() {
        // Path::join with an absolute argument replaces the base — must
        // never accept keys that lead with a separator.
        assert!(!is_safe_index_key("/etc/passwd"));
        assert!(!is_safe_index_key("/"));
        assert!(!is_safe_index_key("\\windows"));
        // Windows drive-letter roots are also treated as absolute.
        assert!(!is_safe_index_key("C:"));
        assert!(!is_safe_index_key("C:/Windows"));
        assert!(!is_safe_index_key("c:foo"));
        // Empty key is meaningless and would join to the root itself.
        assert!(!is_safe_index_key(""));
    }

    /// Build a unique tmpdir for the merge tests so parallel runs don't trip
    /// on each other.
    fn fresh_tmpdir(label: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        p.push(format!("psysonic-cover-merge-{}-{}", label, nanos));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn merge_bucket_moves_unique_files() {
        let root = fresh_tmpdir("unique");
        let old = root.join("old");
        let new_ = root.join("new");
        fs::create_dir_all(old.join("al-1")).unwrap();
        fs::write(old.join("al-1").join("128.webp"), b"old-bytes").unwrap();
        fs::create_dir_all(&new_).unwrap();

        merge_cover_bucket(&old, &new_).unwrap();

        assert!(new_.join("al-1").join("128.webp").exists());
        assert_eq!(fs::read(new_.join("al-1").join("128.webp")).unwrap(), b"old-bytes");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn merge_bucket_prefers_existing_on_collision() {
        let root = fresh_tmpdir("collision");
        let old = root.join("old");
        let new_ = root.join("new");
        fs::create_dir_all(old.join("al-1")).unwrap();
        fs::create_dir_all(new_.join("al-1")).unwrap();
        fs::write(old.join("al-1").join("128.webp"), b"OLD").unwrap();
        fs::write(new_.join("al-1").join("128.webp"), b"NEW").unwrap();

        merge_cover_bucket(&old, &new_).unwrap();

        // Existing destination wins; nothing was overwritten.
        assert_eq!(fs::read(new_.join("al-1").join("128.webp")).unwrap(), b"NEW");
        let _ = fs::remove_dir_all(&root);
    }

    // ── rename_bucket_inner — command-level behaviour ─────────────────────────

    #[test]
    fn rename_bucket_inner_rejects_empty_keys() {
        let root = fresh_tmpdir("rename-empty");
        assert!(rename_bucket_inner(&root, "", "new").is_err());
        assert!(rename_bucket_inner(&root, "old", "").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_rejects_unsafe_keys() {
        let root = fresh_tmpdir("rename-unsafe");
        assert!(rename_bucket_inner(&root, "../escape", "new").is_err());
        assert!(rename_bucket_inner(&root, "old", "/abs/path").is_err());
        assert!(rename_bucket_inner(&root, "old", "C:/Windows").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_noop_when_old_missing() {
        let root = fresh_tmpdir("rename-missing");
        // No old dir exists at all — must succeed without creating new.
        rename_bucket_inner(&root, "old", "new").unwrap();
        assert!(!root.join("new").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_noop_when_keys_equal() {
        let root = fresh_tmpdir("rename-equal");
        fs::create_dir_all(root.join("same").join("al-1")).unwrap();
        fs::write(root.join("same").join("al-1").join("128.webp"), b"x").unwrap();
        rename_bucket_inner(&root, "same", "same").unwrap();
        // Still exactly where it was; nothing renamed.
        assert!(root.join("same").join("al-1").join("128.webp").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_simple_rename_when_new_missing() {
        let root = fresh_tmpdir("rename-simple");
        fs::create_dir_all(root.join("old").join("al-1")).unwrap();
        fs::write(root.join("old").join("al-1").join("128.webp"), b"payload").unwrap();
        rename_bucket_inner(&root, "old", "new").unwrap();
        assert!(!root.join("old").exists());
        assert_eq!(
            fs::read(root.join("new").join("al-1").join("128.webp")).unwrap(),
            b"payload",
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_bucket_inner_merges_when_new_exists() {
        let root = fresh_tmpdir("rename-merge");
        fs::create_dir_all(root.join("old").join("al-1")).unwrap();
        fs::create_dir_all(root.join("new").join("al-2")).unwrap();
        fs::write(root.join("old").join("al-1").join("128.webp"), b"from-old").unwrap();
        fs::write(root.join("new").join("al-2").join("128.webp"), b"from-new").unwrap();
        // Collision on al-2 — destination wins.
        fs::create_dir_all(root.join("old").join("al-2")).unwrap();
        fs::write(root.join("old").join("al-2").join("128.webp"), b"overwrite-attempt").unwrap();

        rename_bucket_inner(&root, "old", "new").unwrap();

        // Old bucket gone.
        assert!(!root.join("old").exists());
        // al-1 moved in.
        assert_eq!(
            fs::read(root.join("new").join("al-1").join("128.webp")).unwrap(),
            b"from-old",
        );
        // al-2 destination preserved (prefer-existing).
        assert_eq!(
            fs::read(root.join("new").join("al-2").join("128.webp")).unwrap(),
            b"from-new",
        );
        let _ = fs::remove_dir_all(&root);
    }
}
