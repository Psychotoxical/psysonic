//! Cover art disk cache — WebP tiers, prefetch, revalidation (phase B).

mod backfill_worker;
mod disk;
mod encode;
mod fetch;

use disk::{cover_dir, tier_exists, tier_path, DERIVE_TIERS};
use encode::write_webp_tier;
use fetch::{build_cover_art_url, fetch_cover_bytes};
use image::{DynamicImage, ImageReader};
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
    pub cover_art_id: String,
    pub tier: u32,
    pub rest_base_url: String,
    pub username: String,
    pub password: String,
    /// Library backfill: all derived tiers, no `cover:tier-ready` floods to the webview.
    #[serde(default)]
    pub library_bulk: bool,
}

/// Cap concurrent cover HTTP fetches (library backfill + UI share this pool).
const COVER_HTTP_CONCURRENCY: usize = 16;

pub struct CoverCacheState {
    pub root: PathBuf,
    pub client: Client,
    pub max_bytes: u64,
    pub high_watermark_pct: u64,
    pub resume_watermark_pct: u64,
    pub http_sem: Arc<Semaphore>,
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
        })
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
        let dir = cover_dir(&this.root, &args.server_index_key, &args.cover_art_id);
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
        drop(this);

        if cover_fetch_recently_failed(&dir) {
            return Ok(CoverCacheEnsureResult {
                hit: false,
                path: String::new(),
                tier: args.tier,
            });
        }

        let img = match load_cover_source(&dir, &client, &http_sem, args).await {
            Ok(img) => img,
            Err(_) => {
                let _ = std::fs::create_dir_all(&dir);
                let _ = std::fs::write(dir.join(COVER_FETCH_FAIL_MARKER), b"1");
                return Ok(CoverCacheEnsureResult {
                    hit: false,
                    path: String::new(),
                    tier: args.tier,
                });
            }
        };
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

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

        let mut wrote_requested = false;
        if quiet {
            let dir_bg = dir.clone();
            let img_bg = img.clone();
            let max_tier = requested;
            let wrote = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
                disk::write_derived_webp_tiers(&dir_bg, &img_bg, max_tier)?;
                Ok(tier_exists(&dir_bg, max_tier).is_some())
            })
            .await
            .map_err(|e| e.to_string())??;
            wrote_requested = wrote;
        } else {
            for tier in tiers_now {
                if tier_exists(&dir, tier).is_some() {
                    if tier == requested {
                        wrote_requested = true;
                    }
                    continue;
                }
                let path = tier_path(&dir, tier);
                write_webp_tier(&img, tier, &path)?;
                emit_tier_ready(app, args, tier, &path);
                if tier == requested {
                    wrote_requested = true;
                }
            }
        }

        if !wrote_requested && tier_exists(&dir, requested).is_some() {
            wrote_requested = true;
        }

        let out_path = tier_path(&dir, requested);
        if wrote_requested || out_path.is_file() {
            if !quiet {
                spawn_derive_remaining_tiers(
                    app.clone(),
                    state.clone(),
                    root,
                    args.clone(),
                    img,
                    requested,
                );
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
            "coverArtId": args.cover_art_id,
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

async fn load_cover_source(
    dir: &Path,
    client: &Client,
    http_sem: &Semaphore,
    args: &CoverCacheEnsureArgs,
) -> Result<DynamicImage, String> {
    if let Some(img) = load_image_from_disk(dir) {
        return Ok(img);
    }
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
    let bytes = fetch_cover_bytes(client, &url).await?;
    decode_image_bytes(&bytes)
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
        let dir = {
            let guard = state.lock().await;
            cover_dir(&guard.root, &args.server_index_key, &args.cover_art_id)
        };
        let _ = tauri::async_runtime::spawn_blocking(move || {
            for tier in tiers_bg {
                if tier_exists(&dir, tier).is_some() {
                    continue;
                }
                let path = tier_path(&dir, tier);
                if write_webp_tier(&img, tier, &path).is_ok() {
                    emit_tier_ready(&app, &args, tier, &path);
                }
            }
        })
        .await;
    });
}

