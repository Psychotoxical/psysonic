//! Local playback disk layout — artist/album/track paths from library-index fields.
//!
//! Mirrors the contract in `implementation-spec.md` (local playback unification).
//! `server_segment` uses [`cover_cache_layout::sanitize_path_segment`] on the URL
//! index key; artist/album/filename segments are derived from track metadata only.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use crate::cover_cache_layout::sanitize_path_segment;

/// Max length for a single path component after sanitization (Windows budget).
pub const MAX_SEGMENT_LEN: usize = 120;

/// Inputs required to build hierarchical media paths (library index row projection).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackPathInput {
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: String,
    pub title: String,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub suffix: Option<String>,
    /// When set, used to detect compilation albums from `raw_json` (OpenSubsonic).
    pub raw_json: Option<String>,
}

/// Tier subdirectory under the media root (`cache/` or `library/`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalTier {
    Ephemeral,
    Library,
}

impl LocalTier {
    pub fn subdir(self) -> &'static str {
        match self {
            Self::Ephemeral => "cache",
            Self::Library => "library",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ephemeral" | "cache" => Some(Self::Ephemeral),
            "library" => Some(Self::Library),
            _ => None,
        }
    }
}

/// Stable fingerprint for invalidation when library metadata changes (§8 spec).
pub fn layout_fingerprint(input: &TrackPathInput) -> String {
    let artist_seg = artist_folder_segment(input);
    let album_seg = album_folder_segment(&input.album);
    let stem = track_filename_stem(input);
    let suffix = input
        .suffix
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    let track_n = input.track_number.unwrap_or(0);
    let disc_n = input.disc_number.unwrap_or(0);
    format!(
        "artist={artist_seg}|album_artist={}|album={album_seg}|title={}|track={track_n}|disc={disc_n}|stem={stem}|suffix={suffix}",
        input
            .album_artist
            .as_deref()
            .map(str::trim)
            .unwrap_or(""),
        input.title.trim(),
    )
}

/// Relative path under `{tier}/{server_segment}/`: `{artist}/{album}/{file}.{suffix}`.
pub fn relative_path_for_track(
    server_index_key: &str,
    input: &TrackPathInput,
    suffix: &str,
) -> PathBuf {
    let server_segment = sanitize_path_segment(server_index_key);
    let artist = artist_folder_segment(input);
    let album = album_folder_segment(&input.album);
    let stem = track_filename_stem(input);
    let ext = suffix.trim().trim_start_matches('.');
    let filename = if ext.is_empty() {
        sanitize_and_truncate_segment(&stem, MAX_SEGMENT_LEN)
    } else {
        format!(
            "{}.{}",
            sanitize_and_truncate_segment(&stem, MAX_SEGMENT_LEN),
            sanitize_path_segment(ext)
        )
    };
    PathBuf::from(server_segment)
        .join(artist)
        .join(album)
        .join(filename)
}

/// Absolute file path: `{media_root}/{tier}/…relative_path…`.
pub fn absolute_track_path(
    media_root: &Path,
    tier: LocalTier,
    server_index_key: &str,
    input: &TrackPathInput,
    suffix: &str,
) -> PathBuf {
    media_root
        .join(tier.subdir())
        .join(relative_path_for_track(server_index_key, input, suffix))
}

fn artist_folder_segment(input: &TrackPathInput) -> String {
    let artist = input.artist.as_deref().map(str::trim).unwrap_or("");
    let album_artist = input.album_artist.as_deref().map(str::trim).unwrap_or("");
    let chosen = if artist.is_empty() || track_is_compilation(input) {
        if !album_artist.is_empty() {
            album_artist
        } else {
            "Various Artists"
        }
    } else {
        artist
    };
    sanitize_and_truncate_segment(chosen, MAX_SEGMENT_LEN)
}

fn album_folder_segment(album: &str) -> String {
    let trimmed = album.trim();
    let fallback = if trimmed.is_empty() { "Unknown Album" } else { trimmed };
    sanitize_and_truncate_segment(fallback, MAX_SEGMENT_LEN)
}

fn track_filename_stem(input: &TrackPathInput) -> String {
    let title = input.title.trim();
    let title = if title.is_empty() { "Unknown Title" } else { title };
    let track_n = input.track_number.unwrap_or(0).max(0) as u32;
    let disc_n = input.disc_number.unwrap_or(1).max(0) as u32;
    if disc_n > 1 {
        format!("{disc_n:02}-{track_n:02} - {title}")
    } else {
        format!("{track_n:02} - {title}")
    }
}

