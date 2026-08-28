use super::cache_state::CoverCacheState;
use super::disk::{self, cover_dir, tier_exists, tier_path, tier_version, DERIVE_TIERS};
use super::dto::{CoverCacheEnsureArgs, CoverCacheEnsureResult};
use super::encode::write_webp_tier;
use super::fetch::build_cover_art_url;
use super::peek::{ensure_peek, peek_tier_path};
use super::{external_ensure, fetch, metrics};
use image::{DynamicImage, ImageReader};
use psysonic_library::cover_backfill::{cover_fetch_recently_failed, COVER_FETCH_FAIL_MARKER};
use psysonic_library::LibraryRuntime;
use reqwest::Client;
use std::collections::HashMap;
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

/// §5 full-res redirect for a chain-hit coverless album: a tier-≥2000 request
/// is served from the chain's on-disk ladder (best tier ≤ 800), never from the
/// network. The redirect serves the 800-and-below ladder even when a
/// chain-written `2000.webp` exists on disk, because it cannot distinguish it
/// from stale pre-fix vinyl without re-decoding (deliberate anti-vinyl
/// trade-off). Keyed off the `.album-ext-hit` marker alone — NOT `ext_gate_ok`,
/// which is false for the very requests (lightbox, fullscreen player) that
/// create the poison.
///
/// `Serve(path)` = serve this ladder path as the full-res result.
/// `Miss` = chain-hit full-res request with a wiped ladder: return a miss
/// without falling through to the exact-2000 peek (the 2000 file, when
/// present, can only be a stale vinyl placeholder — the chain never writes
/// 2000, and the vinyl guard forbids downloading a replacement).
/// `None` = no redirect (fall through to the normal path).
#[derive(Debug, PartialEq)]
pub(super) enum FullresRedirect {
    Serve(PathBuf),
    Miss,
    None,
}

pub(super) fn chain_hit_fullres_redirect(
    args: &CoverCacheEnsureArgs,
    dir: &Path,
) -> FullresRedirect {
    if args.library_bulk
        || args.surface_kind.is_some()
        || args.cache_kind != "album"
        || !args.cover_art_id.ends_with("_0")
        || args.tier < 2000
        || !external_ensure::album_ext_hit(dir)
    {
        return FullresRedirect::None;
    }
    match peek_tier_path(dir, 800) {
        Some(path) => FullresRedirect::Serve(path),
        None => FullresRedirect::Miss,
    }
}

fn cover_dir_for_args(root: &Path, args: &CoverCacheEnsureArgs) -> PathBuf {
    cover_dir(
        root,
        &args.server_index_key,
        &args.cache_kind,
        &args.cache_entity_id,
    )
}

/// Chain armed for a coverless album: not bulk, cache kind is album, and at
/// least one external album source is configured.
fn ext_album_chain_armed(args: &CoverCacheEnsureArgs) -> bool {
    !args.library_bulk
        && args.cache_kind == "album"
        && args
            .external_album_sources
            .as_ref()
            .is_some_and(|s| !s.is_empty())
}

/// One-flight-per-dir registry: every `ensure_inner` for the same cover dir
/// shares this mutex for its whole flight, so a quiet opts-less ensure
/// (library backfill, background hook) can never interleave its
/// check-then-write with an in-flight external chain. Entries are `Weak` and
/// evaporate once the last flight drops them, keeping the map bounded by the
/// number of dirs concurrently in flight.
///
/// The derive task inherits the parent's guard, so its writes cannot
/// interleave with the parent flight either. A flight already queued behind
/// the parent may still slip in before the derive's first lock acquisition,
/// but that is content-harmless: derive only runs on marker-absent dirs and
/// its writes are `tier_exists`-guarded, so the two writers produce the same
/// bytes.
fn inflight_dir_flight(
    map: &std::sync::Mutex<HashMap<PathBuf, std::sync::Weak<Mutex<()>>>>,
    dir: &Path,
) -> Arc<Mutex<()>> {
    let mut guard = map.lock().unwrap();
    // Drop dead entries first: a stale Weak would otherwise survive until the
    // next lookup for that dir (harmless, but the map would grow with every
    // album ever ensured).
    guard.retain(|_, weak| weak.strong_count() > 0);
    if let Some(existing) = guard.get(dir).and_then(std::sync::Weak::upgrade) {
        return existing;
    }
    let fresh = Arc::new(Mutex::new(()));
    guard.insert(dir.to_path_buf(), Arc::downgrade(&fresh));
    fresh
}