fn dir_has_any_cached_tier(dir: &Path) -> bool {
    if tier_exists(dir, 800).is_some() {
        return true;
    }
    for tier in DERIVE_TIERS {
        if tier != 800 && tier_exists(dir, tier).is_some() {
            return true;
        }
    }
    tier_exists(dir, 2000).is_some()
}

fn count_cached_in_server_dir(server_dir: &Path) -> i64 {
    let Ok(entries) = std::fs::read_dir(server_dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| dir_has_any_cached_tier(&e.path()))
        .count() as i64
}

/// Count cover ID dirs with any cached tier (UI progress — matches visible disk cache).
pub(crate) fn count_cached_cover_ids(root: &Path, server_index_key: &str) -> i64 {
    let keyed = count_cached_in_server_dir(&root.join(server_index_key));
    if keyed > 0 {
        return keyed;
    }
    // Legacy profile-uuid bucket or host alias — don't show 0 when files exist elsewhere.
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| {
            e.path().is_dir()
                && e.file_name().to_string_lossy() != ".storage-layout"
        })
        .map(|e| count_cached_in_server_dir(&e.path()))
        .max()
        .unwrap_or(0)
}

/// Disk usage for one server bucket only (cheaper than scanning all hosts).
pub(crate) fn dir_usage_for_server(root: &Path, server_index_key: &str) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut count = 0u64;
    let server_dir = root.join(server_index_key);
    let Ok(ids) = std::fs::read_dir(&server_dir) else {
        return (0, 0);
    };
    for id_dir in ids.flatten() {
        if !id_dir.path().is_dir() {
            continue;
        }
        if dir_has_any_cached_tier(&id_dir.path()) {
            count += 1;
        }
        let Ok(files) = std::fs::read_dir(id_dir.path()) else {
            continue;
        };
        for f in files.flatten() {
            if let Ok(meta) = f.metadata() {
                bytes += meta.len();
            }
        }
    }
    (bytes, count)
}

pub(crate) fn dir_usage_at_root(root: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut count = 0u64;
    let Ok(entries) = std::fs::read_dir(root) else {
        return (0, 0);
    };
    for server in entries.flatten() {
        if server.file_name().to_string_lossy() == ".storage-layout" {
            continue;
        }
        if !server.path().is_dir() {
            continue;
        }
        let Ok(ids) = std::fs::read_dir(server.path()) else {
            continue;
        };
        for id_dir in ids.flatten() {
            if !id_dir.path().is_dir() {
                continue;
            }
            if dir_has_any_cached_tier(&id_dir.path()) {
                count += 1;
            }
            let Ok(files) = std::fs::read_dir(id_dir.path()) else {
                continue;
            };
            for f in files.flatten() {
                if let Ok(meta) = f.metadata() {
                    bytes += meta.len();
                }
            }
        }
    }
    (bytes, count)
}

fn state(app: &AppHandle) -> Result<Arc<Mutex<CoverCacheState>>, String> {
    app.try_state::<Arc<Mutex<CoverCacheState>>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "cover cache not initialized".into())
}

const COVER_CACHE_LAYOUT_STAMP: &str = "index-key-v1";

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
    pub cover_art_id: String,
    pub tier: u32,
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
        let dir = cover_dir(&root, &item.server_index_key, &item.cover_art_id);
        let path = peek_tier_path(&dir, item.tier);
        if let Some(p) = path {
            let key = format!(
                "{}:cover:{}:{}",
                item.server_index_key, item.cover_art_id, item.tier
            );
            out.insert(key, p.to_string_lossy().into_owned());
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
    server_index_key: String,
    cover_art_id: String,
    tier: u32,
    rest_base_url: String,
    username: String,
    password: String,
) -> Result<CoverCacheEnsureResult, String> {
    let args = CoverCacheEnsureArgs {
        server_index_key,
        cover_art_id,
        tier,
        rest_base_url,
        username,
        password,
        library_bulk: false,
    };
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
    let path = guard.root.join(&server_index_key);
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
    use super::disk::{cover_dir, tier_path};

    #[test]
    fn disk_layout_paths() {
        let root = std::path::Path::new("/tmp/cover-test");
        let dir = cover_dir(root, "srv", "al-1");
        assert_eq!(dir, root.join("srv").join("al-1"));
        assert_eq!(tier_path(&dir, 512), dir.join("512.webp"));
    }
}
