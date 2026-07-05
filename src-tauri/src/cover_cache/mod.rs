//! Cover art disk cache — WebP tiers, prefetch, revalidation (phase B).

mod backfill_worker;
mod disk;
mod encode;
mod external;
mod external_ensure;
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
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

/// Cumulative count of covers newly produced by on-demand (UI) ensures — the
/// source for the Performance Probe "on-demand (ui)" throughput. Library
/// backfill (`library_bulk`) is excluded; it reports via `cover:library-progress`.
static UI_ENSURE_PRODUCED: AtomicU64 = AtomicU64::new(0);

/// Snapshot of covers produced by on-demand UI ensures since process start.
pub fn ui_ensure_produced_total() -> u64 {
    UI_ENSURE_PRODUCED.load(Ordering::Relaxed)
}

/// Count one freshly produced on-demand cover. Called from `ensure_inner` on the
/// produce-success path only (past the early cache-hit gate), so pure cache hits
/// and library backfill (`library_bulk`) are excluded.
fn note_ui_cover_produced(args: &CoverCacheEnsureArgs) {
    if !args.library_bulk {
        UI_ENSURE_PRODUCED.fetch_add(1, Ordering::Relaxed);
    }
}
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheEnsureResult {
    pub hit: bool,
    pub path: String,
    pub tier: u32,
}

/// Result of the foreground tier-encode pass: whether the requested tier was
/// written, the freshly written `(tier, path)` pairs, and the full-resolution
/// decoded source kept for deriving the larger tiers (None on the bulk/quiet
/// path, which writes every tier up front).
type EncodeTiersOutcome = Result<(bool, Vec<(u32, PathBuf)>, Option<DynamicImage>), String>;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheStatsDto {
    pub bytes: u64,
    pub count: u64,
    pub pressure: String,
    pub auto_download_enabled: bool,
    pub entry_count: u64,
}

/// Live cover HTTP / WebP-encode slots — mirrors analysis pipeline probe shape.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverPipelineQueueStatsDto {
    pub http_max: u32,
    pub http_active: u32,
    pub cpu_ui_max: u32,
    pub cpu_ui_active: u32,
    pub cpu_backfill_max: u32,
    pub cpu_backfill_active: u32,
    pub library_backfill_http_max: u32,
    pub library_backfill_http_active: u32,
    pub library_backfill_pass_running: bool,
    /// Cumulative covers produced by on-demand (UI) ensures since process start.
    pub ui_ensured_total: u64,
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
        ui_ensured_total: ui_ensure_produced_total(),
    }
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
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
    /// Library server id (DB key) — set by backfill so a failed fetch can be logged
    /// with the album/artist name. On-demand UI ensures leave it `None`.
    #[serde(default)]
    pub library_server_id: Option<String>,
    /// External artwork (§16): when true, an artist `fanart`/`banner` ensure may
    /// fetch from fanart.tv into `{tier}-{provider}.webp`. Gated by the master
    /// toggle (off by default); the project key is embedded (`FANART_PROJECT_KEY`).
    #[serde(default)]
    pub external_artwork_enabled: bool,
    /// Surface intent for external artwork — `fanart` for the 16:9 artist
    /// background. `None` on plain cover ensures.
    #[serde(default)]
    pub surface_kind: Option<String>,
    /// Artist display name — context for the §19 name→MusicBrainz fallback when
    /// the artist carries no tag MBID. `None` skips that fallback.
    #[serde(default)]
    pub artist_name: Option<String>,
    /// Album title currently in context (fullscreen playback) — disambiguates
    /// the name→MusicBrainz query (§19).
    #[serde(default)]
    pub album_title: Option<String>,
    /// Optional BYOK personal fanart.tv key from settings — sent in addition to
    /// the project key (§22). Falls back to the `PSYSONIC_FANART_CLIENT_KEY` env.
    #[serde(default)]
    pub external_artwork_byok: Option<String>,
}

fn cover_dir_for_args(root: &Path, args: &CoverCacheEnsureArgs) -> PathBuf {
    cover_dir(root, &args.server_index_key, &args.cache_kind, &args.cache_entity_id)
}

