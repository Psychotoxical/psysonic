//! External artist-artwork ensure path (image-scraper). Split out of `mod.rs`
//! to keep the cover-cache orchestrator navigable: the on-demand fanart/banner
//! fetch (fanart.tv via MBID resolution), the §11 quality gate, the
//! surface-aware peek, and the §12 lookup-table cache. Everything here is gated
//! by `ensure_inner` (feature flag, `!library_bulk`, artist kind) — see the call
//! site in `mod.rs`. Pure code move; behaviour unchanged.

use super::encode::write_webp_tier;
use super::{decode_image_bytes, disk, external, fetch, peek_fallback_tiers, peek_tier_path};
use super::CoverCacheEnsureArgs;
use psysonic_integration::discord::ArtworkCacheEntry;
use psysonic_library::LibraryRuntime;
use reqwest::Client;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

/// Spike negative-cache marker — "this artist has no fanart", mirrors the
/// §11 quality gate for the fanart (16:9) surface: an existing on-disk image
/// pre-empts an external fetch only when it is wide enough AND roughly 16:9.
/// Square Navidrome artist portraits never satisfy it.
const FANART_MIN_WIDTH: u32 = 1280;
const FANART_ASPECT_MIN: f32 = 1.6;
const FANART_ASPECT_MAX: f32 = 2.0;

/// The external-artwork surfaces fanart.tv serves for an artist. Returns the
/// surface name — also the on-disk file suffix (`{tier}-{surface}.webp`) and the
/// lookup `surface_kind` — when the requested surface is external, else `None`.
pub(super) fn external_surface(surface_kind: Option<&str>) -> Option<&str> {
    match surface_kind {
        Some("fanart") => Some("fanart"),
        Some("banner") => Some("banner"),
        _ => None,
    }
}

/// Like [`peek_tier_path`] but, for an external surface (`fanart`/`banner`),
/// serves only the matching `{tier}-{surface}.webp` tiers. If none exist yet it
/// returns None so ensure runs the external branch (fetch; Navidrome is the
/// fallback inside that branch's miss path) instead of short-circuiting on a
/// cached Navidrome tier (§18, "external prioritised").
pub(super) fn peek_cover_path(dir: &Path, want: u32, args: &CoverCacheEnsureArgs) -> Option<PathBuf> {
    if let Some(surface) = external_surface(args.surface_kind.as_deref()) {
        if let Some(p) = disk::provider_tier_exists(dir, want, surface) {
            return Some(p);
        }
        for &tier in peek_fallback_tiers(want) {
            if let Some(p) = disk::provider_tier_exists(dir, tier, surface) {
                return Some(p);
            }
        }
        return None;
    }
    peek_tier_path(dir, want)
}

fn marker_recent(path: &Path, max_age: Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| t.elapsed().map(|e| e < max_age).unwrap_or(true))
        .unwrap_or(false)
}

fn write_marker(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, b"1");
}

/// Permanent "external chain already found real art for this album" sentinel.
/// Written on a HIT so the coverless-album path (which runs the provider chain
/// before trusting a cached placeholder) stops re-querying apple/lastfm on every
/// re-ensure once real art is on disk — the normal peek then finds it. Unlike
/// `.miss-album-ext` (30-min cooldown), a HIT is never re-checked: the album now
/// has art, so the chain has nothing more to do until the cache is cleared.
const ALBUM_EXT_HIT_MARKER: &str = ".album-ext-hit";

/// True when this album has already been resolved by the external chain (HIT).
pub(super) fn album_ext_hit(dir: &Path) -> bool {
    dir.join(ALBUM_EXT_HIT_MARKER).is_file()
}

/// §11: do these pixel dimensions satisfy the fanart (16:9) surface?
fn dims_satisfy_fanart(w: u32, h: u32) -> bool {
    if w < FANART_MIN_WIDTH || h == 0 {
        return false;
    }
    let aspect = w as f32 / h as f32;
    (FANART_ASPECT_MIN..=FANART_ASPECT_MAX).contains(&aspect)
}

