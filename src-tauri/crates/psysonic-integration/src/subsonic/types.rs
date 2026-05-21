//! Response structs for the Subsonic REST API surface PR-2 needs.
//!
//! Only the hot fields the sync engine reads are typed; everything else
//! survives via the raw JSON the client also returns (PR-3 wires the
//! `raw_json` column on `track`). Unknown fields are simply ignored on
//! deserialize — additive OpenSubsonic extensions never break parsing.

use serde::{Deserialize, Serialize};

/// Deserialize a field Navidrome/OpenSubsonic may return either as a plain
/// string or as a JSON array. OpenSubsonic types `isrc` as `string[]`;
/// Navidrome ships `isrc: []` / `["USRC…"]`, which breaks a plain
/// `Option<String>`. Take the first usable value; the full set survives
/// verbatim in `track.raw_json` (ADR-7).
fn de_string_or_seq<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(serde_json::Value::String(s)) => Some(s),
        Some(serde_json::Value::Array(arr)) => first_tag_value(&arr),
        _ => None,
    })
}

/// Navidrome often ships library ids as JSON numbers; Subsonic uses strings.
fn de_string_or_number<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(serde_json::Value::String(s)) => Some(s),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        _ => None,
    })
}

/// First usable value in a multi-valued array: a string element, or an
/// object element's `name` (the OpenSubsonic `[{ "name": … }]` shape).
fn first_tag_value(arr: &[serde_json::Value]) -> Option<String> {
    arr.iter().find_map(|el| match el {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(map) => map
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        _ => None,
    })
}

/// Envelope-level metadata returned by `#ping` (and present on every
/// other response too). Read by the capability probe to detect the
/// server family (Navidrome vs generic Subsonic) and the OpenSubsonic
/// flag. Filled in from the `subsonic-response` object itself, not
/// from a body key — these fields sit at the same level as `status`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ServerInfo {
    /// Server software family — Navidrome reports `"navidrome"`, generic
    /// Subsonic implementations report their own label. `None` when the
    /// server omits the field (older Subsonic).
    pub server_type: Option<String>,
    /// Server build version, e.g. `"0.55.2"` on Navidrome.
    pub server_version: Option<String>,
    /// Subsonic API protocol level the server advertises.
    pub api_version: Option<String>,
    /// `true` when the server advertises OpenSubsonic extensions
    /// (`isrc`, `played`, `bpm`, contributor arrays, …).
    pub open_subsonic: bool,
}

/// `#getScanStatus` (since 1.15.0). `lastScan` is an ISO-8601 string on
/// Navidrome (`responses.go` `ScanStatus.LastScan`); other servers may
/// omit it during an active scan.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ScanStatus {
    pub scanning: bool,
    #[serde(default)]
    pub count: Option<i64>,
    #[serde(rename = "folderCount", default)]
    pub folder_count: Option<i64>,
    #[serde(rename = "lastScan", default)]
    pub last_scan: Option<String>,
}

/// `#getIndexes` (file-structure browse) and `#getArtists` (ID3 browse)
/// share the same shape on the wire: a top-level `lastModified` watermark
/// plus a list of letter buckets.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ArtistIndex {
    /// `lastModified` is ms since epoch (spec §2.2 — response metadata,
    /// not a request param).
    #[serde(rename = "lastModified", default)]
    pub last_modified_ms: Option<i64>,
    #[serde(rename = "ignoredArticles", default)]
    pub ignored_articles: Option<String>,
    #[serde(default)]
    pub index: Vec<IndexBucket>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct IndexBucket {
    pub name: String,
    #[serde(default)]
    pub artist: Vec<ArtistRef>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ArtistRef {
    pub id: String,
    pub name: String,
    #[serde(rename = "albumCount", default)]
    pub album_count: Option<i64>,
    #[serde(rename = "coverArt", default)]
    pub cover_art: Option<String>,
}

/// `#getAlbumList2` — page of album summaries (no song list).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct AlbumSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(rename = "artistId", default)]
    pub artist_id: Option<String>,
    #[serde(rename = "songCount", default)]
    pub song_count: Option<i64>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub year: Option<i64>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(rename = "coverArt", default)]
    pub cover_art: Option<String>,
    #[serde(default)]
    pub starred: Option<String>,
}

/// `#getAlbum` — album + its full song list.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Album {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(rename = "artistId", default)]
    pub artist_id: Option<String>,
    #[serde(rename = "songCount", default)]
    pub song_count: Option<i64>,
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(default)]
    pub year: Option<i64>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(rename = "coverArt", default)]
    pub cover_art: Option<String>,
    #[serde(default)]
    pub song: Vec<Song>,
}

