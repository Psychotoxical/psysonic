//! Composite cluster / album / artist keys from track metadata.

use super::norm::{join_norm_parts, norm_part};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackClusterKeys {
    pub cluster_key: Option<String>,
    pub album_key: Option<String>,
    pub artist_key: Option<String>,
}

/// `album_artist` when non-empty, else `artist`.
fn album_identity_source<'a>(album_artist: Option<&'a str>, artist: Option<&'a str>) -> Option<&'a str> {
    album_artist
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| artist.map(str::trim).filter(|s| !s.is_empty()))
}

pub(crate) fn build_album_key(artist: Option<&str>, album: &str) -> Option<String> {
    join_norm_parts([norm_part(artist.unwrap_or("")), norm_part(album)])
}

fn album_name_without_appended_version<'a>(album: &'a str, version: &str) -> &'a str {
    let album = album.trim();
    let suffix = format!(" ({})", version.trim());
    if album.len() > suffix.len() {
        let (base, candidate) = album.split_at(album.len() - suffix.len());
        if candidate.eq_ignore_ascii_case(&suffix) {
            return base.trim_end();
        }
    }
    album
}

pub(crate) fn build_album_key_with_version(
    artist: Option<&str>,
    album: &str,
    version: Option<&str>,
) -> Option<String> {
    let version = version.map(str::trim).filter(|value| !value.is_empty());
    let normalized_version = version.and_then(norm_part);
    let Some(normalized_version) = normalized_version else {
        return build_album_key(artist, album);
    };
    let album = album_name_without_appended_version(album, version.unwrap_or_default());
    join_norm_parts([
        norm_part(artist.unwrap_or("")),
        norm_part(album),
        Some(normalized_version),
    ])
}

pub(crate) fn build_track_cluster_key_with_version(
    artist: Option<&str>,
    title: &str,
    album: &str,
    version: Option<&str>,
) -> Option<String> {
    let version = version.map(str::trim).filter(|value| !value.is_empty());
    let normalized_version = version.and_then(norm_part);
    let Some(normalized_version) = normalized_version else {
        return join_norm_parts([
            norm_part(artist.unwrap_or("")),
            norm_part(title),
            norm_part(album),
        ]);
    };
    let album = album_name_without_appended_version(album, version.unwrap_or_default());
    join_norm_parts([
        norm_part(artist.unwrap_or("")),
        norm_part(title),
        norm_part(album),
        Some(normalized_version),
    ])
}

pub fn build_track_cluster_keys(
    artist: Option<&str>,
    title: &str,
    album: &str,
    album_artist: Option<&str>,
) -> TrackClusterKeys {
    let artist_norm = norm_part(artist.unwrap_or(""));
    let title_norm = norm_part(title);
    let album_norm = norm_part(album);

    let cluster_key = join_norm_parts([artist_norm.clone(), title_norm, album_norm.clone()]);

    let album_source = album_identity_source(album_artist, artist);
    let album_key = build_album_key(album_source, album);

    TrackClusterKeys {
        cluster_key,
        album_key,
        artist_key: artist_norm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::norm::KEY_SEP;

    #[test]
    fn composite_keys_built_correctly() {
        let keys = build_track_cluster_keys(
            Some("The Beatles"),
            "Hey Jude",
            "Hey Jude",
            Some("The Beatles"),
        );
        let sep = KEY_SEP;
        assert_eq!(
            keys.cluster_key,
            Some(format!("thebeatles{}heyjude{}heyjude", sep, sep))
        );
        assert_eq!(keys.album_key, Some(format!("thebeatles{}heyjude", sep)));
        assert_eq!(keys.artist_key, Some("thebeatles".into()));
    }

    #[test]
    fn empty_artist_yields_null_cluster_and_artist_keys() {
        let keys = build_track_cluster_keys(None, "Title", "Album", None);
        assert!(keys.cluster_key.is_none());
        assert!(keys.artist_key.is_none());
        // album_key can still exist when album + fallback artist source is empty — no, artist empty
        assert!(keys.album_key.is_none());
    }

    #[test]
    fn album_key_uses_album_artist_over_artist() {
        let keys = build_track_cluster_keys(
            Some("Track Artist"),
            "T",
            "Greatest Hits",
            Some("Comp Artist"),
        );
        let sep = KEY_SEP;
        assert_eq!(
            keys.album_key,
            Some(format!("compartist{}greatesthits", sep))
        );
    }

    #[test]
    fn album_version_distinguishes_releases() {
        let standard = build_album_key_with_version(Some("Artist"), "Album", Some("Standard"));
        let deluxe =
            build_album_key_with_version(Some("Artist"), "Album", Some("Deluxe Edition"));
        assert_ne!(standard, deluxe);
    }

    #[test]
    fn appended_album_version_matches_the_plain_album_name() {
        let plain =
            build_album_key_with_version(Some("Artist"), "Album", Some("Deluxe Edition"));
        let appended = build_album_key_with_version(
            Some("Artist"),
            "Album (Deluxe Edition)",
            Some("Deluxe Edition"),
        );
        assert_eq!(plain, appended);

        let plain_track = build_track_cluster_key_with_version(
            Some("Artist"),
            "Song",
            "Album",
            Some("Deluxe Edition"),
        );
        let appended_track = build_track_cluster_key_with_version(
            Some("Artist"),
            "Song",
            "Album (Deluxe Edition)",
            Some("Deluxe Edition"),
        );
        assert_eq!(plain_track, appended_track);
    }
}