/// §11 quality gate: true when a Navidrome tier already on disk is an HQ ~16:9
/// image (so the external fetch can be skipped). Reads dimensions only — no
/// full decode. Square artist portraits fail and external proceeds.
fn navidrome_tier_is_hq_fanart(dir: &Path) -> bool {
    for &tier in &[2000u32, 800, 512, 256, 128] {
        let p = disk::tier_path(dir, tier);
        if p.is_file() {
            if let Ok((w, h)) = image::image_dimensions(&p) {
                if dims_satisfy_fanart(w, h) {
                    return true;
                }
            }
        }
    }
    false
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Read the cached `artist_artwork_lookup` row for a surface off the async
/// executor (§12).
async fn read_artist_lookup(
    store: &Option<Arc<psysonic_library::store::LibraryStore>>,
    server_id: &str,
    artist_id: &str,
    surface: &str,
) -> Option<psysonic_library::artist_artwork::ArtistArtworkRow> {
    let store = store.clone()?;
    let (server_id, artist_id, surface) =
        (server_id.to_string(), artist_id.to_string(), surface.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        psysonic_library::artist_artwork::get_artist_artwork(&store, &server_id, &artist_id, &surface)
            .ok()
            .flatten()
    })
    .await
    .ok()
    .flatten()
}

/// Upsert an `artist_artwork_lookup` row off the async executor (§12). No-op
/// when the library store is absent (e.g. before login).
#[allow(clippy::too_many_arguments)]
async fn persist_artist_lookup(
    store: &Option<Arc<psysonic_library::store::LibraryStore>>,
    server_id: &str,
    artist_id: &str,
    surface: &str,
    status: &str,
    mbid: Option<&str>,
    mbid_source: Option<&str>,
    provider: Option<&str>,
    now: i64,
) {
    let Some(store) = store.clone() else {
        return;
    };
    let (server_id, artist_id, surface, status) = (
        server_id.to_string(),
        artist_id.to_string(),
        surface.to_string(),
        status.to_string(),
    );
    let (mbid, mbid_source, provider) = (
        mbid.map(String::from),
        mbid_source.map(String::from),
        provider.map(String::from),
    );
    let _ = tauri::async_runtime::spawn_blocking(move || {
        psysonic_library::artist_artwork::upsert_artist_artwork(
            &store,
            &server_id,
            &artist_id,
            &surface,
            mbid.as_deref(),
            mbid_source.as_deref(),
            &status,
            provider.as_deref(),
            now,
        )
    })
    .await;
}

