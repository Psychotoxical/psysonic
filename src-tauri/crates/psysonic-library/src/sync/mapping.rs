//! Subsonic / Navidrome song JSON → `TrackRow`. PR-3b's ingest paths
//! all feed the same upsert API, so the projection happens here once.

use serde_json::Value;

use crate::repos::TrackRow;
use psysonic_integration::subsonic::Song;

/// Project a Subsonic `Song` plus its raw JSON sub-tree into a
/// `TrackRow`. `raw_value` is what `track.raw_json` stores verbatim so
/// OpenSubsonic extensions survive (spec §5.1 / ADR-7).
/// Album-level OpenSubsonic fields copied onto each track `raw_json` during
/// S2/getAlbum ingest, as `(album key, track key)`.
///
/// Most are the same name on both sides. The artist participants are NOT: on an
/// album, `artists`/`displayArtist` describe the *album* artist, while on a track
/// those same names mean the *track* performer. Copying them across unchanged would
/// credit every song of a compilation to the album artist. They map onto the track's
/// album-artist fields instead, which is where the album header reads them from
/// (`deriveAlbumHeaderArtistRefs`).
const ALBUM_TO_TRACK_RAW_KEYS: &[(&str, &str)] = &[
    ("compilation", "compilation"),
    ("isCompilation", "isCompilation"),
    ("releaseTypes", "releaseTypes"),
    ("artists", "albumArtists"),
    ("albumArtists", "albumArtists"),
    ("displayArtist", "displayAlbumArtist"),
    ("displayAlbumArtist", "displayAlbumArtist"),
];

/// Copy album-level OpenSubsonic fields onto each track `raw_json` during S2/getAlbum
/// ingest, so track-grouped album browse can filter compilations and the album header
/// can show individually linkable artists instead of one joined credit string.
///
/// Never overwrites a value the track already carries — the track's own field is more
/// specific — and never writes an explicit null. Entries are applied in order, so the
/// canonical `AlbumID3` spelling (`artists` / `displayArtist`) wins over the defensive
/// `albumArtists` / `displayAlbumArtist` aliases a server might send instead.
///
/// "Already carries" means a usable value, not merely a present key: a server emitting
/// `"albumArtists": null` or `[]` on the song states nothing, and every consumer coerces
/// those back to "absent" anyway. Treating the key as authoritative would drop the
/// authoritative ids sitting in the same `getAlbum` response and push the UI back onto
/// name matching.
pub fn merge_album_open_subsonic_track_raw(raw_album: &Value, raw_song: &mut Value) {
    let Some(obj) = raw_song.as_object_mut() else {
        return;
    };
    for (album_key, track_key) in ALBUM_TO_TRACK_RAW_KEYS {
        if obj.get(*track_key).is_some_and(is_usable_participant_value) {
            continue;
        }
        if let Some(v) = raw_album.get(*album_key) {
            if is_usable_participant_value(v) {
                obj.insert((*track_key).to_string(), v.clone());
            }
        }
    }
}

/// Null, an empty array and an empty/whitespace string all mean "the server said
/// nothing here".
fn is_usable_participant_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Array(items) => !items.is_empty(),
        Value::String(text) => !text.trim().is_empty(),
        _ => true,
    }
}

