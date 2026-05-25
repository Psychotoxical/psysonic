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
        let ratio = bytes as f64 / self.max_bytes.max(1) as f64;
        if ratio >= 0.9 {
            ("full".into(), false)
        } else if ratio >= 0.85 {
            ("pressure".into(), false)
        } else {
            ("ok".into(), true)
        }
    }

    async fn ensure_inner(
        &self,
        app: &AppHandle,
        args: &CoverCacheEnsureArgs,
    ) -> Result<CoverCacheEnsureResult, String> {
        let dir = cover_dir(&self.root, &args.server_id, &args.cover_art_id);
        if let Some(path) = tier_exists(&dir, args.tier) {
            return Ok(CoverCacheEnsureResult {
                hit: true,
                path: path.to_string_lossy().into_owned(),
                tier: args.tier,
            });
        }

        let (_, auto_dl) = self.pressure();
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
        let bytes = fetch_cover_bytes(&self.client, &url).await?;
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

fn state(app: &AppHandle) -> Result<Arc<CoverCacheState>, String> {
    app.try_state::<Arc<CoverCacheState>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "cover cache not initialized".into())
}

pub fn init_cover_cache(app: &AppHandle) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("cover-cache");
    let inner = Arc::new(CoverCacheState::new(root)?);
    app.manage(inner);
    Ok(())
}

#[tauri::command]
pub async fn cover_cache_ensure(
    app: AppHandle,
    args: CoverCacheEnsureArgs,
) -> Result<CoverCacheEnsureResult, String> {
    let st = state(&app)?;
    st.ensure_inner(&app, &args).await
}

#[tauri::command]
pub async fn cover_cache_ensure_batch(
    app: AppHandle,
    args: CoverCacheBatchArgs,
) -> Result<(), String> {
    let st = state(&app)?;
    for item in args.items {
        let _ = st.ensure_inner(&app, &item).await;
    }
    Ok(())
}

#[tauri::command]
pub fn cover_cache_stats(app: AppHandle) -> Result<CoverCacheStatsDto, String> {
    let st = state(&app)?;
    let (bytes, entry_count) = st.dir_usage();
    let (pressure, auto_download_enabled) = st.pressure();
    Ok(CoverCacheStatsDto {
        bytes,
        count: entry_count,
        pressure,
        auto_download_enabled,
        entry_count,
    })
}

#[tauri::command]
pub fn cover_cache_evict_tick(app: AppHandle) -> Result<u32, String> {
    let st = state(&app)?;
    let (bytes, _) = st.dir_usage();
    if (bytes as f64) / (st.max_bytes.max(1) as f64) < 0.9 {
        return Ok(0);
    }
    let mut evicted = 0u32;
    let Ok(entries) = std::fs::read_dir(&st.root) else {
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
            let (b, _) = st.dir_usage();
            if (b as f64) / (st.max_bytes.max(1) as f64) < 0.85 {
                break 'outer;
            }
        }
    }
    Ok(evicted)
}

#[tauri::command]
pub fn cover_cache_clear(app: AppHandle) -> Result<(), String> {
    let st = state(&app)?;
    if st.root.exists() {
        for entry in std::fs::read_dir(&st.root).map_err(|e| e.to_string())?.flatten() {
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
pub fn cover_revalidate_tick() -> Result<u32, String> {
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
