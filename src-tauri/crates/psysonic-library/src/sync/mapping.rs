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

/// The track rows of a `getAlbum` payload, with the album-level OpenSubsonic
/// fields merged into each song via `merge_album_open_subsonic_track_raw`.
///
/// Shared so the two callers cannot drift apart — they already had: the S2
/// crawl passed its library scope and the census did not, which left every
/// gap-filled track with a NULL `library_id` and invisible to scoped browse.
pub fn album_track_rows(
    server_id: &str,
    album: &psysonic_integration::subsonic::Album,
    raw_album: &Value,
    synced_at: i64,
    library_scope: Option<&str>,
) -> Vec<TrackRow> {
    let raw_songs = raw_album
        .get("song")
        .and_then(|songs| songs.as_array())
        .cloned()
        .unwrap_or_default();
    let mut rows = Vec::with_capacity(album.song.len());
    for (index, song) in album.song.iter().enumerate() {
        let mut raw = raw_songs
            .get(index)
            .cloned()
            .unwrap_or_else(|| serde_json::to_value(song).unwrap_or(Value::Null));
        merge_album_open_subsonic_track_raw(raw_album, &mut raw);
        rows.push(subsonic_song_to_track_row(
            server_id,
            song,
            &raw,
            synced_at,
            library_scope,
        ));
    }
    rows
}

/// A typed `Song` is only a fallback when a sparse endpoint did not expose its
/// raw song subtree. Serde serializes absent optional fields as JSON nulls;
/// leaving those in would turn "not observed" into an explicit clear in the
/// sparse upsert contract.
pub(crate) fn sparse_song_raw_fallback(song: &Song) -> Value {
    let mut raw = serde_json::to_value(song).unwrap_or(Value::Null);
    remove_null_fields(&mut raw);
    raw
}

fn remove_null_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|_, child| !child.is_null());
            for child in object.values_mut() {
                remove_null_fields(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                remove_null_fields(item);
            }
        }
        _ => {}
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
        title_sort: string_field(raw_value, "sortTitle")
            .or_else(|| string_field(raw_value, "orderTitle"))
            .or_else(|| string_field(raw_value, "sortName")),
        artist: song.artist.clone(),
        artist_id: song.artist_id.clone(),
        album: song.album.clone().unwrap_or_default(),
        album_id: song.album_id.clone(),
        album_artist: song
            .album_artist
            .clone()
            .or_else(|| string_field(raw_value, "displayAlbumArtist"))
            .or_else(|| string_field(raw_value, "albumArtist")),
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
        library_id: song
            .library_id
            .clone()
            .or_else(|| library_id_fallback.map(String::from)),
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
        server_updated_at: raw_value
            .get("updatedAt")
            .and_then(Value::as_str)
            .and_then(parse_iso_ms_str),
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
        title_sort: string_field(raw, "sortTitle")
            .or_else(|| string_field(raw, "orderTitle"))
            .or_else(|| string_field(raw, "sortName")),
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
        starred_at: raw
            .get("starredAt")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_ms_str),
        user_rating: raw.get("rating").and_then(|v| v.as_i64()),
        play_count: raw.get("playCount").and_then(|v| v.as_i64()),
        played_at: raw
            .get("playedAt")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_ms_str),
        server_path: string_field(raw, "path"),
        library_id,
        isrc: string_field(raw, "isrc"),
        mbid_recording: string_field(raw, "mbzTrackId")
            .or_else(|| string_field(raw, "musicBrainzId")),
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
        .find(|c: char| {
            c == '.'
                || c == 'Z'
                || c == '+'
                || (c == '-' && trimmed.find('T').is_some_and(|t| trimmed[t..].contains(c)))
        })
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
mod tests;
