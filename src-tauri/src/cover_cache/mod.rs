//! Cover art disk cache — WebP tiers, prefetch, revalidation (phase B).

mod disk;
mod encode;
mod fetch;

use disk::{cover_dir, tier_exists, tier_path, DERIVE_TIERS};
use encode::write_webp_tier;
use fetch::{build_cover_art_url, fetch_cover_bytes};
use image::ImageReader;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
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
    pub server_id: String,
    pub cover_art_id: String,
    pub tier: u32,
    pub rest_base_url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheBatchArgs {
    pub items: Vec<CoverCacheEnsureArgs>,
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
        let dir = cover_dir(&this.root, &args.server_id, &args.cover_art_id);
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

        let url = build_cover_art_url(
            &args.rest_base_url,
            &args.username,
            &args.password,
            &args.cover_art_id,
            800,
        );
        let client = this.client.clone();
        drop(this);
        let bytes = fetch_cover_bytes(&client, &url).await?;
        let img = ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .decode()
            .map_err(|e| e.to_string())?;

        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for &tier in &DERIVE_TIERS {
            let path = tier_path(&dir, tier);
            write_webp_tier(&img, tier, &path)?;
            let _ = app.emit(
                "cover:tier-ready",
                serde_json::json!({
                    "serverId": args.server_id,
                    "coverArtId": args.cover_art_id,
                    "tier": tier,
                    "path": path.to_string_lossy(),
                }),
            );
        }

        let out_path = tier_path(&dir, args.tier);
        Ok(CoverCacheEnsureResult {
            hit: true,
            path: out_path.to_string_lossy().into_owned(),
            tier: args.tier,
        })
    }
}

fn state(app: &AppHandle) -> Result<Arc<Mutex<CoverCacheState>>, String> {
    app.try_state::<Arc<Mutex<CoverCacheState>>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "cover cache not initialized".into())
}

pub fn init_cover_cache(app: &AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cover-cache");
    app.manage(Arc::new(Mutex::new(CoverCacheState::new(root)?)));
    Ok(())
}

#[tauri::command]
pub async fn cover_cache_ensure(
    app: AppHandle,
    args: CoverCacheEnsureArgs,
) -> Result<CoverCacheEnsureResult, String> {
    let st = state(&app)?;
    CoverCacheState::ensure_inner(&st, &app, &args).await
}

#[tauri::command]
pub async fn cover_cache_ensure_batch(
    app: AppHandle,
    args: CoverCacheBatchArgs,
) -> Result<(), String> {
    let st = state(&app)?;
    for item in args.items {
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
                        "serverId": server.file_name().to_string_lossy(),
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
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn library_cover_backfill_batch(
    _app: AppHandle,
    _server_id: String,
    _cursor: Option<String>,
    _limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "coverIds": [],
        "nextCursor": null,
        "exhausted": true
    }))
}

#[tauri::command]
pub fn library_cover_progress(_server_id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "totalDistinct": 0,
        "pending": 0,
        "done": 0
    }))
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
