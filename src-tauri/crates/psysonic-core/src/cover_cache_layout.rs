//! Cover disk cache layout — **single place** to change directory naming.
//!
//! Callers pass `cache_kind` (`album` | `artist`) and `cache_entity_id` (server ids:
//! Navidrome `album.id` is often a bare hash/snowflake; `coverArt` may use `al-*`.
//! Rarely `mf-*` / `dc-*` on disk when UI enables per-disc art. Path shape:
//!
//! `{root}/{server_segment}/{kind}/{entity_id}/128.webp`
//!
//! `server_segment` is derived from the frontend's `serverIndexKeyFromUrl` (host + path,
//! no scheme). On Windows that key would otherwise drop a `:` straight into the filesystem
//! whenever the user runs Navidrome on a `:port` URL — `CreateDirectory` then rejects the
//! whole path with `ERROR_INVALID_NAME`. [`cover_server_dir`] sanitizes the key before it
//! hits disk; every caller that wants a server-scoped cover directory goes through it.
//!
//! Bump [`LAYOUT_STAMP`] when the on-disk format changes (app wipes legacy dirs on startup).

use std::path::{Path, PathBuf};

/// Written to `{cover_root}/.storage-layout` — mismatch triggers cache reset.
pub const LAYOUT_STAMP: &str = "canonical-segment-v5";

/// True for ids that are only valid as `getCoverArt` targets, not library entity keys.
pub fn is_fetch_only_cover_id(id: &str) -> bool {
    let id = id.trim();
    id.starts_with("mf-")
        || id.starts_with("tr-")
        || id.starts_with("pl-")
        || id.starts_with("dc-")
        || id.starts_with("ra-")
}

/// Windows reserved device names (case-insensitive) — invalid as path components.
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Sanitize a single path segment for Windows / Unix (Navidrome ids are usually already safe).
/// Also used for media layout artist/album/title segments from server metadata.
pub fn sanitize_path_segment(segment: &str) -> String {
    const FORBIDDEN: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let trimmed = segment.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        return "_".to_string();
    }
    let cleaned: String = trimmed
        .chars()
        .map(|c| {
            if c.is_control() || FORBIDDEN.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return "_".to_string();
    }
    let upper = cleaned.to_ascii_uppercase();
    if WINDOWS_RESERVED_NAMES.contains(&upper.as_str()) {
        return format!("_{cleaned}");
    }
    cleaned
}

/// Relative path under `{root}/{server_segment}/` — change format here only.
pub fn cover_entity_relative_dir(cache_kind: &str, cache_entity_id: &str) -> PathBuf {
    let kind = sanitize_path_segment(cache_kind);
    let entity = sanitize_path_segment(cache_entity_id);
    PathBuf::from(kind).join(entity)
}

/// Per-server cache root (`{root}/{server_segment}/`). Sanitizes the index key so
/// `host:port` and embedded URL paths survive on Windows. Every caller that wants the
/// server bucket — list/count/clear/backfill — must go through this helper.
pub fn cover_server_dir(root: &Path, server_index_key: &str) -> PathBuf {
    root.join(sanitize_path_segment(server_index_key))
}

/// Absolute directory for one cover entity (`…/album/al-…/` or `…/artist/ar-…/`).
pub fn cover_dir(
    root: &Path,
    server_index_key: &str,
    cache_kind: &str,
    cache_entity_id: &str,
) -> PathBuf {
    cover_server_dir(root, server_index_key)
        .join(cover_entity_relative_dir(cache_kind, cache_entity_id))
}

/// Resolved cover identity — keep in sync with TS `src/cover/resolveEntry.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverEntry {
    pub cache_kind: &'static str,
    pub cache_entity_id: String,
    pub fetch_cover_art_id: String,
}

