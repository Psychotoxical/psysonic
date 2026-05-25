//! Cover art disk cache — WebP tiers, prefetch, revalidation (phase B).

mod disk;
mod encode;
mod fetch;

use disk::{cover_dir, tier_exists, tier_path, DERIVE_TIERS};
use encode::write_webp_tier;
use fetch::{build_cover_art_url, fetch_cover_bytes};
use image::{DynamicImage, ImageReader};
use psysonic_library::cover_backfill::{
    collect_cover_backfill_batch, collect_cover_progress, LibraryCoverBackfillBatchDto,
    LibraryCoverProgressDto,
};
use psysonic_library::LibraryRuntime;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
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
}

pub struct CoverCacheState {
    pub root: PathBuf,
    pub client: Client,
    pub max_bytes: u64,
    pub high_watermark_pct: u64,
    pub resume_watermark_pct: u64,
}

impl CoverCacheState {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let client = Client::builder()
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            root,
            client,
            max_bytes: 10 * 1024 * 1024 * 1024,
            high_watermark_pct: 90,
            resume_watermark_pct: 85,
        })
    }

    fn dir_usage(&self) -> (u64, u64) {
        let mut bytes = 0u64;
        let mut count = 0u64;
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return (0, 0);
        };
        for server in entries.flatten() {
            let Ok(ids) = std::fs::read_dir(server.path()) else {
                continue;
            };
            for id_dir in ids.flatten() {
                count += 1;
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

    fn pressure(&self) -> (String, bool) {
        let (bytes, _) = self.dir_usage();
        let max = self.max_bytes.max(1) as f64;
        let ratio = bytes as f64 / max;
        let high = self.high_watermark_pct as f64 / 100.0;
        let resume = self.resume_watermark_pct as f64 / 100.0;
        if ratio >= high {
            ("full".into(), false)
        } else if ratio >= resume {
            ("pressure".into(), false)
        } else {
            ("ok".into(), true)
        }
    }

    async fn ensure_inner(
        state: &Arc<Mutex<CoverCacheState>>,
        app: &AppHandle,
        args: &CoverCacheEnsureArgs,
    ) -> Result<CoverCacheEnsureResult, String> {
        let this = state.lock().await;
        let dir = cover_dir(&this.root, &args.server_index_key, &args.cover_art_id);
        if let Some(path) = tier_exists(&dir, args.tier) {
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
        drop(this);

        let img = load_cover_source(&dir, &client, args).await?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        let requested = args.tier;
        let tiers_now: Vec<u32> = if requested == 2000 {
            vec![2000]
        } else {
            DERIVE_TIERS
                .iter()
                .copied()
                .filter(|t| *t <= requested)
                .collect()
        };

        let mut wrote_requested = false;
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

        if !wrote_requested && tier_exists(&dir, requested).is_some() {
            wrote_requested = true;
        }

        let out_path = tier_path(&dir, requested);
        if wrote_requested || out_path.is_file() {
            spawn_derive_remaining_tiers(
                app.clone(),
                state.clone(),
                root,
                args.clone(),
                img,
                requested,
            );
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
    args: &CoverCacheEnsureArgs,
) -> Result<DynamicImage, String> {
    if let Some(img) = load_image_from_disk(dir) {
        return Ok(img);
    }
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

fn count_cached_cover_ids(root: &Path, server_index_key: &str) -> i64 {
    let server_dir = root.join(server_index_key);
    let Ok(entries) = std::fs::read_dir(&server_dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| tier_exists(&e.path(), 800).is_some())
        .count() as i64
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

pub fn init_cover_cache(app: &AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cover-cache");
    reset_cover_cache_for_index_key_layout(&root)?;
    app.manage(Arc::new(Mutex::new(CoverCacheState::new(root)?)));
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
pub fn cover_cache_peek_batch(
    app: AppHandle,
    items: Vec<CoverCachePeekItem>,
) -> Result<HashMap<String, String>, String> {
    let st = state(&app)?;
    let guard = st.blocking_lock();
    let root = guard.root.clone();
    drop(guard);
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

fn peek_tier_path(dir: &Path, want: u32) -> Option<PathBuf> {
    if let Some(p) = tier_exists(dir, want) {
        return Some(p);
    }
    let fallbacks: &[u32] = if want >= 800 {
        &[512, 256, 128]
    } else if want >= 512 {
        &[256, 128]
    } else if want >= 256 {
        &[128]
    } else {
        &[]
    };
    for &tier in fallbacks {
        if let Some(p) = tier_exists(dir, tier) {
            return Some(p);
        }
    }
    if want < 800 {
        if let Some(p) = tier_exists(dir, 800) {
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
    };
    let st = state(&app)?;
    CoverCacheState::ensure_inner(&st, &app, &args).await
}

#[tauri::command]
pub async fn cover_cache_ensure_batch(
    app: AppHandle,
    items: Vec<CoverCacheEnsureArgs>,
) -> Result<(), String> {
    let st = state(&app)?;
    for item in items {
        let _ = CoverCacheState::ensure_inner(&st, &app, &item).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn cover_cache_stats(app: AppHandle) -> Result<CoverCacheStatsDto, String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    let (bytes, entry_count) = guard.dir_usage();
    let (pressure, auto_download_enabled) = guard.pressure();
    Ok(CoverCacheStatsDto {
        bytes,
        count: entry_count,
        pressure,
        auto_download_enabled,
        entry_count,
    })
}

#[tauri::command]
pub async fn cover_cache_evict_tick(app: AppHandle) -> Result<u32, String> {
    let st = state(&app)?;
    let guard = st.lock().await;
    let (bytes, _) = guard.dir_usage();
    let high = guard.high_watermark_pct as f64 / 100.0;
    if (bytes as f64) / (guard.max_bytes.max(1) as f64) < high {
        return Ok(0);
    }
    let mut evicted = 0u32;
    let root = guard.root.clone();
    let max_bytes = guard.max_bytes;
    let resume = guard.resume_watermark_pct as f64 / 100.0;
    drop(guard);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(0);
    };
    'outer: for server in entries.flatten() {
        let Ok(ids) = std::fs::read_dir(server.path()) else {
            continue;
        };
        for id_dir in ids.flatten() {
            let path = id_dir.path();
            if std::fs::remove_dir_all(&path).is_ok() {
                evicted += 1;
                let _ = app.emit(
                    "cover:evicted",
                    serde_json::json!({
                        "serverIndexKey": server.file_name().to_string_lossy(),
                        "coverArtId": id_dir.file_name().to_string_lossy(),
                    }),
                );
            }
            let guard = st.lock().await;
            let (b, _) = guard.dir_usage();
            if (b as f64) / (max_bytes.max(1) as f64) < resume {
                break 'outer;
            }
        }
    }
    Ok(evicted)
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
pub fn library_cover_backfill_batch(
    app: AppHandle,
    server_index_key: String,
    library_server_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<LibraryCoverBackfillBatchDto, String> {
    let runtime = app
        .try_state::<LibraryRuntime>()
        .ok_or_else(|| "LibraryRuntime not initialized".to_string())?;
    let _index = server_index_key;
    collect_cover_backfill_batch(&runtime.store, &library_server_id, cursor.as_deref(), limit)
}

#[tauri::command]
pub fn library_cover_progress(
    app: AppHandle,
    server_index_key: String,
    library_server_id: String,
) -> Result<LibraryCoverProgressDto, String> {
    let runtime = app
        .try_state::<LibraryRuntime>()
        .ok_or_else(|| "LibraryRuntime not initialized".to_string())?;
    let mut progress = collect_cover_progress(&runtime.store, &library_server_id)?;
    let st = state(&app)?;
    let guard = st.blocking_lock();
    let done = count_cached_cover_ids(&guard.root, &server_index_key);
    drop(guard);
    progress.done = done.min(progress.total_distinct);
    progress.pending = (progress.total_distinct - progress.done).max(0);
    Ok(progress)
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