fn track_is_compilation(input: &TrackPathInput) -> bool {
    if various_artists_label(input.artist.as_deref().unwrap_or("")) {
        return true;
    }
    let Some(raw) = input.raw_json.as_deref().filter(|s| !s.is_empty()) else {
        return false;
    };
    raw_json_marks_compilation(raw)
}

/// Best-effort probe aligned with `album_compilation_filter::compilation_raw_json_sql`.
fn raw_json_marks_compilation(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    lower.contains("\"iscompilation\":true")
        || lower.contains("\"iscompilation\": true")
        || lower.contains("\"compilation\":true")
        || lower.contains("\"compilation\": true")
        || lower.contains("\"compilation\":1")
        || lower.contains("\"releaseTypes\"") && lower.contains("compilation")
}

fn various_artists_label(s: &str) -> bool {
    let lower = s.trim().to_ascii_lowercase();
    lower.contains("various artists")
}

fn sanitize_and_truncate_segment(segment: &str, max_len: usize) -> String {
    let sanitized = sanitize_path_segment(segment);
    if sanitized.len() <= max_len {
        return sanitized;
    }
    let hash = short_hash(segment);
    let keep = max_len.saturating_sub(1 + hash.len());
    let mut out = sanitized.chars().take(keep).collect::<String>();
    out.push('_');
    out.push_str(&hash);
    out
}

fn short_hash(s: &str) -> String {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    format!("{:08x}", h.finish() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input() -> TrackPathInput {
        TrackPathInput {
            artist: Some("Radiohead".to_string()),
            album_artist: None,
            album: "OK Computer".to_string(),
            title: "Paranoid Android".to_string(),
            track_number: Some(6),
            disc_number: Some(1),
            suffix: Some("mp3".to_string()),
            raw_json: None,
        }
    }

    #[test]
    fn relative_path_uses_library_segments() {
        let rel = relative_path_for_track("host:4533", &sample_input(), "mp3");
        assert_eq!(
            rel,
            PathBuf::from("host_4533")
                .join("Radiohead")
                .join("OK Computer")
                .join("06 - Paranoid Android.mp3")
        );
    }

    #[test]
    fn multi_disc_adds_disc_prefix() {
        let mut input = sample_input();
        input.disc_number = Some(2);
        let rel = relative_path_for_track("srv", &input, "flac");
        assert!(rel
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("02-06 - Paranoid Android.flac")));
    }

    #[test]
    fn compilation_uses_album_artist_folder() {
        let input = TrackPathInput {
            artist: Some("Various Artists".to_string()),
            album_artist: Some("Original Soundtrack".to_string()),
            album: "Film Score".to_string(),
            title: "Main Theme".to_string(),
            track_number: Some(1),
            disc_number: Some(1),
            suffix: Some("mp3".to_string()),
            raw_json: None,
        };
        let rel = relative_path_for_track("srv", &input, "mp3");
        assert_eq!(rel.components().nth(1).and_then(|c| c.as_os_str().to_str()), Some("Original Soundtrack"));
    }

    #[test]
    fn empty_artist_falls_back_to_various_artists() {
        let input = TrackPathInput {
            artist: None,
            album_artist: None,
            album: "Comp".to_string(),
            title: "Song".to_string(),
            track_number: Some(1),
            disc_number: Some(1),
            suffix: Some("mp3".to_string()),
            raw_json: None,
        };
        let rel = relative_path_for_track("srv", &input, "mp3");
        assert_eq!(rel.components().nth(1).and_then(|c| c.as_os_str().to_str()), Some("Various Artists"));
    }

    #[test]
    fn layout_fingerprint_is_stable() {
        let a = layout_fingerprint(&sample_input());
        let b = layout_fingerprint(&sample_input());
        assert_eq!(a, b);
        assert!(a.contains("Radiohead"));
        assert!(a.contains("OK Computer"));
    }

    #[test]
    fn tier_subdirs_are_fixed() {
        assert_eq!(LocalTier::Ephemeral.subdir(), "cache");
        assert_eq!(LocalTier::Library.subdir(), "library");
        assert_eq!(LocalTier::parse("ephemeral"), Some(LocalTier::Ephemeral));
        assert_eq!(LocalTier::parse("library"), Some(LocalTier::Library));
    }

    #[test]
    fn absolute_path_includes_tier() {
        let root = Path::new("/media");
        let path = absolute_track_path(root, LocalTier::Library, "srv", &sample_input(), "mp3");
        assert!(path.starts_with(root.join("library")));
    }
}
