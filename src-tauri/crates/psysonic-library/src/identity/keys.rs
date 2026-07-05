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
    let album_key = join_norm_parts([
        norm_part(album_source.unwrap_or("")),
        album_norm,
    ]);

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
}