/// Album — one disk slot per album; per-disc ids only when `distinct_disc_covers`.
pub fn resolve_album_cover(
    album_id: &str,
    cover_art_id: Option<&str>,
    distinct_disc_covers: bool,
) -> Option<CoverEntry> {
    let album = album_id.trim();
    if album.is_empty() {
        return None;
    }
    let fetch = cover_art_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(album);
    // Navidrome track-only libraries: keep consensus `mf-*` fetch (library picks the
    // first track per album) while the disk slot stays album-scoped.
    if !distinct_disc_covers && fetch.starts_with("mf-") && fetch != album {
        return Some(CoverEntry {
            cache_kind: "album",
            cache_entity_id: album.to_string(),
            fetch_cover_art_id: fetch.to_string(),
        });
    }
    let fetch_id = if !distinct_disc_covers && fetch == album {
        format!("al-{album}_0")
    } else {
        fetch.to_string()
    };
    let cache_entity_id = if distinct_disc_covers && fetch != album {
        fetch.to_string()
    } else {
        album.to_string()
    };
    Some(CoverEntry {
        cache_kind: "album",
        cache_entity_id,
        fetch_cover_art_id: fetch_id,
    })
}

/// Segment roots under `{server_index_key}/` (canonical layout).
pub const SEGMENT_KINDS: [&str; 2] = ["album", "artist"];

/// Progress / backfill “done” heuristic — matches `LIBRARY_COVER_CANONICAL_TIER` in the library crate.
pub const CANONICAL_PROGRESS_TIER: u32 = 800;

fn tier_webp_ready(path: &Path) -> bool {
    path.is_file() && path.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

/// True when `{entity_dir}/{CANONICAL_PROGRESS_TIER}.webp` exists and is non-empty.
pub fn entity_dir_has_canonical_tier(entity_dir: &Path) -> bool {
    tier_webp_ready(&entity_dir.join(format!("{CANONICAL_PROGRESS_TIER}.webp")))
}

/// Distinct album/artist entity dirs with canonical tier (segment layout only).
pub fn count_entities_with_canonical_tier(server_dir: &Path) -> i64 {
    let mut n = 0i64;
    for kind in SEGMENT_KINDS {
        let kind_dir = server_dir.join(kind);
        let Ok(entries) = std::fs::read_dir(&kind_dir) else {
            continue;
        };
        for ent in entries.flatten() {
            if ent.path().is_dir() && entity_dir_has_canonical_tier(&ent.path()) {
                n += 1;
            }
        }
    }
    n
}

fn sum_webp_bytes_rec(dir: &Path) -> u64 {
    let mut bytes = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return bytes;
    };
    for ent in entries.flatten() {
        let p = ent.path();
        if p.is_dir() {
            bytes += sum_webp_bytes_rec(&p);
        } else if p.extension().and_then(|s| s.to_str()) == Some("webp") {
            if let Ok(meta) = ent.metadata() {
                bytes += meta.len();
            }
        }
    }
    bytes
}

/// All `.webp` bytes under one server bucket + entity count (canonical tier, segment dirs).
pub fn server_cover_disk_usage(server_dir: &Path) -> (u64, u64) {
    (
        sum_webp_bytes_rec(server_dir),
        count_entities_with_canonical_tier(server_dir) as u64,
    )
}

/// Sum usage across every server subdirectory under `cover_root`.
pub fn cover_root_disk_usage(cover_root: &Path) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut count = 0u64;
    let Ok(entries) = std::fs::read_dir(cover_root) else {
        return (0, 0);
    };
    for ent in entries.flatten() {
        let fname = ent.file_name();
        let name = fname.to_string_lossy();
        if name == ".storage-layout" || !ent.path().is_dir() {
            continue;
        }
        let (b, c) = server_cover_disk_usage(&ent.path());
        bytes += b;
        count += c;
    }
    (bytes, count)
}