/// b1 vinyl-write guard outcome for a coverless album already resolved by the
/// external chain (`.album-ext-hit` marker present).
pub(super) enum VinylGuardDecision {
    /// Not protected: run the normal server-download path.
    Proceed,
    /// Protected with an intact ladder: serve this tier instead of writing.
    Serve(PathBuf),
    /// Protected with a wiped ladder: return a miss, write nothing.
    Miss,
}

/// b1 invariant: a marker-present coverless album must never get Navidrome
/// tiers written over its chain ladder. `Proceed` unless the dir carries the
/// `.album-ext-hit` marker; then the best existing tier is served, or a miss
/// is returned. Never deletes the marker and never re-runs the chain (hard
/// rule) — a wiped-tiers-but-marker dir is a pathological manual state and a
/// miss is safe.
pub(super) fn chain_ladder_vinyl_guard(
    args: &CoverCacheEnsureArgs,
    dir: &Path,
) -> VinylGuardDecision {
    let protected = args.cache_kind == "album"
        && args.cover_art_id.ends_with("_0")
        && external_ensure::album_ext_hit(dir);
    if !protected {
        return VinylGuardDecision::Proceed;
    }
    match peek_tier_path(dir, args.tier) {
        Some(path) => VinylGuardDecision::Serve(path),
        None => VinylGuardDecision::Miss,
    }
}