/// `#search3` — three parallel lists, any of which may be empty.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Default)]
pub struct SearchResult {
    #[serde(default)]
    pub artist: Vec<ArtistRef>,
    #[serde(default)]
    pub album: Vec<AlbumSummary>,
    #[serde(default)]
    pub song: Vec<Song>,
}

/// `#getSong` / nested in `#getAlbum`. Only the hot columns from
/// spec §5.1 are typed; everything else (OpenSubsonic extensions, contributor
/// arrays, …) is ignored at this layer and recovered from `raw_json` later.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Song {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(rename = "artistId", default)]
    pub artist_id: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(rename = "albumId", default)]
    pub album_id: Option<String>,
    #[serde(rename = "albumArtist", default)]
    pub album_artist: Option<String>,
    /// Subsonic reports `duration` in whole seconds.
    #[serde(default)]
    pub duration: Option<i64>,
    #[serde(rename = "track", default)]
    pub track_number: Option<i64>,
    #[serde(rename = "discNumber", default)]
    pub disc_number: Option<i64>,
    #[serde(default)]
    pub year: Option<i64>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub suffix: Option<String>,
    #[serde(rename = "bitRate", default)]
    pub bit_rate: Option<i64>,
    /// Server reports `size` in bytes.
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(rename = "coverArt", default)]
    pub cover_art: Option<String>,
    #[serde(default)]
    pub starred: Option<String>,
    #[serde(rename = "userRating", default)]
    pub user_rating: Option<i64>,
    #[serde(rename = "playCount", default)]
    pub play_count: Option<i64>,
    #[serde(default)]
    pub played: Option<String>,
    /// Server-side relative path (Navidrome populates; some servers don't).
    #[serde(default)]
    pub path: Option<String>,
    /// `libraryId` (Navidrome native) or `musicFolderId` (Subsonic generic).
    /// We accept both keys — Navidrome uses `libraryId` on OpenSubsonic
    /// responses, generic Subsonic stays on `musicFolderId`.
    #[serde(
        default,
        alias = "libraryId",
        alias = "musicFolderId",
        deserialize_with = "de_string_or_number"
    )]
    pub library_id: Option<String>,
    // OpenSubsonic types `isrc` as `string[]` — Navidrome returns
    // `isrc: []` / `["USRC…"]`, which breaks a plain `Option<String>`.
    #[serde(default, deserialize_with = "de_string_or_seq")]
    pub isrc: Option<String>,
    /// MusicBrainz recording id. Subsonic / OpenSubsonic uses the
    /// `musicBrainzId` JSON key; the schema column is `mbid_recording`
    /// (spec §5.1). The alias keeps both spellings deserializable so
    /// future API revisions don't break ingest.
    #[serde(default, alias = "musicBrainzId", alias = "mbid_recording")]
    pub mbid_recording: Option<String>,
    #[serde(default)]
    pub bpm: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn song_deserialize_accepts_minimal_navidrome_payload() {
        let payload = r#"{
            "id": "tr_1",
            "title": "Hello",
            "artist": "World",
            "duration": 240,
            "track": 3,
            "year": 2024,
            "suffix": "flac",
            "bitRate": 1000,
            "size": 32000000,
            "coverArt": "cv_1",
            "libraryId": "1",
            "isrc": "USRC17607839"
        }"#;
        let song: Song = serde_json::from_str(payload).unwrap();
        assert_eq!(song.id, "tr_1");
        assert_eq!(song.title, "Hello");
        assert_eq!(song.duration, Some(240));
        assert_eq!(song.track_number, Some(3));
        assert_eq!(song.library_id.as_deref(), Some("1"));
        assert_eq!(song.isrc.as_deref(), Some("USRC17607839"));
    }

    #[test]
    fn song_alias_falls_back_to_music_folder_id() {
        // Generic Subsonic still ships `musicFolderId`, not Navidrome's
        // `libraryId` — make sure we don't lose it.
        let payload = r#"{"id":"a","title":"t","musicFolderId":"7"}"#;
        let song: Song = serde_json::from_str(payload).unwrap();
        assert_eq!(song.library_id.as_deref(), Some("7"));
    }

    #[test]
    fn song_deserialize_library_id_from_number() {
        let payload = r#"{"id":"a","title":"t","libraryId":3}"#;
        let song: Song = serde_json::from_str(payload).unwrap();
        assert_eq!(song.library_id.as_deref(), Some("3"));
    }

    #[test]
    fn song_picks_up_music_brainz_id_from_either_alias() {
        // OpenSubsonic shape — `musicBrainzId`.
        let from_subsonic: Song = serde_json::from_str(
            r#"{"id":"a","title":"t","musicBrainzId":"abc-123"}"#,
        )
        .unwrap();
        assert_eq!(from_subsonic.mbid_recording.as_deref(), Some("abc-123"));

        // Schema-column shape — direct `mbid_recording`. Lets callers
        // round-trip a row through `serde_json` without renaming.
        let from_schema: Song = serde_json::from_str(
            r#"{"id":"a","title":"t","mbid_recording":"xyz-789"}"#,
        )
        .unwrap();
        assert_eq!(from_schema.mbid_recording.as_deref(), Some("xyz-789"));
    }

    #[test]
    fn song_ignores_unknown_open_subsonic_fields() {
        // OpenSubsonic ships extras like `played`, `replayGain`, `artists`
        // (contributor list), etc. We don't type them; they must not error.
        let payload = r#"{
            "id": "tr_1",
            "title": "Hello",
            "replayGain": { "trackGain": -1.2, "albumGain": -0.8 },
            "artists": [{ "id": "ar_1", "name": "W" }],
            "contributors": []
        }"#;
        let song: Song = serde_json::from_str(payload).unwrap();
        assert_eq!(song.id, "tr_1");
        assert!(song.artist.is_none());
    }

    #[test]
    fn album_with_songs_round_trips() {
        let payload = r#"{
            "id": "al_1",
            "name": "Test Album",
            "artist": "Artist",
            "artistId": "ar_1",
            "songCount": 2,
            "song": [
                {"id": "tr_1", "title": "One", "track": 1},
                {"id": "tr_2", "title": "Two", "track": 2}
            ]
        }"#;
        let album: Album = serde_json::from_str(payload).unwrap();
        assert_eq!(album.name, "Test Album");
        assert_eq!(album.song.len(), 2);
        assert_eq!(album.song[1].title, "Two");
    }

    #[test]
    fn song_isrc_accepts_opensubsonic_string_array() {
        // OpenSubsonic `isrc` is `string[]`. Navidrome ships `isrc: []`
        // (the album !Brincamos! repro) or a populated array — both must
        // decode, plus the legacy single-string form.
        let empty: Song = serde_json::from_str(r#"{"id":"a","title":"t","isrc":[]}"#).unwrap();
        assert!(empty.isrc.is_none());
        let arr: Song =
            serde_json::from_str(r#"{"id":"a","title":"t","isrc":["USRC17607839"]}"#).unwrap();
        assert_eq!(arr.isrc.as_deref(), Some("USRC17607839"));
        let legacy: Song =
            serde_json::from_str(r#"{"id":"a","title":"t","isrc":"USRC17607839"}"#).unwrap();
        assert_eq!(legacy.isrc.as_deref(), Some("USRC17607839"));
    }

    #[test]
    fn artist_index_parses_last_modified_watermark() {
        let payload = r#"{
            "lastModified": 1716840000000,
            "ignoredArticles": "The El La",
            "index": [
                {"name": "A", "artist": [
                    {"id": "ar_1", "name": "Anna"},
                    {"id": "ar_2", "name": "Alex", "albumCount": 3}
                ]},
                {"name": "B", "artist": []}
            ]
        }"#;
        let ai: ArtistIndex = serde_json::from_str(payload).unwrap();
        assert_eq!(ai.last_modified_ms, Some(1716840000000));
        assert_eq!(ai.index.len(), 2);
        assert_eq!(ai.index[0].artist.len(), 2);
        assert_eq!(ai.index[0].artist[1].album_count, Some(3));
    }

    #[test]
    fn search_result_defaults_empty_lists() {
        // search3 with no hits returns just `{"searchResult3": {}}`.
        let sr: SearchResult = serde_json::from_str("{}").unwrap();
        assert!(sr.artist.is_empty());
        assert!(sr.album.is_empty());
        assert!(sr.song.is_empty());
    }

    #[test]
    fn scan_status_parses_navidrome_shape() {
        let payload = r#"{
            "scanning": false,
            "count": 12345,
            "folderCount": 100,
            "lastScan": "2024-06-01T12:00:00Z"
        }"#;
        let s: ScanStatus = serde_json::from_str(payload).unwrap();
        assert!(!s.scanning);
        assert_eq!(s.count, Some(12345));
        assert_eq!(s.last_scan.as_deref(), Some("2024-06-01T12:00:00Z"));
    }
}