pub fn subsonic_song_to_track_row(
    server_id: &str,
    song: &Song,
    raw_value: &Value,
    synced_at: i64,
    library_id_fallback: Option<&str>,
) -> TrackRow {
    TrackRow {
        server_id: server_id.to_string(),
        id: song.id.clone(),
        title: song.title.clone(),
        title_sort: None,
        artist: song.artist.clone(),
        artist_id: song.artist_id.clone(),
        album: song.album.clone().unwrap_or_default(),
        album_id: song.album_id.clone(),
        album_artist: song.album_artist.clone(),
        duration_sec: song.duration.unwrap_or(0),
        track_number: song.track_number,
        disc_number: song.disc_number,
        year: song.year,
        genre: song.genre.clone(),
        suffix: song.suffix.clone(),
        bit_rate: song.bit_rate,
        size_bytes: song.size,
        cover_art_id: song.cover_art.clone(),
        starred_at: parse_iso_ms(song.starred.as_deref()),
        user_rating: song.user_rating,
        play_count: song.play_count,
        played_at: parse_iso_ms(song.played.as_deref()),
        server_path: song.path.clone(),
        library_id: song.library_id.clone().or_else(|| library_id_fallback.map(String::from)),
        isrc: song.isrc.clone(),
        mbid_recording: song.mbid_recording.clone(),
        bpm: song.bpm,
        replay_gain_track_db: raw_value
            .get("replayGain")
            .and_then(|rg| rg.get("trackGain"))
            .and_then(|v| v.as_f64()),
        replay_gain_album_db: raw_value
            .get("replayGain")
            .and_then(|rg| rg.get("albumGain"))
            .and_then(|v| v.as_f64()),
        replay_gain_peak: raw_value
            .get("replayGain")
            .and_then(|rg| rg.get("trackPeak"))
            .and_then(|v| v.as_f64()),
        content_hash: None,
        server_updated_at: None,
        server_created_at: raw_value
            .get("created")
            .or_else(|| raw_value.get("createdAt"))
            .and_then(|v| v.as_str())
            .and_then(parse_iso_ms_str),
        deleted: false,
        synced_at,
        raw_json: raw_value.to_string(),
    }
}

/// Project a Navidrome `/api/song` row (native REST shape) into a
/// `TrackRow`. Field names mostly overlap with Subsonic but use
/// snake_case JSON aliases — we read fields by `get(name)` rather
/// than reusing the Subsonic `Song` deserializer so a server-side
/// rename doesn't silently zero out hot columns.
pub fn navidrome_song_to_track_row(
    server_id: &str,
    raw: &Value,
    synced_at: i64,
    library_id_fallback: Option<&str>,
) -> Option<TrackRow> {
    let id = raw.get("id").and_then(|v| v.as_str())?.to_string();
    let title = raw
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let server_updated_at = raw
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .and_then(parse_iso_ms_str);
    let library_id = json_string_field(raw, "libraryId")
        .or_else(|| json_string_field(raw, "library_id"))
        .or_else(|| json_string_field(raw, "musicFolderId"))
        .or_else(|| library_id_fallback.map(String::from));
    Some(TrackRow {
        server_id: server_id.to_string(),
        id,
        title,
        title_sort: string_field(raw, "sortTitle").or_else(|| string_field(raw, "orderTitle")),
        artist: string_field(raw, "artist"),
        artist_id: string_field(raw, "artistId"),
        album: string_field(raw, "album").unwrap_or_default(),
        album_id: string_field(raw, "albumId"),
        album_artist: string_field(raw, "albumArtist"),
        duration_sec: duration_seconds(raw),
        track_number: raw.get("trackNumber").and_then(|v| v.as_i64()),
        disc_number: raw.get("discNumber").and_then(|v| v.as_i64()),
        year: raw.get("year").and_then(|v| v.as_i64()),
        genre: string_field(raw, "genre"),
        suffix: string_field(raw, "suffix"),
        bit_rate: raw.get("bitRate").and_then(|v| v.as_i64()),
        size_bytes: raw.get("size").and_then(|v| v.as_i64()),
        cover_art_id: string_field(raw, "coverArtId").or_else(|| string_field(raw, "coverArt")),
        starred_at: raw.get("starredAt").and_then(|v| v.as_str()).and_then(parse_iso_ms_str),
        user_rating: raw.get("rating").and_then(|v| v.as_i64()),
        play_count: raw.get("playCount").and_then(|v| v.as_i64()),
        played_at: raw.get("playedAt").and_then(|v| v.as_str()).and_then(parse_iso_ms_str),
        server_path: string_field(raw, "path"),
        library_id,
        isrc: string_field(raw, "isrc"),
        mbid_recording: string_field(raw, "mbzTrackId").or_else(|| string_field(raw, "musicBrainzId")),
        bpm: raw.get("bpm").and_then(|v| v.as_i64()),
        replay_gain_track_db: raw.get("rgTrackGain").and_then(|v| v.as_f64()),
        replay_gain_album_db: raw.get("rgAlbumGain").and_then(|v| v.as_f64()),
        replay_gain_peak: raw.get("rgTrackPeak").and_then(|v| v.as_f64()),
        content_hash: None,
        server_updated_at,
        server_created_at: raw
            .get("createdAt")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_ms_str),
        deleted: false,
        synced_at,
        raw_json: raw.to_string(),
    })
}