/// Cap concurrent cover HTTP fetches for visible UI routes (library backfill uses its own pool).
const COVER_HTTP_CONCURRENCY: usize = 16;
/// UI-visible decode + WebP encode (grid, hero, player) — not shared with library backfill.
const COVER_CPU_UI_CONCURRENCY: usize = 2;
/// Library backfill encode ladder — separate pool so bulk warm-up cannot starve the webview.
/// Default only; runtime-tunable from the perf probe via `set_backfill_cpu_parallel`.
const COVER_CPU_BACKFILL_CONCURRENCY: usize = 2;
/// Upper bound for the runtime encode-pool knob (matches the worker cap).
const COVER_CPU_BACKFILL_MAX: usize = 16;
/// External providers (fanart.tv) get their own low-concurrency HTTP lane so
/// they can never starve Navidrome cover / getArtistInfo2 fetches (§26).
const FANART_HTTP_CONCURRENCY: usize = 4;

pub struct CoverCacheState {
    pub root: PathBuf,
    pub client: Client,
    pub max_bytes: u64,
    pub high_watermark_pct: u64,
    pub resume_watermark_pct: u64,
    pub http_sem: Arc<Semaphore>,
    pub cover_cpu_ui_sem: Arc<Semaphore>,
    pub cover_cpu_backfill_sem: Arc<Semaphore>,
    /// External-provider (fanart.tv) HTTP lane — separate from `http_sem` so
    /// external fetches never starve Navidrome cover / getArtistInfo2 (§26).
    pub fanart_http_sem: Arc<Semaphore>,
    /// MusicBrainz name→MBID lane — a single permit, so the §19 resolver runs
    /// strictly serially and the caller's ≥1s spacing keeps us under MB's rate
    /// limit (their ToS).
    pub musicbrainz_sem: Arc<Semaphore>,
    /// Live permit count of `cover_cpu_backfill_sem` (the semaphore itself only
    /// exposes *available* permits, not the configured ceiling).
    cover_cpu_backfill_max: AtomicUsize,
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
            fanart_http_sem: Arc::new(Semaphore::new(FANART_HTTP_CONCURRENCY)),
            musicbrainz_sem: Arc::new(Semaphore::new(1)),
            cover_cpu_backfill_max: AtomicUsize::new(COVER_CPU_BACKFILL_CONCURRENCY),
        })
    }

    /// Current configured ceiling of the backfill encode pool.
    pub fn cover_backfill_cpu_parallel(&self) -> usize {
        self.cover_cpu_backfill_max.load(Ordering::Relaxed).max(1)
    }

    /// Retune the backfill encode pool to match the worker's download
    /// concurrency. Grows/shrinks the semaphore permits in place.
    pub fn set_backfill_cpu_parallel(&self, threads: usize) {
        let next = threads.clamp(1, COVER_CPU_BACKFILL_MAX);
        let prev = self.cover_cpu_backfill_max.swap(next, Ordering::SeqCst);
        if next > prev {
            self.cover_cpu_backfill_sem.add_permits(next - prev);
        } else if next < prev {
            let sem = self.cover_cpu_backfill_sem.clone();
            let surplus = prev - next;
            tauri::async_runtime::spawn(async move {
                for _ in 0..surplus {
                    if let Ok(permit) = sem.acquire().await {
                        permit.forget();
                    }
                }
            });
        }
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
        // strip), resolve fanart.tv only. On a hit we return the external image;
        // on a miss we report a genuine `hit=false` (no `.fetch-failed` marker)
        // and DO NOT fall back to the Navidrome cover here. The fallback is the
        // caller's job, because each surface has its own chain: the artist-detail
        // hero wants banner → fanart → Navidrome, the fullscreen player wants
        // fanart → Navidrome. Falling back to Navidrome at this layer would mask
        // "this artist has no banner" as a hit and short-circuit the caller's
        // fanart step (the banner ensure would win the `||` with the ND cover and
        // the existing fanart would never show).
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
        let (mut wrote_requested, fresh_tiers, derive_source) = tauri::async_runtime::spawn_blocking(
            move || -> EncodeTiersOutcome {
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
                // Hand the full-resolution decoded source back so the larger tiers
                // are derived from it directly. Re-reading the largest tier off
                // disk would pick the just-written `requested` tier (≤ requested);
                // because `resize_tier` never upscales, deriving 512/800 from that
                // smaller tier stored them at the small resolution — the
                // "cover preview stays small" bug (e.g. an 800.webp that is 256×256).
                Ok((wrote_requested, fresh, Some(img)))
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
            // Past the early cache-hit gate, so reaching here means this ensure
            // decoded + (re)encoded a cover. Count on-demand (non-bulk) work for
            // the Performance Probe "on-demand (ui)" throughput.
            note_ui_cover_produced(args);
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
/// Backfill fetches (`library_bulk`) log at the normal level — the user wants to
/// see which covers a busy server refused; incidental on-demand UI misses stay at
/// the debug level so they don't spam the normal log.
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
    registry: Option<Arc<psysonic_core::server_http::ServerHttpRegistry>>,
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
        map.insert(server_index_key.to_string(), (std::time::Instant::now(), value));
    }
    value
}

pub(crate) fn invalidate_dir_usage_cache(server_index_key: &str) {
    if let Ok(mut map) = dir_usage_cache().lock() {
        map.remove(server_index_key);
    }
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

#[derive(Debug, Clone, Deserialize, specta::Type)]
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

/// Disk peek for a plain (non-surface) cover request — shared by the ensure path
/// AND `cover_cache_peek_batch`. Full-res (≥2000) is **exact-only**: a smaller
/// peek-ladder fallback would both serve a downscaled image and short-circuit the
/// download, and (via the frontend grid seeder) poison the full-res in-memory key
/// for Hero / fullscreen / artist-hero surfaces, which peek 2000 before ensure.
/// Smaller display tiers keep the normal ladder peek.
fn peek_plain_cover_tier(dir: &Path, tier: u32) -> Option<PathBuf> {
    if tier >= 2000 {
        return tier_exists(dir, tier);
    }
    peek_tier_path(dir, tier)
}

/// Peek used by the ensure path. External surfaces keep their own ladder; plain
/// covers go through [`peek_plain_cover_tier`] (full-res exact).
fn ensure_peek(dir: &Path, tier: u32, args: &CoverCacheEnsureArgs) -> Option<PathBuf> {
    if args.surface_kind.is_some() {
        return external_ensure::peek_cover_path(dir, tier, args);
    }
    peek_plain_cover_tier(dir, tier)
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

/// Delete only external-provider artifacts under a server's cover dir — the
/// `{tier}-{provider}.webp` tiers and `.miss-{provider}` markers — leaving the
/// canonical Navidrome `{tier}.webp` and `.fetch-failed` untouched (Navidrome
/// tiers have no `-` in the stem; their marker is `.fetch-failed`, not
/// `.miss-*`). FS-only so it is testable against a real `tempdir`. Returns the
/// number of files removed.
fn purge_external_files(server_dir: &Path) -> usize {
    fn is_external(name: &str) -> bool {
        (name.ends_with(".webp") && name.contains('-')) || name.starts_with(".miss-")
    }
    fn walk(dir: &Path, count: &mut usize) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                walk(&p, count);
            } else if p.file_name().and_then(|n| n.to_str()).is_some_and(is_external)
                && std::fs::remove_file(&p).is_ok()
            {
                *count += 1;
            }
        }
    }
    let mut count = 0;
    walk(server_dir, &mut count);
    count
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
    if let Ok(mut map) = dir_usage_cache().lock() {
        map.clear();
    }
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

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{ImageBuffer, ImageFormat, Rgba};

    use super::decode_image_bytes;
    use super::disk::{cover_dir, tier_path};
    use super::{
        count_cached_cover_ids, ensure_peek, is_safe_index_key, merge_cover_bucket,
        peek_plain_cover_tier, purge_external_files, rename_bucket_inner, CoverCacheEnsureArgs,
    };
    use psysonic_core::cover_cache_layout::CANONICAL_PROGRESS_TIER;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn count_cached_cover_ids_is_per_server_bucket() {
        let root = fresh_tmpdir("count-per-server");
        let home = cover_dir(&root, "music.home.example", "album", "al-home");
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join(format!("{CANONICAL_PROGRESS_TIER}.webp")),
            b"x",
        )
        .unwrap();
        assert_eq!(count_cached_cover_ids(&root, "music.home.example"), 1);
        assert_eq!(count_cached_cover_ids(&root, "music.other.example"), 0);
        let _ = fs::remove_dir_all(&root);
    }

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

    #[test]
    fn purge_external_removes_only_external_artifacts() {
        let root = fresh_tmpdir("purge-external");
        let entity = root.join("artist").join("ar-1");
        fs::create_dir_all(&entity).unwrap();
        // Navidrome canonical — must survive.
        fs::write(entity.join("2000.webp"), b"n").unwrap();
        fs::write(entity.join("512.webp"), b"n").unwrap();
        fs::write(entity.join(".fetch-failed"), b"1").unwrap();
        // External — must go.
        fs::write(entity.join("2000-fanart.webp"), b"f").unwrap();
        fs::write(entity.join("512-fanart.webp"), b"f").unwrap();
        fs::write(entity.join("2000-banner.webp"), b"b").unwrap();
        fs::write(entity.join(".miss-fanart"), b"1").unwrap();
        fs::write(entity.join(".miss-banner"), b"1").unwrap();

        assert_eq!(purge_external_files(&root), 5);

        assert!(entity.join("2000.webp").exists());
        assert!(entity.join("512.webp").exists());
        assert!(entity.join(".fetch-failed").exists());
        assert!(!entity.join("2000-fanart.webp").exists());
        assert!(!entity.join("512-fanart.webp").exists());
        assert!(!entity.join("2000-banner.webp").exists());
        assert!(!entity.join(".miss-fanart").exists());
        assert!(!entity.join(".miss-banner").exists());
        let _ = fs::remove_dir_all(&root);
    }

    fn test_ensure_args(tier: u32, surface_kind: Option<&str>) -> CoverCacheEnsureArgs {
        CoverCacheEnsureArgs {
            server_index_key: "srv".into(),
            cache_kind: "album".into(),
            cache_entity_id: "al-1".into(),
            cover_art_id: "al-1".into(),
            tier,
            rest_base_url: "http://x".into(),
            username: "u".into(),
            password: "p".into(),
            library_bulk: false,
            library_server_id: None,
            external_artwork_enabled: false,
            surface_kind: surface_kind.map(String::from),
            artist_name: None,
            album_title: None,
            external_artwork_byok: None,
        }
    }

    #[test]
    fn ensure_peek_fullres_requires_exact_tier() {
        let root = fresh_tmpdir("ensure-peek-fullres");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        // A smaller tier is on disk (from a grid/hero load) but the full-res tier
        // is not. A 2000 request must NOT accept the smaller fallback, or the
        // download is skipped and the 2000 tier is never built/cached.
        fs::write(tier_path(&dir, 512), b"x").unwrap();
        let args = test_ensure_args(2000, None);
        assert!(ensure_peek(&dir, 2000, &args).is_none());
        // Once the exact tier exists it is a hit.
        fs::write(tier_path(&dir, 2000), b"y").unwrap();
        assert_eq!(ensure_peek(&dir, 2000, &args), Some(tier_path(&dir, 2000)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn peek_plain_cover_fullres_is_exact_but_display_tiers_ladder() {
        let root = fresh_tmpdir("peek-plain-fullres");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        // Only a smaller tier on disk (grid/hero load). A full-res (2000) peek —
        // used by both ensure AND cover_cache_peek_batch — must NOT ladder down to
        // it, or the frontend grid seeder writes the 512 path under the 2000 key
        // and Hero/fullscreen surfaces show a downscaled image.
        fs::write(tier_path(&dir, 512), b"x").unwrap();
        assert!(peek_plain_cover_tier(&dir, 2000).is_none());
        // A display tier still ladders to a larger warmed tier.
        assert_eq!(peek_plain_cover_tier(&dir, 256), Some(tier_path(&dir, 512)));
        // Exact full-res is a hit.
        fs::write(tier_path(&dir, 2000), b"y").unwrap();
        assert_eq!(peek_plain_cover_tier(&dir, 2000), Some(tier_path(&dir, 2000)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_peek_display_tier_keeps_ladder_fallback() {
        let root = fresh_tmpdir("ensure-peek-ladder");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tier_path(&dir, 800), b"x").unwrap();
        // A 256 display request still accepts a larger warmed tier (grid behaviour
        // is unchanged — only the full-res tier is exact-only).
        assert_eq!(
            ensure_peek(&dir, 256, &test_ensure_args(256, None)),
            Some(tier_path(&dir, 800)),
        );
        let _ = fs::remove_dir_all(&root);
    }
}
