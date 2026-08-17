use std::collections::{HashMap, HashSet};

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Transaction};

use super::{TrackRepository, TrackRow};
use crate::genre_tags::{self, genres_for_track_raw_json};
use crate::store::WriteOpTiming;

struct TrackGenreState {
    track_id: String,
    raw_json: String,
    genre: Option<String>,
    album_id: Option<String>,
    library_id: Option<String>,
    deleted: bool,
}

fn sync_track_genre_state(
    tx: &Transaction<'_>,
    server_id: &str,
    state: &TrackGenreState,
) -> rusqlite::Result<()> {
    if state.deleted {
        return genre_tags::delete_track_genre_for_track(tx, server_id, &state.track_id);
    }
    let genres = genres_for_track_raw_json(&state.raw_json, state.genre.as_deref());
    genre_tags::replace_track_genre_rows(
        tx,
        server_id,
        &state.track_id,
        state.album_id.as_deref(),
        state.library_id.as_deref(),
        &genres,
    )
}

/// Rebuild the genre projection from the rows SQLite actually committed. This
/// matters for sparse payloads: the upsert may preserve `raw_json` and
/// `library_id`, so projecting the incoming row would immediately disagree
/// with the authoritative stored row.
pub(super) fn sync_persisted_track_genre_rows(
    tx: &Transaction<'_>,
    rows: &[TrackRow],
) -> rusqlite::Result<()> {
    let mut ids_by_server: HashMap<&str, HashSet<&str>> = HashMap::new();
    for row in rows {
        ids_by_server
            .entry(row.server_id.as_str())
            .or_default()
            .insert(row.id.as_str());
    }
    for (server_id, ids) in ids_by_server {
        let ids: Vec<&str> = ids.into_iter().collect();
        for chunk in ids.chunks(400) {
            let placeholders = (2..chunk.len() + 2)
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT id, raw_json, genre, album_id, library_id, deleted FROM track \
                 WHERE server_id = ?1 AND id IN ({placeholders})"
            );
            let mut binds = Vec::with_capacity(chunk.len() + 1);
            binds.push(Value::Text(server_id.to_string()));
            binds.extend(chunk.iter().map(|id| Value::Text((*id).to_string())));
            let persisted: Vec<TrackGenreState> = tx
                .prepare(&sql)?
                .query_map(params_from_iter(binds.iter()), |row| {
                    Ok(TrackGenreState {
                        track_id: row.get(0)?,
                        raw_json: row.get(1)?,
                        genre: row.get(2)?,
                        album_id: row.get(3)?,
                        library_id: row.get(4)?,
                        deleted: row.get::<_, i64>(5)? != 0,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for state in persisted {
                sync_track_genre_state(tx, server_id, &state)?;
            }
        }
    }
    Ok(())
}

impl TrackRepository<'_> {
    /// Batch upsert without remap detection. Suitable for generic
    /// Subsonic servers where `UnstableTrackIds` is clear (track ids
    /// are stable across reindexing). Wrapped in a single transaction.
    pub fn upsert_batch(&self, rows: &[TrackRow]) -> Result<(), String> {
        self.upsert_batch_with_remap(rows, false).map(|_| ())
    }

    /// IS-3 initial-sync fast path: upsert rows only. Skips §6.9 remap
    /// detection and inline canonical linking — both run on delta sync
    /// or in a post-ingest canonical pass so 500-row batches stay fast.
    ///
    /// When `resync_gen` is `Some`, each row is stamped with that
    /// generation so IS-7 can soft-delete stale rows after a successful
    /// full resync.
    pub fn upsert_batch_initial_ingest(&self, rows: &[TrackRow]) -> Result<(), String> {
        self.upsert_batch_initial_ingest_timed(rows, None)
            .map(|_| ())
    }

    pub fn upsert_batch_initial_ingest_timed(
        &self,
        rows: &[TrackRow],
        resync_gen: Option<i64>,
    ) -> Result<WriteOpTiming, String> {
        self.upsert_batch_initial_ingest_timed_with_source(rows, resync_gen, false)
    }

    pub(crate) fn upsert_sparse_batch_initial_ingest_timed(
        &self,
        rows: &[TrackRow],
        resync_gen: Option<i64>,
    ) -> Result<WriteOpTiming, String> {
        self.upsert_batch_initial_ingest_timed_with_source(rows, resync_gen, true)
    }

    fn upsert_batch_initial_ingest_timed_with_source(
        &self,
        rows: &[TrackRow],
        resync_gen: Option<i64>,
        sparse_payload: bool,
    ) -> Result<WriteOpTiming, String> {
        if rows.is_empty() {
            return Ok(WriteOpTiming::default());
        }
        let sql = match resync_gen {
            Some(_) => UPSERT_INITIAL_RESYNC_SQL,
            None => UPSERT_SQL,
        };
        let (_, timing) =
            self.store
                .with_conn_mut_timed("track.upsert_initial_ingest", |conn| {
                    let tx = conn.transaction()?;
                    let affected_album_scopes =
                        crate::browse_projection::collect_affected_album_scopes(&tx, rows)?;
                    let mut upsert = tx.prepare_cached(sql)?;
                    for r in rows {
                        if let Some(gen) = resync_gen {
                            upsert.execute(params![
                                r.server_id,
                                r.id,
                                r.title,
                                r.title_sort,
                                r.artist,
                                r.artist_id,
                                r.album,
                                r.album_id,
                                r.album_artist,
                                r.duration_sec,
                                r.track_number,
                                r.disc_number,
                                r.year,
                                r.genre,
                                r.suffix,
                                r.bit_rate,
                                r.size_bytes,
                                r.cover_art_id,
                                r.starred_at,
                                r.user_rating,
                                r.play_count,
                                r.played_at,
                                r.server_path,
                                r.library_id,
                                r.isrc,
                                r.mbid_recording,
                                r.bpm,
                                r.replay_gain_track_db,
                                r.replay_gain_album_db,
                                r.replay_gain_peak,
                                r.content_hash,
                                r.server_updated_at,
                                r.server_created_at,
                                if r.deleted { 1_i64 } else { 0 },
                                r.synced_at,
                                r.raw_json,
                                gen,
                                if sparse_payload { 1_i64 } else { 0 },
                            ])?;
                        } else {
                            upsert.execute(params![
                                r.server_id,
                                r.id,
                                r.title,
                                r.title_sort,
                                r.artist,
                                r.artist_id,
                                r.album,
                                r.album_id,
                                r.album_artist,
                                r.duration_sec,
                                r.track_number,
                                r.disc_number,
                                r.year,
                                r.genre,
                                r.suffix,
                                r.bit_rate,
                                r.size_bytes,
                                r.cover_art_id,
                                r.starred_at,
                                r.user_rating,
                                r.play_count,
                                r.played_at,
                                r.server_path,
                                r.library_id,
                                r.isrc,
                                r.mbid_recording,
                                r.bpm,
                                r.replay_gain_track_db,
                                r.replay_gain_album_db,
                                r.replay_gain_peak,
                                r.content_hash,
                                r.server_updated_at,
                                r.server_created_at,
                                if r.deleted { 1_i64 } else { 0 },
                                r.synced_at,
                                r.raw_json,
                                if sparse_payload { 1_i64 } else { 0 },
                            ])?;
                        }
                    }
                    drop(upsert);
                    sync_persisted_track_genre_rows(&tx, rows)?;
                    crate::identity::mark_cluster_keys_dirty(
                        &tx,
                        rows.iter().map(|row| row.server_id.as_str()),
                    )?;
                    crate::browse_projection::refresh_album_scopes(&tx, affected_album_scopes)?;
                    tx.commit()?;
                    Ok(())
                })?;
        Ok(timing)
    }
}

pub(super) const UPSERT_SQL: &str = r#"
INSERT INTO track (
  server_id, id, title, title_sort, artist, artist_id, album, album_id,
  album_artist, duration_sec, track_number, disc_number, year, genre, suffix,
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count,
  played_at, server_path, library_id, isrc, mbid_recording, bpm,
  replay_gain_track_db, replay_gain_album_db, replay_gain_peak, content_hash, server_updated_at,
  server_created_at, deleted, synced_at, raw_json
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
  ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32,
  ?33, ?34, ?35, ?36
)
ON CONFLICT(server_id, id) DO UPDATE SET
  title                = excluded.title,
  title_sort           = CASE
    WHEN json_valid(excluded.raw_json)
     AND (json_type(excluded.raw_json, '$.sortTitle') IS NOT NULL
       OR json_type(excluded.raw_json, '$.orderTitle') IS NOT NULL
       OR json_type(excluded.raw_json, '$.sortName') IS NOT NULL)
      THEN excluded.title_sort
    WHEN excluded.title_sort IS NOT NULL THEN excluded.title_sort
    ELSE track.title_sort
  END,
  artist               = excluded.artist,
  artist_id            = excluded.artist_id,
  album                = excluded.album,
  album_id             = excluded.album_id,
  album_artist         = CASE
    WHEN ?37 != 0
     AND json_valid(excluded.raw_json)
     AND (json_type(excluded.raw_json, '$.albumArtist') IS NOT NULL
       OR json_type(excluded.raw_json, '$.displayAlbumArtist') IS NOT NULL)
      THEN excluded.album_artist
    WHEN ?37 != 0 THEN COALESCE(NULLIF(excluded.album_artist, ''), track.album_artist)
    ELSE excluded.album_artist
  END,
  duration_sec         = excluded.duration_sec,
  track_number         = excluded.track_number,
  disc_number          = excluded.disc_number,
  year                 = excluded.year,
  genre                = excluded.genre,
  suffix               = excluded.suffix,
  bit_rate             = excluded.bit_rate,
  size_bytes           = excluded.size_bytes,
  cover_art_id         = excluded.cover_art_id,
  starred_at           = excluded.starred_at,
  user_rating          = excluded.user_rating,
  play_count           = excluded.play_count,
  played_at            = excluded.played_at,
  server_path          = excluded.server_path,
  -- P20: never let a sync path that omits library membership (OpenSubsonic
  -- whole-server search3/getAlbumList2 carry no libraryId) clobber a library_id
  -- previously captured by a scoped / Navidrome-native sync back to NULL —
  -- that silently erases multi-library scope tagging. A non-empty incoming id wins.
  library_id           = COALESCE(NULLIF(excluded.library_id, ''), track.library_id),
  isrc                 = excluded.isrc,
  mbid_recording       = excluded.mbid_recording,
  bpm                  = excluded.bpm,
  replay_gain_track_db = excluded.replay_gain_track_db,
  replay_gain_album_db = excluded.replay_gain_album_db,
  replay_gain_peak     = excluded.replay_gain_peak,
  -- E2: never let a sync (which passes NULL content_hash) clobber the
  -- playback-derived md5_16kb written via library_patch_track / the analysis
  -- bridge. A non-empty incoming hash still wins.
  content_hash         = COALESCE(NULLIF(excluded.content_hash, ''), track.content_hash),
  server_updated_at    = CASE
    WHEN json_valid(excluded.raw_json)
     AND json_type(excluded.raw_json, '$.updatedAt') IS NOT NULL
      THEN excluded.server_updated_at
    WHEN excluded.server_updated_at IS NOT NULL THEN excluded.server_updated_at
    ELSE track.server_updated_at
  END,
  server_created_at    = excluded.server_created_at,
  deleted              = excluded.deleted,
  synced_at            = excluded.synced_at,
  raw_json             = CASE
    WHEN ?37 != 0 AND json_valid(track.raw_json) AND json_valid(excluded.raw_json)
      THEN json_patch(track.raw_json, excluded.raw_json)
    ELSE excluded.raw_json
  END
"#;

const UPSERT_INITIAL_RESYNC_SQL: &str = r#"
INSERT INTO track (
  server_id, id, title, title_sort, artist, artist_id, album, album_id,
  album_artist, duration_sec, track_number, disc_number, year, genre, suffix,
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count,
  played_at, server_path, library_id, isrc, mbid_recording, bpm,
  replay_gain_track_db, replay_gain_album_db, replay_gain_peak, content_hash, server_updated_at,
  server_created_at, deleted, synced_at, raw_json, resync_gen
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
  ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32,
  ?33, ?34, ?35, ?36, ?37
)
ON CONFLICT(server_id, id) DO UPDATE SET
  title                = excluded.title,
  title_sort           = CASE
    WHEN json_valid(excluded.raw_json)
     AND (json_type(excluded.raw_json, '$.sortTitle') IS NOT NULL
       OR json_type(excluded.raw_json, '$.orderTitle') IS NOT NULL
       OR json_type(excluded.raw_json, '$.sortName') IS NOT NULL)
      THEN excluded.title_sort
    WHEN excluded.title_sort IS NOT NULL THEN excluded.title_sort
    ELSE track.title_sort
  END,
  artist               = excluded.artist,
  artist_id            = excluded.artist_id,
  album                = excluded.album,
  album_id             = excluded.album_id,
  album_artist         = CASE
    WHEN ?38 != 0
     AND json_valid(excluded.raw_json)
     AND (json_type(excluded.raw_json, '$.albumArtist') IS NOT NULL
       OR json_type(excluded.raw_json, '$.displayAlbumArtist') IS NOT NULL)
      THEN excluded.album_artist
    WHEN ?38 != 0 THEN COALESCE(NULLIF(excluded.album_artist, ''), track.album_artist)
    ELSE excluded.album_artist
  END,
  duration_sec         = excluded.duration_sec,
  track_number         = excluded.track_number,
  disc_number          = excluded.disc_number,
  year                 = excluded.year,
  genre                = excluded.genre,
  suffix               = excluded.suffix,
  bit_rate             = excluded.bit_rate,
  size_bytes           = excluded.size_bytes,
  cover_art_id         = excluded.cover_art_id,
  starred_at           = excluded.starred_at,
  user_rating          = excluded.user_rating,
  play_count           = excluded.play_count,
  played_at            = excluded.played_at,
  server_path          = excluded.server_path,
  -- P20: preserve prior library_id when a sync path omits it (see UPSERT above).
  library_id           = COALESCE(NULLIF(excluded.library_id, ''), track.library_id),
  isrc                 = excluded.isrc,
  mbid_recording       = excluded.mbid_recording,
  bpm                  = excluded.bpm,
  replay_gain_track_db = excluded.replay_gain_track_db,
  replay_gain_album_db = excluded.replay_gain_album_db,
  replay_gain_peak     = excluded.replay_gain_peak,
  content_hash         = COALESCE(NULLIF(excluded.content_hash, ''), track.content_hash),
  server_updated_at    = CASE
    WHEN json_valid(excluded.raw_json)
     AND json_type(excluded.raw_json, '$.updatedAt') IS NOT NULL
      THEN excluded.server_updated_at
    WHEN excluded.server_updated_at IS NOT NULL THEN excluded.server_updated_at
    ELSE track.server_updated_at
  END,
  server_created_at    = excluded.server_created_at,
  deleted              = 0,
  synced_at            = excluded.synced_at,
  raw_json             = CASE
    WHEN ?38 != 0 AND json_valid(track.raw_json) AND json_valid(excluded.raw_json)
      THEN json_patch(track.raw_json, excluded.raw_json)
    ELSE excluded.raw_json
  END,
  resync_gen           = excluded.resync_gen
"#;