/// Try to satisfy an external artist `surface` (`fanart` 16:9 background or
/// `banner` strip) from fanart.tv. Writes `{2000,512}-{surface}.webp` into the
/// entity dir and returns the requested-tier path on success. `None` = "no
/// image, fall through to Navidrome" — never writes a `.fetch-failed` marker
/// (§28).
///
/// MBID resolution stays Rust-side (§23): the tag MBID via `getArtistInfo2`,
/// else a name→MusicBrainz album-confirmed lookup (§19), cached per surface in
/// `artist_artwork_lookup` (§12). The §11 quality gate runs first for the
/// `fanart` surface only.
#[allow(clippy::too_many_arguments)]
pub(super) async fn try_external_fanart(
    app: &AppHandle,
    args: &CoverCacheEnsureArgs,
    dir: &Path,
    client: &Client,
    fanart_sem: &Arc<Semaphore>,
    musicbrainz_sem: &Arc<Semaphore>,
    requested: u32,
    surface: &str,
) -> Option<PathBuf> {
    // Project key: a runtime env var (dev convenience) wins, else the embedded
    // `FANART_PROJECT_KEY` committed in the source — so the feature works in every
    // build (CI, local, AUR, Nix, from-source), not just ones built with a secret.
    // The BYOK personal key is optional and sent in addition (§22).
    let api_key = std::env::var("PSYSONIC_FANART_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .unwrap_or_else(|| external::FANART_PROJECT_KEY.to_string());
    // BYOK personal key (§22): the settings field wins, else the dev env var.
    let byok = args
        .external_artwork_byok
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("PSYSONIC_FANART_CLIENT_KEY").ok())
        .filter(|k| !k.is_empty());

    // §11 quality gate applies to the 16:9 `fanart` surface only — if Navidrome
    // already serves an HQ ~16:9 image, skip the external fetch. The `banner`
    // strip has its own aspect and is never pre-empted by a Navidrome tier.
    if surface == "fanart" && navidrome_tier_is_hq_fanart(dir) {
        return None;
    }

    // §12: the lookup table is both the MBID resolution cache and the negative
    // cache. Absent before login → all reads/writes become no-ops.
    let store: Option<Arc<psysonic_library::store::LibraryStore>> =
        app.try_state::<LibraryRuntime>().map(|rt| rt.store.clone());
    let server_id = &args.server_index_key;
    let artist_id = &args.cache_entity_id;
    let now = now_unix_ms();

    let cached = read_artist_lookup(&store, server_id, artist_id, surface).await;
    if let Some(row) = &cached {
        // Back off: no/ambiguous MBID for 24h; a confirmed "no fanart" miss for
        // 30 min (also held by the `.miss-fanart` marker).
        let within = |window: Duration| now - row.updated_at < window.as_millis() as i64;
        match row.status.as_str() {
            "no_mbid" | "mbid_ambiguous" if within(Duration::from_secs(24 * 60 * 60)) => {
                return None;
            }
            "miss" if within(Duration::from_secs(30 * 60)) => return None,
            _ => {}
        }
    }

    let miss_marker = dir.join(format!(".miss-{surface}"));
    if marker_recent(&miss_marker, Duration::from_secs(30 * 60)) {
        return None;
    }

    let _permit = fanart_sem.clone().acquire_owned().await.ok()?;
    super::ensure_migration_write_allowed(app).ok()?;

    let http_registry = app
        .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));

    // §23: resolve the tag MBID Rust-side via getArtistInfo2 — unless the cache
    // already carries one (skip the Navidrome round-trip).
    let (mbid, mbid_source) = match cached.as_ref().and_then(|r| r.mbid.clone()) {
        Some(m) => (m, cached.as_ref().and_then(|r| r.mbid_source.clone())),
        None => match external::fetch_artist_tag_mbid(
            client,
            http_registry.as_deref(),
            Some(server_id),
            &args.rest_base_url,
            &args.username,
            &args.password,
            &args.cache_entity_id,
        )
        .await
        {
            Ok(Some(m)) => (m, Some("tag".to_string())),
            Ok(None) => {
                // No tag MBID. §19: try a name→MusicBrainz album-confirmed lookup
                // when both the artist name and an album are in context.
                match (args.artist_name.as_deref(), args.album_title.as_deref()) {
                    (Some(name), Some(album))
                        if !name.trim().is_empty() && !album.trim().is_empty() =>
                    {
                        // ≤1 req/s: hold the single MB permit across the request
                        // plus a ≥1s spacing so concurrent ensures can't burst MB.
                        let _mb = musicbrainz_sem.clone().acquire_owned().await.ok()?;
                        super::ensure_migration_write_allowed(app).ok()?;
                        let resolved =
                            external::resolve_mbid_via_musicbrainz(client, name, album).await;
                        tokio::time::sleep(Duration::from_millis(1100)).await;
                        drop(_mb);
                        match resolved {
                            Ok(external::MbResolution::Found(m)) => {
                                (m, Some("musicbrainz".to_string()))
                            }
                            Ok(external::MbResolution::Ambiguous) => {
                                persist_artist_lookup(
                                    &store, server_id, artist_id, surface, "mbid_ambiguous", None,
                                    None, None, now,
                                )
                                .await;
                                return None;
                            }
                            Ok(external::MbResolution::None) => {
                                persist_artist_lookup(
                                    &store, server_id, artist_id, surface, "no_mbid", None, None,
                                    None, now,
                                )
                                .await;
                                return None;
                            }
                            Err(e) => {
                                eprintln!("[fanart] musicbrainz failed: {e}"); // transient
                                return None;
                            }
                        }
                    }
                    _ => {
                        // No album context → we could not even *attempt* name→MB.
                        // Do NOT cache `no_mbid`: a later ensure that arrives with
                        // album context (e.g. once the artist's album list loads)
                        // would otherwise be blocked by the 24h backoff.
                        return None;
                    }
                }
            }
            Err(e) => {
                eprintln!("[fanart] getArtistInfo2 failed: {e}"); // transient — don't cache
                return None;
            }
        },
    };

    let img_url = match external::fetch_fanart_image_url(
        client,
        &mbid,
        &api_key,
        byok.as_deref(),
        surface,
    )
    .await
    {
        Ok(Some(u)) => u,
        Ok(None) => {
            write_marker(&miss_marker); // artist has no image of this kind
            persist_artist_lookup(
                &store,
                server_id,
                artist_id,
                surface,
                "miss",
                Some(&mbid),
                mbid_source.as_deref(),
                None,
                now,
            )
            .await;
            return None;
        }
        Err(e) => {
            eprintln!("[fanart] lookup failed: {e}"); // transient — don't cache
            return None;
        }
    };

    let bytes = match fetch::fetch_cover_bytes(client, &img_url, None, None).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[fanart] download failed: {e}"); // transient — don't cache
            return None;
        }
    };

    super::ensure_migration_write_allowed(app).ok()?;

    // Decode + write {2000,512}-{surface}.webp (matryoshka §17).
    let dir_owned = dir.to_path_buf();
    let surface_owned = surface.to_string();
    let encoded = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let img = decode_image_bytes(&bytes)?;
        std::fs::create_dir_all(&dir_owned).map_err(|e| e.to_string())?;
        for tier in [2000u32, 512u32] {
            write_webp_tier(&img, tier, &disk::provider_tier_path(&dir_owned, tier, &surface_owned))?;
        }
        Ok(())
    })
    .await;
    if !matches!(encoded, Ok(Ok(()))) {
        eprintln!("[fanart] encode failed: {encoded:?}");
        return None;
    }

    persist_artist_lookup(
        &store,
        server_id,
        artist_id,
        surface,
        "hit",
        Some(&mbid),
        mbid_source.as_deref(),
        Some("fanart"),
        now,
    )
    .await;

    // NOTE: do NOT emit `cover:tier-ready` here. That event is keyed by the
    // canonical cover key (cacheKind/cacheEntityId/tier, no surface), so emitting
    // it with the `{tier}-{surface}.webp` path would seed the frontend disk-src
    // cache for the *Navidrome* artist cover with the external image — leaking
    // fanart/banner into the plain artist cover (avatar, FS "navidrome-artist"
    // fallback) even with the scraper off. The external hooks read the path from
    // this function's return value, so no event is needed.
    Some(disk::provider_tier_path(dir, requested, surface))
}