impl CoverCacheState {
    pub(crate) async fn ensure_inner(
        state: &Arc<Mutex<CoverCacheState>>,
        app: &AppHandle,
        args: &CoverCacheEnsureArgs,
        http_sem_override: Option<Arc<Semaphore>>,
    ) -> Result<CoverCacheEnsureResult, String> {
        super::ensure_migration_write_allowed(app)?;
        let (
            dir,
            client,
            _root,
            http_sem,
            cover_cpu_sem,
            fanart_sem,
            album_sem,
            musicbrainz_sem,
            auto_dl,
            flight,
        ) = {
            let this = state.lock().await;
            let dir = cover_dir_for_args(&this.root, args);
            // Cheap, no-IO gate. `pressure_from_bytes` is a constant stub
            // (`("ok".into(), true)` in cache_state) so `auto_dl` is always true
            // today. Kept as the pressure gate's call site so a real disk-pressure
            // implementation slots in without moving the check.
            let (_, auto_dl) = this.pressure_from_bytes(0);
            let client = this.client.clone();
            let root = this.root.clone();
            let http_sem = http_sem_override.unwrap_or_else(|| this.http_sem.clone());
            let cover_cpu_sem = this.cpu_sem_for(args.library_bulk);
            let fanart_sem = this.fanart_http_sem.clone();
            let album_sem = this.album_http_sem.clone();
            let musicbrainz_sem = this.musicbrainz_sem.clone();
            let flight = inflight_dir_flight(&this.inflight_dirs, &dir);
            (
                dir,
                client,
                root,
                http_sem,
                cover_cpu_sem,
                fanart_sem,
                album_sem,
                musicbrainz_sem,
                auto_dl,
                flight,
            )
        };

        // Phase B write-race fix: per-album flight serialization for the whole
        // flight, so the redirect/peek below sees the first flight's writes
        // (queued-flight-slip rationale: see `inflight_dir_flight`).
        let _flight_guard = flight.lock().await;

        // §5 full-res redirect: for a chain-hit coverless album a tier-≥2000
        // request is served from the chain's on-disk ladder — never the
        // exact-2000 peek (that file, when present, is a stale vinyl
        // placeholder: the chain never writes 2000) and never the network
        // (that download IS the placeholder, e.g. from the lightbox). No
        // `cover:tier-ready` here: this is a peek-like path, and re-emitting
        // from peeks re-arms the Gen-2 feedback loop. MUST stay before the
        // exact-2000 peek below (hard rule).
        match chain_hit_fullres_redirect(args, &dir) {
            FullresRedirect::Serve(path) => {
                return Ok(CoverCacheEnsureResult::hit_at(args.tier, &path));
            }
            // Marker present but the chain ladder is gone: serve a miss rather
            // than falling through to the exact-2000 peek (stale vinyl) or the
            // network (that download is the placeholder).
            FullresRedirect::Miss => {
                return Ok(CoverCacheEnsureResult::miss(args.tier));
            }
            FullresRedirect::None => {}
        }

        // §5 cover provider chain, coverless-album path. An album `cover_art_id`
        // ending in `_0` is Navidrome's "no cover" sentinel — the server has no
        // real art, and a placeholder `.webp` is often already on disk (written
        // by an earlier request). Without this guard both `ensure_peek` (below)
        // and `load_image_from_disk` would return that placeholder as a hit and
        // silently bypass the external chain. So when the chain is armed AND the
        // album is coverless, skip the cached-placeholder peek and let the
        // external chain run first (below). OFF during `library_bulk`.
        let ext_gate_ok = ext_album_chain_armed(args);
        let album_is_coverless =
            args.cache_kind == "album" && args.cover_art_id.ends_with("_0");
        let album_already_hit =
            args.cache_kind == "album" && external_ensure::album_ext_hit(&dir);

        if !(ext_gate_ok && album_is_coverless && !album_already_hit) {
            if let Some(path) = ensure_peek(&dir, args.tier, args) {
                return Ok(CoverCacheEnsureResult::hit_at(args.tier, &path));
            }
        }

        if !auto_dl && args.tier != 2000 {
            return Ok(CoverCacheEnsureResult::miss(args.tier));
        }

        if cover_fetch_recently_failed(&dir) {
            return Ok(CoverCacheEnsureResult::miss(args.tier));
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
                    Some(path) => CoverCacheEnsureResult::hit_at(args.tier, &path),
                    None => CoverCacheEnsureResult::miss(args.tier),
                });
            }
        }

        // §5 cover provider chain run for a coverless album: a placeholder is on
        // disk, but the peek above was skipped — ask apple/lastfm now. A hit
        // writes real art and wins; a definitive miss records `.miss-album-ext`
        // (30 min) and falls through to the cached placeholder below.
        if ext_gate_ok && album_is_coverless && !album_already_hit {
            if let Some(path) = external_ensure::try_external_album_cover(
                args,
                &dir,
                &client,
                &album_sem,
                args.tier,
            )
            .await
            {
                // Wake the webview the same way a normal cover write does: emit
                // `cover:tier-ready` so `rememberDiskSrcLadder` seeds every display
                // tier of THIS album and bumps the disk-src generation. Non-chain
                // surfaces (album "More by" rows, grids) that peeked before the art
                // landed stay on a placeholder unless woken — the plain `{tier}.webp`
                // path is keyed to the album ref, so nothing leaks into the artist
                // cover (unlike the fanart `{tier}-{surface}.webp` case).
                emit_tier_ready(app, args, args.tier, &path);
                return Ok(CoverCacheEnsureResult::hit_at(args.tier, &path));
            }
        }

        // Coverless-album policy: a chain HIT above wrote the full real-art
        // ladder, overwriting any placeholder at every display tier. A chain
        // MISS deliberately falls through to the server download below — that
        // download is Navidrome's vinyl placeholder, and it is the correct
        // "no art" state when the providers have nothing better, so it is
        // cached and shown rather than blanked.
        // b1 invariant (Phase B write-race fix): a marker-present coverless
        // album must never get Navidrome tiers written over its chain ladder —
        // see `chain_ladder_vinyl_guard` (the miss also keeps vinyl out of the
        // `load_image_from_disk` derive source used below).
        match chain_ladder_vinyl_guard(args, &dir) {
            VinylGuardDecision::Proceed => {}
            VinylGuardDecision::Serve(path) => {
                return Ok(CoverCacheEnsureResult::hit_at(args.tier, &path));
            }
            VinylGuardDecision::Miss => {
                return Ok(CoverCacheEnsureResult::miss(args.tier));
            }
        }

        let requested = args.tier;
        let quiet = args.library_bulk;
        let tiers_now: Vec<u32> = if !args.library_bulk && requested == 2000 {
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
            match download_cover_payload(&client, &http_sem, args, http_registry).await {
                Ok(bytes) => CoverSource::Bytes(bytes),
                Err(err) => {
                    super::ensure_migration_write_allowed(app)?;
                    log_cover_fetch_failure(app, args, &err);
                    // Album external fallback (§5): the server had no art but an
                    // external album chain is armed — try apple/lastfm before
                    // recording a miss (OFF during library_bulk).
                    if ext_album_chain_armed(args) {
                        if let Some(path) = external_ensure::try_external_album_cover(
                            args,
                            &dir,
                            &client,
                            &album_sem,
                            args.tier,
                        )
                        .await
                        {
                            return Ok(CoverCacheEnsureResult::hit_at(args.tier, &path));
                        }
                    }
                    // Marker-vs-poison rule: only write the fail marker when the
                    // chain was actually consulted. A browse thumb (grid/table/
                    // disc header) that can't use the chain must NOT poison the
                    // dir, or it would suppress the album-page chain later.
                    // Non-album kinds keep the previous behavior.
                    let write_marker = args.cache_kind != "album" || ext_album_chain_armed(args);
                    if write_marker {
                        let _ = std::fs::create_dir_all(&dir);
                        let _ = std::fs::write(dir.join(COVER_FETCH_FAIL_MARKER), b"1");
                    }
                    return Ok(CoverCacheEnsureResult::miss(args.tier));
                }
            }
        };

        super::ensure_migration_write_allowed(app)?;

        let dir_bg = dir.clone();
        let tiers_bg = tiers_now.clone();
        let cpu_permit = cover_cpu_sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        super::ensure_migration_write_allowed(app)?;
        let (wrote_requested, fresh_tiers, derive_source) =
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

        let out_path = tier_path(&dir, requested);
        if wrote_requested || out_path.is_file() {
            metrics::note_ui_cover_produced(args);
            if !quiet {
                if let Some(img) = derive_source {
                    spawn_derive_remaining_tiers(
                        app.clone(),
                        state.clone(),
                        args.clone(),
                        img,
                        requested,
                        flight.clone(),
                    );
                }
            }
            return Ok(CoverCacheEnsureResult::hit_at(requested, &out_path));
        }

        Ok(CoverCacheEnsureResult::miss(requested))
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
            "pathVersion": tier_version(path),
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
    .and_then(|bytes| {
        // A 200 with an EMPTY body is Navidrome's "no artwork for this entity"
        // signal (it does not 404 or return a payload image). Treat it as a
        // permanent miss so the album external fallback (and the plain
        // .fetch-failed marker for artists) can run instead of the caller
        // trying to decode zero bytes.
        if bytes.is_empty() {
            return Err("cover body empty (no artwork on server)".to_string());
        }
        Ok(bytes)
    })
}