/// Artist — one disk slot per artist id.
pub fn resolve_artist_cover(artist_id: &str, cover_art_id: Option<&str>) -> Option<CoverEntry> {
    let artist = artist_id.trim();
    if artist.is_empty() {
        return None;
    }
    let fetch = cover_art_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(artist);
    Some(CoverEntry {
        cache_kind: "artist",
        cache_entity_id: artist.to_string(),
        fetch_cover_art_id: fetch.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_paths_use_kind_and_entity_id() {
        let root = Path::new("/tmp/cover");
        let dir = cover_dir(root, "srv", "album", "al-1");
        assert_eq!(dir, root.join("srv").join("album").join("al-1"));
    }

    #[test]
    fn server_segment_sanitizes_port_colon_and_url_path() {
        let root = Path::new("/tmp/cover");
        // Typical LAN URL key from `serverIndexKeyFromUrl`: `host:port/path`.
        // The `:` is invalid on Windows; the `/` would otherwise create a
        // nested directory rather than one bucket per server.
        let dir = cover_server_dir(root, "192.168.1.10:4533/music");
        assert_eq!(dir, root.join("192.168.1.10_4533_music"));
    }

    #[test]
    fn cover_dir_passes_server_key_through_sanitizer() {
        let root = Path::new("/tmp/cover");
        let dir = cover_dir(root, "host:4533", "album", "al-1");
        assert_eq!(dir, root.join("host_4533").join("album").join("al-1"));
    }

    #[test]
    fn album_and_artist_segments_differ() {
        let al = cover_entity_relative_dir("album", "al-1");
        let ar = cover_entity_relative_dir("artist", "ar-1");
        assert_ne!(al, ar);
    }

    #[test]
    fn per_disc_mf_entity_gets_own_dir() {
        let d = cover_entity_relative_dir("album", "mf-disc2_abc");
        assert_eq!(d, PathBuf::from("album").join("mf-disc2_abc"));
    }

    #[test]
    fn resolve_album_bare_navidrome_id() {
        let e = resolve_album_cover("0DurV2S7arIOBQVEknOPWX", Some("al-0Dur_abc"), false).unwrap();
        assert_eq!(e.cache_entity_id, "0DurV2S7arIOBQVEknOPWX");
        assert_eq!(e.fetch_cover_art_id, "al-0Dur_abc");
    }

    #[test]
    fn resolve_album_per_disc_changes_cache_entity() {
        let e = resolve_album_cover("al-box", Some("mf-d2"), true).unwrap();
        assert_eq!(e.cache_entity_id, "mf-d2");
    }

    #[test]
    fn resolve_album_keeps_mf_fetch_on_album_bucket() {
        let e = resolve_album_cover("al-box", Some("mf-track"), false).unwrap();
        assert_eq!(e.cache_entity_id, "al-box");
        assert_eq!(e.fetch_cover_art_id, "mf-track");
    }

    #[test]
    fn resolve_album_navidrome_bare_id() {
        let e = resolve_album_cover("2lsdR1ogDKiFcAD6Pcvk4f", None, false).unwrap();
        assert_eq!(e.fetch_cover_art_id, "al-2lsdR1ogDKiFcAD6Pcvk4f_0");
    }

    fn test_server_dir(label: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!("psysonic-cover-layout-{label}"));
        let _ = std::fs::remove_dir_all(&base);
        base
    }

    #[test]
    fn sanitize_rejects_dot_dot_and_reserved_names() {
        assert_eq!(sanitize_path_segment(".."), "_");
        assert_eq!(sanitize_path_segment("CON"), "_CON");
        assert_eq!(sanitize_path_segment(" trailing. "), "trailing");
    }

    #[test]
    fn segment_disk_usage_counts_canonical_only() {
        let server = test_server_dir("usage");
        let entity = server.join("album").join("al-1");
        std::fs::create_dir_all(&entity).unwrap();
        std::fs::write(entity.join("128.webp"), b"x").unwrap();
        assert_eq!(count_entities_with_canonical_tier(&server), 0);
        std::fs::write(entity.join("800.webp"), b"yy").unwrap();
        assert_eq!(count_entities_with_canonical_tier(&server), 1);
        let (bytes, count) = server_cover_disk_usage(&server);
        assert_eq!(count, 1);
        assert!(bytes >= 3);
        let _ = std::fs::remove_dir_all(&server);
    }
}