fn json_string_field(raw: &Value, key: &str) -> Option<String> {
    match raw.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn string_field(raw: &Value, key: &str) -> Option<String> {
    json_string_field(raw, key)
}

/// Navidrome's native API reports seconds as either an integer or a decimal.
/// The local index stores whole seconds, so round rather than silently dropping
/// a valid fractional value to zero.
fn duration_seconds(raw: &Value) -> i64 {
    let seconds = raw.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
    let rounded = seconds.round();
    if rounded.is_finite() && (0.0..=i64::MAX as f64).contains(&rounded) {
        rounded as i64
    } else {
        0
    }
}

fn parse_iso_ms(s: Option<&str>) -> Option<i64> {
    s.and_then(parse_iso_ms_str)
}

/// Lightweight ISO-8601 → epoch-ms parser. Supports the Navidrome /
/// OpenSubsonic shape (`2024-06-01T12:00:00Z` or
/// `2024-06-01T12:00:00.123+02:00`). Falls back to `None` on parse
/// failure — sync code never panics on a bad timestamp.
pub(crate) fn parse_iso_ms_str(s: &str) -> Option<i64> {
    // Strip fractional + timezone before doing the manual parse —
    // SQLite stores starred_at / played_at as integer ms, so we only
    // need second precision rounded up from the offset.
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Accept either `Z`, `+HH:MM`, or no suffix. Reduce to a flat
    // `YYYY-MM-DDTHH:MM:SS` core for parsing — server-side timestamps
    // are already in UTC for Navidrome, and we don't track timezone
    // in the schema column.
    let core = trimmed
        .find(|c: char| c == '.' || c == 'Z' || c == '+' || (c == '-' && trimmed.find('T').is_some_and(|t| trimmed[t..].contains(c))))
        .map(|i| &trimmed[..i])
        .unwrap_or(trimmed);
    let mut parts = core.split(['T', '-', ':']);
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    let hour: i64 = parts.next().unwrap_or("0").parse().ok()?;
    let minute: i64 = parts.next().unwrap_or("0").parse().ok()?;
    let second: i64 = parts.next().unwrap_or("0").parse().ok()?;
    if !(1970..=2100).contains(&year)
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=60).contains(&second)
    {
        return None;
    }
    // Days since 1970-01-01 — Howard Hinnant's civil_from_days inverse.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400; // [0, 399]
    let m = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(seconds.saturating_mul(1000))
}