fn spawn_derive_remaining_tiers(
    app: AppHandle,
    state: Arc<Mutex<CoverCacheState>>,
    args: CoverCacheEnsureArgs,
    img: DynamicImage,
    requested: u32,
    // The parent flight's per-dir guard, held until this task's writes land —
    // prevents interleaving with the parent flight (see `inflight_dir_flight`).
    flight: Arc<Mutex<()>>,
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
        // Hold the per-dir guard until these derive writes land; the parent
        // dropped its own when ensure_inner returned, so without this a
        // second ensure would slip into that gap (see `inflight_dir_flight`).
        let _derive_guard = flight.lock().await;
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
        if super::ensure_migration_write_allowed(&app).is_err() {
            return;
        }
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
    use super::{
        chain_hit_fullres_redirect, chain_ladder_vinyl_guard, decode_image_bytes,
        inflight_dir_flight, FullresRedirect, VinylGuardDecision,
    };
    use crate::cover_cache::disk::tier_path;
    use crate::cover_cache::test_support::fresh_tmpdir;
    use crate::cover_cache::{CoverCacheEnsureArgs, CoverCacheEnsureResult};
    use image::{ImageBuffer, ImageFormat, Rgba};
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::sync::{Arc, Weak};
    use std::{fs, path::PathBuf};
    use tokio::sync::Mutex;

    fn fullres_args(cover_art_id: &str, tier: u32, library_bulk: bool) -> CoverCacheEnsureArgs {
        CoverCacheEnsureArgs {
            server_index_key: "srv".into(),
            cache_kind: "album".into(),
            cache_entity_id: "al-1".into(),
            cover_art_id: cover_art_id.into(),
            tier,
            rest_base_url: "http://x".into(),
            username: "u".into(),
            password: "p".into(),
            library_bulk,
            library_server_id: None,
            external_artwork_enabled: false,
            surface_kind: None,
            artist_name: None,
            album_title: None,
            external_artwork_byok: None,
            external_album_sources: None,
        }
    }

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

    /// Wire-version stamping: a hit on a real file carries its mtime, a miss
    /// carries 0 — the webview's `?v=` cache-bust depends on this.
    #[test]
    fn ensure_result_stamps_path_version() {
        let root = fresh_tmpdir("ensure-result-version");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        let p = tier_path(&dir, 800);
        fs::write(&p, b"art").unwrap();

        let hit = CoverCacheEnsureResult::hit_at(800, &p);
        assert!(hit.hit);
        assert!(hit.path_version > 0, "real file must stamp its mtime");

        let miss = CoverCacheEnsureResult::miss(800);
        assert!(!miss.hit);
        assert_eq!(miss.path_version, 0);
        assert!(miss.path.is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    /// Chain-hit coverless album + tier 2000 + a real-art ladder on disk → the
    /// redirect serves the chain's 800 (even when a stale vinyl `2000.webp`
    /// exists — that file must never win the full-res slot).
    #[test]
    fn fullres_redirect_serves_chain_ladder_not_stale_2000() {
        let root = fresh_tmpdir("fullres-redirect-ladder");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tier_path(&dir, 800), b"real-art-800").unwrap();
        // Stale poison: vinyl placeholder written by an old lightbox open.
        fs::write(tier_path(&dir, 2000), b"vinyl-placeholder").unwrap();
        fs::write(dir.join(".album-ext-hit"), b"1").unwrap();

        let got = chain_hit_fullres_redirect(&fullres_args("al-1_0", 2000, false), &dir);
        assert_eq!(got, FullresRedirect::Serve(tier_path(&dir, 800)));

        let _ = fs::remove_dir_all(&root);
    }

    /// No `.album-ext-hit` marker (chain never ran / missed) → no redirect;
    /// the normal path (MISS → vinyl per the `0c2565e` product decision) applies.
    #[test]
    fn fullres_redirect_requires_hit_marker() {
        let root = fresh_tmpdir("fullres-redirect-no-marker");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tier_path(&dir, 800), b"real-art-800").unwrap();

        assert!(matches!(
            chain_hit_fullres_redirect(&fullres_args("al-1_0", 2000, false), &dir),
            FullresRedirect::None
        ));

        let _ = fs::remove_dir_all(&root);
    }

    /// Display tiers and non-coverless albums never take the redirect — a
    /// non-`_0` album's real `2000.webp` is genuine full-res from Navidrome.
    #[test]
    fn fullres_redirect_skips_display_tiers_and_non_coverless() {
        let root = fresh_tmpdir("fullres-redirect-scope");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tier_path(&dir, 800), b"real-art-800").unwrap();
        fs::write(tier_path(&dir, 2000), b"full").unwrap();
        fs::write(dir.join(".album-ext-hit"), b"1").unwrap();

        // Display tier: no redirect.
        assert!(matches!(
            chain_hit_fullres_redirect(&fullres_args("al-1_0", 800, false), &dir),
            FullresRedirect::None
        ));
        // Non-coverless album: no redirect (2000 is genuine server art).
        assert!(matches!(
            chain_hit_fullres_redirect(&fullres_args("al-1", 2000, false), &dir),
            FullresRedirect::None
        ));
        // Library bulk: no redirect.
        assert!(matches!(
            chain_hit_fullres_redirect(&fullres_args("al-1_0", 2000, true), &dir),
            FullresRedirect::None
        ));
        // External artist surface: no redirect.
        let mut surface_args = fullres_args("al-1_0", 2000, false);
        surface_args.surface_kind = Some("fanart".into());
        assert!(matches!(
            chain_hit_fullres_redirect(&surface_args, &dir),
            FullresRedirect::None
        ));

        let _ = fs::remove_dir_all(&root);
    }

    /// Chain hit + tier 2000 + ladder wiped (only a stale vinyl `2000.webp`
    /// left) → Miss, never the stale placeholder. The chain never writes
    /// 2000, so that file can only be pre-fix vinyl cruft.
    #[test]
    fn fullres_redirect_misses_when_ladder_wiped() {
        let root = fresh_tmpdir("fullres-redirect-wiped");
        let dir: PathBuf = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tier_path(&dir, 2000), b"vinyl-placeholder").unwrap();
        fs::write(dir.join(".album-ext-hit"), b"1").unwrap();

        assert!(matches!(
            chain_hit_fullres_redirect(&fullres_args("al-1_0", 2000, false), &dir),
            FullresRedirect::Miss
        ));

        let _ = fs::remove_dir_all(&root);
    }

    /// Fix A: two lookups for the same dir share one live flight Arc.
    #[test]
    fn inflight_dir_flight_dedupes_same_dir() {
        let map: std::sync::Mutex<HashMap<PathBuf, Weak<Mutex<()>>>> =
            std::sync::Mutex::new(HashMap::new());
        let dir = PathBuf::from("album/al-1");
        let first = inflight_dir_flight(&map, &dir);
        let second = inflight_dir_flight(&map, &dir);
        assert!(Arc::ptr_eq(&first, &second));
    }

    /// Fix A: different dirs get different flights (parallelism across albums
    /// is unaffected by the serialization).
    #[test]
    fn inflight_dir_flight_separates_dirs() {
        let map: std::sync::Mutex<HashMap<PathBuf, Weak<Mutex<()>>>> =
            std::sync::Mutex::new(HashMap::new());
        let a = inflight_dir_flight(&map, &PathBuf::from("album/al-1"));
        let b = inflight_dir_flight(&map, &PathBuf::from("album/al-2"));
        assert!(!Arc::ptr_eq(&a, &b));
    }

    /// Fix A: once the last holder drops, the registry entry evaporates — the
    /// Weak no longer upgrades and the next lookup mints a fresh flight.
    #[test]
    fn inflight_dir_flight_entry_evaporates() {
        let map: std::sync::Mutex<HashMap<PathBuf, Weak<Mutex<()>>>> =
            std::sync::Mutex::new(HashMap::new());
        let dir = PathBuf::from("album/al-1");
        let flight = inflight_dir_flight(&map, &dir);
        {
            let guard = map.lock().unwrap();
            let weak = guard.get(&dir).expect("entry registered");
            assert!(weak.upgrade().is_some(), "live while a flight holds the Arc");
        }
        drop(flight);
        {
            let guard = map.lock().unwrap();
            let weak = guard.get(&dir).expect("entry survives until next lookup");
            assert!(weak.upgrade().is_none(), "dead once the last holder drops");
        }
        let _fresh = inflight_dir_flight(&map, &dir);
        {
            let guard = map.lock().unwrap();
            let weak = guard.get(&dir).expect("fresh entry registered");
            assert!(weak.upgrade().is_some());
        }
    }

    /// Fix B: marker-present coverless album with a real-art ladder → the guard
    /// serves the best existing tier instead of falling into the download path.
    #[test]
    fn vinyl_guard_serves_ladder_when_marker_present() {
        let root = fresh_tmpdir("vinyl-guard-serve");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tier_path(&dir, 800), b"real-art-800").unwrap();
        fs::write(dir.join(".album-ext-hit"), b"1").unwrap();

        assert!(matches!(
            chain_ladder_vinyl_guard(&fullres_args("al-1_0", 400, false), &dir),
            VinylGuardDecision::Serve(path) if path == tier_path(&dir, 800)
        ));

        let _ = fs::remove_dir_all(&root);
    }

    /// Fix B: marker present but the ladder was wiped → a miss, never a vinyl
    /// download (the pathological manual state the Phase B retest heals).
    #[test]
    fn vinyl_guard_misses_when_ladder_wiped() {
        let root = fresh_tmpdir("vinyl-guard-miss");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".album-ext-hit"), b"1").unwrap();

        assert!(matches!(
            chain_ladder_vinyl_guard(&fullres_args("al-1_0", 400, false), &dir),
            VinylGuardDecision::Miss
        ));

        let _ = fs::remove_dir_all(&root);
    }

    /// Fix B: the guard only protects marker-present coverless ALBUMS — other
    /// kinds and non-coverless ids take the normal path, while library_bulk is
    /// still protected (the backfill worker is the observed quiet writer).
    #[test]
    fn vinyl_guard_scopes_to_marker_present_coverless_albums() {
        let root = fresh_tmpdir("vinyl-guard-scope");
        let dir = root.join("album").join("al-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tier_path(&dir, 800), b"real-art-800").unwrap();
        fs::write(dir.join(".album-ext-hit"), b"1").unwrap();

        // No marker → Proceed.
        let nomark = root.join("album").join("al-2");
        fs::create_dir_all(&nomark).unwrap();
        fs::write(tier_path(&nomark, 800), b"x").unwrap();
        assert!(matches!(
            chain_ladder_vinyl_guard(&fullres_args("al-2_0", 400, false), &nomark),
            VinylGuardDecision::Proceed
        ));

        // Non-coverless id with a marker → Proceed (a `_1` 800 is genuine server art).
        assert!(matches!(
            chain_ladder_vinyl_guard(&fullres_args("al-1", 400, false), &dir),
            VinylGuardDecision::Proceed
        ));

        // Artist kind with a marker → Proceed.
        let mut artist_args = fullres_args("al-1_0", 400, false);
        artist_args.cache_kind = "artist".into();
        assert!(matches!(
            chain_ladder_vinyl_guard(&artist_args, &dir),
            VinylGuardDecision::Proceed
        ));

        // library_bulk is still guarded (backfill must not write vinyl over a
        // chain-hit album).
        assert!(matches!(
            chain_ladder_vinyl_guard(&fullres_args("al-1_0", 800, true), &dir),
            VinylGuardDecision::Serve(path) if path == tier_path(&dir, 800)
        ));

        let _ = fs::remove_dir_all(&root);
    }
}
