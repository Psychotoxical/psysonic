use super::cache_state::CoverCacheState;
use super::disk::{self, cover_dir, tier_exists, tier_path, DERIVE_TIERS};
use super::dto::{CoverCacheEnsureArgs, CoverCacheEnsureResult};
use super::encode::write_webp_tier;
use super::fetch::build_cover_art_url;
use super::peek::ensure_peek;
use super::{external_ensure, fetch, metrics};
use image::{DynamicImage, ImageReader};
use psysonic_library::cover_backfill::{cover_fetch_recently_failed, COVER_FETCH_FAIL_MARKER};
use psysonic_library::LibraryRuntime;
use reqwest::Client;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, Semaphore};

/// Result of the foreground tier-encode pass: whether the requested tier was
/// written, the freshly written `(tier, path)` pairs, and the full-resolution
/// decoded source kept for deriving the larger tiers (None on the bulk/quiet
/// path, which writes every tier up front).
type EncodeTiersOutcome = Result<(bool, Vec<(u32, PathBuf)>, Option<DynamicImage>), String>;

fn cover_dir_for_args(root: &Path, args: &CoverCacheEnsureArgs) -> PathBuf {
    cover_dir(
        root,
        &args.server_index_key,
        &args.cache_kind,
        &args.cache_entity_id,
    )
}

impl CoverCacheState {
    pub(crate) async fn ensure_inner(
        state: &Arc<Mutex<CoverCacheState>>,
        app: &AppHandle,
        args: &CoverCacheEnsureArgs,
        http_sem_override: Option<Arc<Semaphore>>,
    ) -> Result<CoverCacheEnsureResult, String> {
        let this = state.lock().await;
        let dir = cover_dir_for_args(&this.root, args);
        if let Some(path) = ensure_peek(&dir, args.tier, args) {
            return Ok(CoverCacheEnsureResult {
                hit: true,
                path: path.to_string_lossy().into_owned(),
                tier: args.tier,
            });
        }

        // Cheap, no-IO gate. Previously this ran a full recursive disk walk of
        // the entire cover cache (`pressure()` → `dir_usage_at_root`) on every
        // ensure, under the global state lock — serializing the whole backfill
        // pool onto filesystem stat work. The walked bytes were then discarded.
        let (_, auto_dl) = this.pressure_from_bytes(0);
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
        let fanart_sem = this.fanart_http_sem.clone();
        let musicbrainz_sem = this.musicbrainz_sem.clone();
        drop(this);

        if cover_fetch_recently_failed(&dir) {
            return Ok(CoverCacheEnsureResult {
                hit: false,
                path: String::new(),
                tier: args.tier,
            });
        }

        // For an external artist surface (`fanart` 16:9 background or `banner`
        // strip), resolve fanart.tv only. Surface-specific fallback remains the
        // caller's responsibility.
        if args.external_artwork_enabled && !args.library_bulk && args.cache_kind == "artist" {
            if let Some(surface) = external_ensure::external_surface(args.surface_kind.as_deref()) {
                let external = external_ensure::try_external_fanart(
                    app,
                    args,
                    &dir,
                    &client,
                    &fanart_sem,
                    &musicbrainz_sem,
                    args.tier,
                    surface,
                )
                .await;
                return Ok(match external {
                    Some(path) => CoverCacheEnsureResult {
                        hit: true,
                        path: path.to_string_lossy().into_owned(),
                        tier: args.tier,
                    },
                    None => CoverCacheEnsureResult {
                        hit: false,
                        path: String::new(),
                        tier: args.tier,
                    },
                });
            }
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

        // Full-res must come from the network: the largest on-disk derive tier is
        // 800, so reusing a disk tier as the source would store a `2000.webp` that
        // is only 800px (resize never upscales). Smaller tiers may reuse a disk
        // source.
        let disk_source = if args.tier >= 2000 {
            None
        } else {
            load_image_from_disk(&dir)
        };
        let source = if let Some(img) = disk_source {
            CoverSource::Image(img)
        } else {
            let http_registry = app
                .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
                .map(|s| Arc::clone(&*s));
            match download_cover_payload(&dir, &client, &http_sem, args, http_registry).await {
                Ok(bytes) => CoverSource::Bytes(bytes),
                Err(err) => {
                    log_cover_fetch_failure(app, args, &err);
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
        let tiers_bg = tiers_now.clone();
        let cpu_permit = cover_cpu_sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        let (mut wrote_requested, fresh_tiers, derive_source) =
            tauri::async_runtime::spawn_blocking(move || -> EncodeTiersOutcome {
                let _cpu_permit = cpu_permit;
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
                    return Ok((wrote_requested, fresh, None));
                }
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
                // Hand the full-resolution decoded source back so larger tiers
                // derive directly from it rather than from a smaller written tier.
                Ok((wrote_requested, fresh, Some(img)))
            })
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
            metrics::note_ui_cover_produced(args);
            if !quiet {
                if let Some(img) = derive_source {
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

/// Log a non-200 / failed cover download with the album/artist name when known.
fn log_cover_fetch_failure(app: &AppHandle, args: &CoverCacheEnsureArgs, err: &str) {
    let label = args
        .library_server_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(|lib_id| {
            app.try_state::<LibraryRuntime>().and_then(|rt| {
                psysonic_library::cover_resolve::describe_cover_entity(
                    &rt.store,
                    lib_id,
                    &args.cache_kind,
                    &args.cache_entity_id,
                )
            })
        })
        .unwrap_or_else(|| format!("{} {}", args.cache_kind, args.cache_entity_id));
    if args.library_bulk {
        crate::app_eprintln!(
            "[cover-backfill] fetch failed for {label} (coverArtId={}, tier={}): {err}",
            args.cover_art_id,
            args.tier
        );
    } else {
        crate::app_deprintln!(
            "[cover] fetch failed for {label} (coverArtId={}, tier={}): {err}",
            args.cover_art_id,
            args.tier
        );
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

pub(super) fn decode_image_bytes(bytes: &[u8]) -> Result<DynamicImage, String> {
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
    registry: Option<Arc<psysonic_core::server_http::ServerHttpRegistry>>,
) -> Result<Vec<u8>, String> {
    let _permit = http_sem.acquire().await.map_err(|e| e.to_string())?;
    let fetch_size = if args.tier >= 2000 { 2000 } else { 800 };
    let url = build_cover_art_url(
        &args.rest_base_url,
        &args.username,
        &args.password,
        &args.cover_art_id,
        fetch_size,
    );
    fetch::fetch_cover_bytes(
        client,
        &url,
        registry.as_deref(),
        Some(args.server_index_key.as_str()),
    )
    .await
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
        let Ok(cpu_permit) = cover_cpu_sem.clone().acquire_owned().await else {
            return;
        };
        let written = tauri::async_runtime::spawn_blocking(move || -> Vec<(u32, PathBuf)> {
            let _cpu_permit = cpu_permit;
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

#[cfg(test)]
mod tests {
    use super::decode_image_bytes;
    use image::{ImageBuffer, ImageFormat, Rgba};
    use std::io::Cursor;

    #[test]
    fn decode_image_bytes_accepts_png() {
        let img = ImageBuffer::from_pixel(2, 2, Rgba([1u8, 2, 3, 255]));
        let mut buf = Cursor::new(Vec::new());
        img.write_to(&mut buf, ImageFormat::Png)
            .expect("png encode");
        let decoded = decode_image_bytes(buf.get_ref()).expect("png decode");
        assert_eq!(decoded.width(), 2);
        assert_eq!(decoded.height(), 2);
    }
}
