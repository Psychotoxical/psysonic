//! Cover disk cache layout — **single place** to change directory naming.
//!
//! Callers pass `cache_kind` (`album` | `artist`) and `cache_entity_id` (server ids:
//! Navidrome `album.id` is often a bare hash/snowflake; `coverArt` may use `al-*`.
//! Rarely `mf-*` / `dc-*` on disk when UI enables per-disc art. Path shape:
//!
//! `{root}/{server_index_key}/{kind}/{entity_id}/128.webp`
//!
//! Bump [`LAYOUT_STAMP`] when the on-disk format changes (app wipes legacy dirs on startup).

use std::path::{Path, PathBuf};

/// Written to `{cover_root}/.storage-layout` — mismatch triggers cache reset.
pub const LAYOUT_STAMP: &str = "canonical-segment-v3";

/// True for ids that are only valid as `getCoverArt` targets, not library entity keys.
pub fn is_fetch_only_cover_id(id: &str) -> bool {
    let id = id.trim();
    id.starts_with("mf-")
        || id.starts_with("tr-")
        || id.starts_with("pl-")
        || id.starts_with("dc-")
        || id.starts_with("ra-")
}

/// Legacy classifier when only an id string is known — backfill should use SQL `kind` instead.
pub fn cover_cache_catalog_entry(id: &str) -> Option<(&'static str, &str)> {
    let id = id.trim();
    if id.is_empty() || is_fetch_only_cover_id(id) {
        return None;
    }
    if id.starts_with("ar-") {
        Some(("artist", id))
    } else if id.starts_with("al-") {
        Some(("album", id))
    } else {
        // Navidrome bare album/artist id — default album; ambiguous without SQL kind.
        Some(("album", id))
    }
}

/// Sanitize a single path segment for Windows / Unix (Navidrome ids are usually already safe).
pub fn sanitize_path_segment(segment: &str) -> String {
    const FORBIDDEN: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let trimmed = segment.trim();
    if trimmed.is_empty() {
        return "_".to_string();
    }
    trimmed
        .chars()
        .map(|c| if FORBIDDEN.contains(&c) { '_' } else { c })
        .collect()
}

/// Relative path under `{root}/{server_index_key}/` — change format here only.
pub fn cover_entity_relative_dir(cache_kind: &str, cache_entity_id: &str) -> PathBuf {
    let kind = sanitize_path_segment(cache_kind);
    let entity = sanitize_path_segment(cache_entity_id);
    PathBuf::from(kind).join(entity)
}

/// Absolute directory for one cover entity (`…/album/al-…/` or `…/artist/ar-…/`).
pub fn cover_dir(
    root: &Path,
    server_index_key: &str,
    cache_kind: &str,
    cache_entity_id: &str,
) -> PathBuf {
    root.join(server_index_key).join(cover_entity_relative_dir(cache_kind, cache_entity_id))
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
    let cache_entity_id = if distinct_disc_covers && fetch != album {
        fetch.to_string()
    } else {
        album.to_string()
    };
    Some(CoverEntry {
        cache_kind: "album",
        cache_entity_id,
        fetch_cover_art_id: fetch.to_string(),
    })
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
}