/// UTC ISO-8601 with `Z` suffix for Subsonic `starred` payloads.
pub(crate) fn format_iso_ms_z(ms: i64) -> Option<String> {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let day_secs = secs.rem_euclid(86_400);
    let hour = day_secs / 3600;
    let minute = (day_secs % 3600) / 60;
    let second = day_secs % 60;
    let (year, month, day) = civil_from_days(days);
    if millis == 0 {
        Some(format!(
            "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
        ))
    } else {
        Some(format!(
            "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
        ))
    }
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mp < 10 { y } else { y + 1 };
    (y as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn format_iso_roundtrips_zulu_suffix() {
        let ms = parse_iso_ms_str("2024-01-01T00:00:00Z").unwrap();
        assert_eq!(format_iso_ms_z(ms).as_deref(), Some("2024-01-01T00:00:00Z"));
    }

    #[test]
    fn parse_iso_handles_zulu_suffix() {
        // 2024-01-01T00:00:00Z = 1704067200000 ms.
        let ms = parse_iso_ms_str("2024-01-01T00:00:00Z").unwrap();
        assert_eq!(ms, 1_704_067_200_000);
    }

    #[test]
    fn parse_iso_handles_fractional_and_offset() {
        let ms = parse_iso_ms_str("2024-01-01T00:00:00.123+02:00").unwrap();
        // Truncated before offset → same epoch-second as Zulu of the
        // wall-clock value. Good enough for the schema's integer-ms
        // column.
        assert_eq!(ms, 1_704_067_200_000);
    }

    #[test]
    fn parse_iso_rejects_garbage() {
        assert!(parse_iso_ms_str("").is_none());
        assert!(parse_iso_ms_str("not-a-date").is_none());
        assert!(parse_iso_ms_str("9999-99-99").is_none());
    }

    #[test]
    fn merge_album_open_subsonic_track_raw_copies_album_flags() {
        let album = json!({ "compilation": true, "releaseTypes": ["Compilation"] });
        let mut song = json!({ "id": "tr_1", "title": "A" });
        merge_album_open_subsonic_track_raw(&album, &mut song);
        assert_eq!(song.get("compilation"), Some(&json!(true)));
        assert_eq!(song.get("releaseTypes"), Some(&json!(["Compilation"])));
    }

    // The album header reads its individually linkable credits from the track's
    // `albumArtists`; without this the header falls back to the joined display string
    // ("Ice Nine Kills feat. Shavo") and cannot link the guest.
    #[test]
    fn merge_album_open_subsonic_track_raw_maps_album_participants_to_album_fields() {
        let album = json!({
            "artists": [{ "id": "ar1", "name": "Ice Nine Kills" }, { "id": "ar2", "name": "Shavo" }],
            "displayArtist": "Ice Nine Kills feat. Shavo",
        });
        let mut song = json!({ "id": "tr_1", "title": "A Work of Art" });
        merge_album_open_subsonic_track_raw(&album, &mut song);
        assert_eq!(
            song.get("albumArtists"),
            Some(&json!([{ "id": "ar1", "name": "Ice Nine Kills" }, { "id": "ar2", "name": "Shavo" }]))
        );
        assert_eq!(
            song.get("displayAlbumArtist"),
            Some(&json!("Ice Nine Kills feat. Shavo"))
        );
        // The track performer fields must stay untouched: on an album these names mean
        // the album artist, so copying them across would credit every song of a
        // compilation to it.
        assert_eq!(song.get("artists"), None);
        assert_eq!(song.get("displayArtist"), None);
    }

    #[test]
    fn merge_album_open_subsonic_track_raw_keeps_track_own_album_artists() {
        let album = json!({ "artists": [{ "id": "ar1", "name": "Album Artist" }] });
        let mut song = json!({
            "id": "tr_1",
            "albumArtists": [{ "id": "ar9", "name": "Track's Own" }],
        });
        merge_album_open_subsonic_track_raw(&album, &mut song);
        assert_eq!(
            song.get("albumArtists"),
            Some(&json!([{ "id": "ar9", "name": "Track's Own" }]))
        );
    }

    // A song that carries the key but no value states nothing; the album's list in the
    // same response is the authoritative one and must not be suppressed by it.
    #[test]
    fn merge_album_open_subsonic_track_raw_fills_null_and_empty_song_participants() {
        let album = json!({
            "artists": [{ "id": "ar1", "name": "Album Artist" }],
            "displayArtist": "Album Artist",
        });
        for empty in [json!(null), json!([])] {
            let mut song = json!({ "id": "tr_1", "albumArtists": empty, "displayAlbumArtist": "" });
            merge_album_open_subsonic_track_raw(&album, &mut song);
            assert_eq!(
                song.get("albumArtists"),
                Some(&json!([{ "id": "ar1", "name": "Album Artist" }]))
            );
            assert_eq!(song.get("displayAlbumArtist"), Some(&json!("Album Artist")));
        }
    }

    #[test]
    fn merge_album_open_subsonic_track_raw_ignores_empty_album_participants() {
        let album = json!({ "artists": [], "displayArtist": "   " });
        let mut song = json!({ "id": "tr_1" });
        merge_album_open_subsonic_track_raw(&album, &mut song);
        assert_eq!(song.get("albumArtists"), None);
        assert_eq!(song.get("displayAlbumArtist"), None);
    }

    #[test]
    fn subsonic_song_maps_hot_columns_and_keeps_raw_json() {
        let raw = json!({
            "id": "tr_1",
            "title": "Hello",
            "artist": "World",
            "albumId": "al_1",
            "duration": 240,
            "track": 3,
            "year": 2024,
            "created": "2024-01-01T00:00:00Z",
            "musicBrainzId": "mb-1",
            "replayGain": { "trackGain": -1.2, "albumGain": -0.8, "trackPeak": 0.91 }
        });
        let song: Song = serde_json::from_value(raw.clone()).unwrap();
        let row = subsonic_song_to_track_row("s1", &song, &raw, 1_000, Some("lib-fb"));
        assert_eq!(row.id, "tr_1");
        assert_eq!(row.album_id.as_deref(), Some("al_1"));
        assert_eq!(row.duration_sec, 240);
        assert_eq!(row.mbid_recording.as_deref(), Some("mb-1"));
        assert_eq!(row.replay_gain_track_db, Some(-1.2));
        assert_eq!(row.replay_gain_album_db, Some(-0.8));
        assert_eq!(row.replay_gain_peak, Some(0.91));
        assert!(row.server_created_at.unwrap_or(0) > 0);
        // Fallback library_id kicks in when the song didn't ship one.
        assert_eq!(row.library_id.as_deref(), Some("lib-fb"));
        assert!(row.raw_json.contains("replayGain"));
    }

    #[test]
    fn navidrome_song_maps_native_field_shape() {
        let raw = json!({
            "id": "tr_1",
            "title": "Hello",
            "artist": "World",
            "artistId": "ar_1",
            "album": "An Album",
            "albumId": "al_1",
            "albumArtist": "World",
            "duration": 240,
            "trackNumber": 3,
            "discNumber": 1,
            "year": 2024,
            "genre": "Ambient",
            "suffix": "flac",
            "bitRate": 1000,
            "size": 32_000_000_i64,
            "path": "World/An Album/03.flac",
            "libraryId": "1",
            "isrc": "USRC17607839",
            "mbzTrackId": "mb-1",
            "bpm": 128,
            "rgTrackGain": -1.2,
            "rgAlbumGain": -0.8,
            "createdAt": "2024-01-01T00:00:00Z",
            "updatedAt": "2024-06-01T00:00:00Z"
        });
        let row = navidrome_song_to_track_row("s1", &raw, 9_999, None).unwrap();
        assert_eq!(row.id, "tr_1");
        assert_eq!(row.track_number, Some(3));
        assert_eq!(row.isrc.as_deref(), Some("USRC17607839"));
        assert_eq!(row.mbid_recording.as_deref(), Some("mb-1"));
        assert_eq!(row.replay_gain_track_db, Some(-1.2));
        assert_eq!(row.library_id.as_deref(), Some("1"));
        assert!(row.server_created_at.unwrap_or(0) > 0);
        assert!(row.server_updated_at.unwrap_or(0) > 0);
    }

    #[test]
    fn navidrome_song_maps_numeric_library_id() {
        let raw = json!({
            "id": "tr_1",
            "title": "Hello",
            "libraryId": 3
        });
        let row = navidrome_song_to_track_row("s1", &raw, 1, None).unwrap();
        assert_eq!(row.library_id.as_deref(), Some("3"));
    }

    #[test]
    fn navidrome_song_rounds_decimal_duration_seconds() {
        let raw = json!({
            "id": "tr_1",
            "title": "Hello",
            "duration": 229.85,
        });

        let row = navidrome_song_to_track_row("s1", &raw, 1, None).unwrap();

        assert_eq!(row.duration_sec, 230);
    }

    #[test]
    fn navidrome_song_skips_rows_without_id() {
        let row = navidrome_song_to_track_row("s1", &json!({"title": "no id"}), 1, None);
        assert!(row.is_none());
    }
}