/// Try an external album cover for a server that returned no art. Walks the
/// ordered `external_album_sources` chain (apple → lastfm), takes the first
/// provider that yields a real image URL, fetches it, and writes the deduped
/// `{requested,800}.webp` tiers under the PLAIN tier names (Task 5.2 fallback
/// surface wiring) so the normal `ensure_peek` finds them on later ensures —
/// the album ensure carries `surface_kind: None`, so a `-album.webp` suffix
/// would be invisible to the peek. Returns the requested-tier path on success.
///
/// `None` = "no image — record the miss". Never writes the `COVER_FETCH_FAIL_MARKER`
/// (the orchestrator's miss branch does that on the fall-through); the negative
/// cache here is the `.miss-album-ext` marker (30 min), written only for a
/// definitive provider miss (404 / `error:6`), never for a transient error.
///
/// Gated by `args.external_album_sources` non-empty (NOT `external_artwork_enabled`,
/// which is the fanart master toggle) and `!library_bulk` (off during backfill).
#[allow(clippy::too_many_arguments)]
pub(super) async fn try_external_album_cover(
    args: &CoverCacheEnsureArgs,
    dir: &Path,
    client: &Client,
    sem: &Arc<Semaphore>,
    requested: u32,
) -> Option<PathBuf> {
    // None = feature off; empty array = no enabled sources.
    let sources = args.external_album_sources.as_deref()?;
    if sources.is_empty() {
        return None;
    }
    let artist = args.artist_name.as_deref()?;
    let album = args.album_title.as_deref()?;

    let miss_marker = dir.join(".miss-album-ext");
    if marker_recent(&miss_marker, Duration::from_secs(30 * 60)) {
        return None;
    }
    // `sem` is the shared album_http_sem — a low-concurrency gate so the external
    // fallback can never starve Navidrome cover / getArtistInfo2 fetches (§26).
    let _permit = sem.clone().acquire_owned().await.ok()?;

    let mut img_url: Option<String> = None;
    let mut had_definitive_miss = false;
    for source in sources {
        let outcome = match source.as_str() {
            "lastfm" => psysonic_integration::album_art::fetch_lastfm_album_image(
                client,
                &psysonic_integration::album_art::lastfm_api_key(),
                artist,
                album,
            )
            .await,
            "apple" => {
                // iTunes is blocking + lives in psysonic-integration; bridge via
                // spawn_blocking so the existing fuzzy 3-strategy matching + the
                // 100→600px upscale are reused rather than re-implemented.
                // Build the blocking client INSIDE the closure so its internal
                // tokio runtime is created, used, and dropped entirely on the
                // blocking pool. Building it in the async context panics Tokio:
                // "Cannot drop a runtime in a context where blocking is not
                // allowed."
                async {
                    let artist = artist.to_string();
                    let album = album.to_string();
                    // Fresh per-call cache is harmless: the file write + negative
                    // marker below already de-dupe across ensures.
                    let cache: Mutex<HashMap<String, ArtworkCacheEntry>> =
                        Mutex::new(HashMap::new());
                    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
                        let blocking_client = reqwest::blocking::Client::builder()
                            .timeout(Duration::from_secs(5))
                            .build()
                            .map_err(|e| e.to_string())?;
                        Ok(psysonic_integration::discord::search_itunes_artwork(
                            &blocking_client,
                            &cache,
                            &artist,
                            &album,
                            &album,
                        ))
                    })
                    .await
                    .map_err(|e| e.to_string())?
                }
                .await
            }
            _ => continue,
        };
        match outcome {
            Ok(Some(u)) => {
                img_url = Some(u);
                break;
            }
            Ok(None) => {
                had_definitive_miss = true;
            }
            Err(_e) => {} // transient, don't cache
        }
    }

    let url = match img_url {
        Some(u) => u,
        None => {
            // Negative-cache only definitive misses; a pure transient error
            // (429 / network) must not poison the chain for 30 min.
            if had_definitive_miss {
                write_marker(&miss_marker);
            }
            return None;
        }
    };

    let bytes = match fetch::fetch_cover_bytes(client, &url, None, None).await {
        Ok(b) => b,
        Err(_e) => return None,
    };

    let dir_owned = dir.to_path_buf();
    let encoded = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let img = decode_image_bytes(&bytes)?;
        std::fs::create_dir_all(&dir_owned).map_err(|e| e.to_string())?;
        // Album covers are square: write the deduped {requested, 800} tiers under
        // the plain tier names (fallback surface wiring) so `ensure_peek` finds
        // them on later ensures. Do NOT write the fanart {2000,512} pair.
        // Overwrite EVERY display tier so any non-chain surface (grid, row,
        // "More by" card) finds real art via its exact-tier peek. A stale
        // placeholder at a lower tier (e.g. a leftover 128.webp) would otherwise
        // win, because `peek_tier_path` checks the exact tier before the ladder.
        // Mirrors the normal cover path, which derives the whole ladder from one
        // source image. `requested` may be 2000 (hero full-res) and is kept too.
        let mut tiers: Vec<u32> = disk::DERIVE_TIERS.to_vec();
        tiers.push(requested);
        tiers.sort_unstable();
        tiers.dedup();
        for t in tiers {
            write_webp_tier(&img, t, &disk::tier_path(&dir_owned, t))?;
        }
        Ok(())
    })
    .await;
    if !matches!(encoded, Ok(Ok(()))) {
        return None;
    }

    // HIT: real art is now on disk. Record it so the coverless-album path stops
    // re-running the provider chain on every re-ensure (a HIT writes no
    // `.miss-album-ext` cooldown, so without this the chain would re-query
    // apple/lastfm on each mount). The normal peek finds the written tier.
    write_marker(&dir.join(ALBUM_EXT_HIT_MARKER));

    Some(disk::tier_path(dir, requested))
}

#[cfg(test)]
mod fanart_gate_tests {
    use super::dims_satisfy_fanart;

    #[test]
    fn gate_accepts_wide_16_9_and_rejects_square_or_small() {
        assert!(dims_satisfy_fanart(2000, 1125)); // 16:9, wide
        assert!(dims_satisfy_fanart(1280, 800)); // aspect 1.6 boundary
        assert!(dims_satisfy_fanart(1280, 640)); // aspect 2.0 boundary
        assert!(!dims_satisfy_fanart(2000, 2000)); // square portrait
        assert!(!dims_satisfy_fanart(1000, 560)); // width < 1280
        assert!(!dims_satisfy_fanart(1280, 600)); // aspect 2.13 > 2.0
        assert!(!dims_satisfy_fanart(1280, 0)); // div-by-zero guard
    }
}
