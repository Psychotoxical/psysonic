/// One row of the `track` table — every hot column from spec §5.1 plus
/// `raw_json` (the full normalized SubsonicSong). Sync code (PR-2/PR-3) is
/// expected to project ingested payloads into this shape, not to talk SQL
/// directly.
#[derive(Debug, Clone)]
pub struct TrackRow {
    pub server_id: String,
    pub id: String,
    pub title: String,
    pub title_sort: Option<String>,
    pub artist: Option<String>,
    pub artist_id: Option<String>,
    pub album: String,
    pub album_id: Option<String>,
    pub album_artist: Option<String>,
    pub duration_sec: i64,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub suffix: Option<String>,
    pub bit_rate: Option<i64>,
    pub size_bytes: Option<i64>,
    pub cover_art_id: Option<String>,
    pub starred_at: Option<i64>,
    pub user_rating: Option<i64>,
    pub play_count: Option<i64>,
    pub played_at: Option<i64>,
    pub server_path: Option<String>,
    pub library_id: Option<String>,
    pub isrc: Option<String>,
    pub mbid_recording: Option<String>,
    pub bpm: Option<i64>,
    pub replay_gain_track_db: Option<f64>,
    pub replay_gain_album_db: Option<f64>,
    pub replay_gain_peak: Option<f64>,
    pub content_hash: Option<String>,
    pub server_updated_at: Option<i64>,
    pub server_created_at: Option<i64>,
    pub deleted: bool,
    pub synced_at: i64,
    pub raw_json: String,
}

/// One detected remap during an upsert batch. Sync code can use this
/// to emit `library:tracks-changed { remapped: [{from, to}] }` (spec
/// §6.9) so the UI can refresh open per-track views.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemapEntry {
    pub server_id: String,
    pub old_id: String,
    pub new_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct RemapStats {
    pub remapped: Vec<RemapEntry>,
}

/// Column list mirroring the `track` schema (§5.1) — used by every
/// `SELECT … FROM track` so the row-mapper can index by position.
const TRACK_COLUMNS: &str = "\
  server_id, id, title, title_sort, artist, artist_id, album, album_id, \
  album_artist, duration_sec, track_number, disc_number, year, genre, suffix, \
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count, \
  played_at, server_path, library_id, isrc, mbid_recording, bpm, \
  replay_gain_track_db, replay_gain_album_db, replay_gain_peak, content_hash, server_updated_at, \
  server_created_at, deleted, synced_at, raw_json";

pub(crate) fn track_columns() -> &'static str {
    TRACK_COLUMNS
}

pub(crate) fn row_to_track_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrackRow> {
    Ok(TrackRow {
        server_id: row.get(0)?,
        id: row.get(1)?,
        title: row.get(2)?,
        title_sort: row.get(3)?,
        artist: row.get(4)?,
        artist_id: row.get(5)?,
        album: row.get(6)?,
        album_id: row.get(7)?,
        album_artist: row.get(8)?,
        duration_sec: row.get(9)?,
        track_number: row.get(10)?,
        disc_number: row.get(11)?,
        year: row.get(12)?,
        genre: row.get(13)?,
        suffix: row.get(14)?,
        bit_rate: row.get(15)?,
        size_bytes: row.get(16)?,
        cover_art_id: row.get(17)?,
        starred_at: row.get(18)?,
        user_rating: row.get(19)?,
        play_count: row.get(20)?,
        played_at: row.get(21)?,
        server_path: row.get(22)?,
        library_id: row.get(23)?,
        isrc: row.get(24)?,
        mbid_recording: row.get(25)?,
        bpm: row.get(26)?,
        replay_gain_track_db: row.get(27)?,
        replay_gain_album_db: row.get(28)?,
        replay_gain_peak: row.get(29)?,
        content_hash: row.get(30)?,
        server_updated_at: row.get(31)?,
        server_created_at: row.get(32)?,
        deleted: row.get::<_, i64>(33)? != 0,
        synced_at: row.get(34)?,
        raw_json: row.get(35)?,
    })
}
