use rusqlite::{params, OptionalExtension};

use super::{row_to_track_row, TrackRepository, TrackRow};

const SELECT_TRACK_BY_ID: &str = "SELECT server_id, id, title, title_sort, artist, artist_id, \
  album, album_id, album_artist, duration_sec, track_number, disc_number, year, genre, suffix, \
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count, played_at, \
  server_path, library_id, isrc, mbid_recording, bpm, replay_gain_track_db, replay_gain_album_db, replay_gain_peak, \
  content_hash, server_updated_at, server_created_at, deleted, synced_at, raw_json \
  FROM track WHERE server_id = ?1 AND id = ?2 AND deleted = 0";

const SELECT_TRACK_BY_ID_ONLY: &str = "SELECT server_id, id, title, title_sort, artist, artist_id, \
  album, album_id, album_artist, duration_sec, track_number, disc_number, year, genre, suffix, \
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count, played_at, \
  server_path, library_id, isrc, mbid_recording, bpm, replay_gain_track_db, replay_gain_album_db, replay_gain_peak, \
  content_hash, server_updated_at, server_created_at, deleted, synced_at, raw_json \
  FROM track WHERE id = ?1 AND deleted = 0";

const SELECT_TRACKS_BY_ALBUM: &str = "SELECT server_id, id, title, title_sort, artist, artist_id, \
  album, album_id, album_artist, duration_sec, track_number, disc_number, year, genre, suffix, \
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count, played_at, \
  server_path, library_id, isrc, mbid_recording, bpm, replay_gain_track_db, replay_gain_album_db, replay_gain_peak, \
  content_hash, server_updated_at, server_created_at, deleted, synced_at, raw_json \
  FROM track WHERE server_id = ?1 AND album_id = ?2 AND deleted = 0 \
  ORDER BY COALESCE(disc_number, 1) ASC, track_number ASC NULLS LAST, id ASC, server_id ASC";

impl TrackRepository<'_> {
    /// SELECT a single track by `(server_id, id)`. Returns `None`
    /// when missing or deleted (`deleted = 1`). Used by
    /// `library_get_track` and the offline-path command.
    pub fn find_one(&self, server_id: &str, track_id: &str) -> Result<Option<TrackRow>, String> {
        self.store.with_read_conn(|conn| {
            let mut stmt = conn.prepare(SELECT_TRACK_BY_ID)?;
            stmt.query_row(params![server_id, track_id], row_to_track_row)
                .optional()
        })
    }

    /// All live rows for a Subsonic track id (any server). Used when legacy offline
    /// folders name the server by URL index key rather than profile UUID.
    pub fn find_live_by_id(&self, track_id: &str) -> Result<Vec<TrackRow>, String> {
        self.store.with_read_conn(|conn| {
            let mut stmt = conn.prepare(SELECT_TRACK_BY_ID_ONLY)?;
            let rows = stmt
                .query_map(params![track_id], row_to_track_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Batch SELECT — `library_get_tracks_batch`. Caller-supplied refs
    /// preserve their order in the result; unknown / deleted refs
    /// are silently dropped (frontend reads `tracks.length` against
    /// `refs.length` to detect partial responses).
    pub fn find_batch(&self, refs: &[(String, String)]) -> Result<Vec<TrackRow>, String> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        self.store.with_read_conn(|conn| {
            let mut stmt = conn.prepare(SELECT_TRACK_BY_ID)?;
            let mut out: Vec<TrackRow> = Vec::with_capacity(refs.len());
            for (server_id, track_id) in refs {
                if let Some(row) = stmt
                    .query_row(params![server_id, track_id], row_to_track_row)
                    .optional()?
                {
                    out.push(row);
                }
            }
            Ok(out)
        })
    }

    /// SELECT every non-deleted track on this album, ordered by
    /// `COALESCE(disc_number, 1) ASC, track_number ASC, id ASC, server_id ASC` for
    /// stable display. A missing disc number is treated as disc 1 (matching the album
    /// UI's `discNumber ?? 1`). `(id, server_id)` is the final tie-break — shared with
    /// the scoped merge loader, where `id` alone is not globally unique — so the order
    /// is total. This query is single-server, so `server_id` is constant here.
    pub fn find_by_album(&self, server_id: &str, album_id: &str) -> Result<Vec<TrackRow>, String> {
        self.store.with_read_conn(|conn| {
            let mut stmt = conn.prepare(SELECT_TRACKS_BY_ALBUM)?;
            let rows: rusqlite::Result<Vec<TrackRow>> = stmt
                .query_map(params![server_id, album_id], row_to_track_row)?
                .collect();
            rows
        })
    }

    /// Keyset page of track ids for cursor-based library scans (`id ASC`).
    pub fn list_track_ids_after(
        &self,
        server_id: &str,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<String>, String> {
        if limit == 0 {
            return Ok(vec![]);
        }
        let limit = i64::try_from(limit).map_err(|e| e.to_string())?;
        self.store.with_read_conn(|conn| {
            let sql = "SELECT id FROM track \
                       WHERE server_id = ?1 AND deleted = 0 \
                         AND (?2 IS NULL OR id > ?2) \
                       ORDER BY id ASC LIMIT ?3";
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![server_id, after_id, limit], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()
        })
    }

    /// Legacy offline rows keyed by library `server_id` (index key scope).
    pub fn list_offline_local_paths(
        &self,
        server_id: &str,
    ) -> Result<Vec<(String, String, Option<String>)>, String> {
        self.store.with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT track_id, local_path, suffix FROM track_offline WHERE server_id = ?1",
            )?;
            let rows = stmt.query_map(params![server_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    /// Tracks with `content_hash` and an analysis BPM fact — may still lack waveform/LUFS.
    /// Confirmed per id via [`TrackAnalysisNeedsWorkQuery`].
    pub fn list_analysis_hash_bpm_ids_after(
        &self,
        server_id: &str,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<String>, String> {
        if limit == 0 {
            return Ok(vec![]);
        }
        let limit = i64::try_from(limit).map_err(|e| e.to_string())?;
        self.store.with_read_conn(|conn| {
            let sql = "SELECT t.id FROM track t \
                       WHERE t.server_id = ?1 AND t.deleted = 0 \
                         AND (?2 IS NULL OR t.id > ?2) \
                         AND t.content_hash IS NOT NULL \
                         AND EXISTS ( \
                           SELECT 1 FROM track_fact f \
                           WHERE f.server_id = t.server_id \
                             AND f.track_id = t.id \
                             AND f.fact_kind = 'bpm' \
                             AND f.source_kind = 'analysis' \
                         ) \
                       ORDER BY t.id ASC LIMIT ?3";
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![server_id, after_id, limit], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()
        })
    }

    /// Cheap SQL prefilter: tracks that never received a playback hash and/or
    /// lack an oximedia BPM fact. Full analysis gaps are confirmed per id via
    /// [`TrackAnalysisNeedsWorkQuery`] in the shell crate.
    pub fn list_analysis_candidate_ids_after(
        &self,
        server_id: &str,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<String>, String> {
        if limit == 0 {
            return Ok(vec![]);
        }
        let limit = i64::try_from(limit).map_err(|e| e.to_string())?;
        self.store.with_read_conn(|conn| {
            let sql = "SELECT t.id FROM track t \
                       WHERE t.server_id = ?1 AND t.deleted = 0 \
                         AND (?2 IS NULL OR t.id > ?2) \
                         AND ( \
                           t.content_hash IS NULL \
                           OR NOT EXISTS ( \
                             SELECT 1 FROM track_fact f \
                             WHERE f.server_id = t.server_id \
                               AND f.track_id = t.id \
                               AND f.fact_kind = 'bpm' \
                               AND f.source_kind = 'analysis' \
                           ) \
                         ) \
                       ORDER BY t.id ASC LIMIT ?3";
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![server_id, after_id, limit], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()
        })
    }

    /// Count non-deleted tracks for a server (analysis progress baseline).
    pub fn count_live_tracks(&self, server_id: &str) -> Result<i64, String> {
        self.store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM track WHERE server_id = ?1 AND deleted = 0",
                    params![server_id],
                    |row| row.get(0),
                )
            })
            .map_err(|e| e.to_string())
    }

    pub fn count_live_tracks_in_scope(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<i64, String> {
        if library_scope.is_empty() {
            return self.count_live_tracks(server_id);
        }
        self.store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM track \
                     WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0",
                    params![server_id, library_scope],
                    |row| row.get(0),
                )
            })
            .map_err(|e| e.to_string())
    }

    pub fn has_live_tracks_in_scope(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<bool, String> {
        self.store
            .with_read_conn(|conn| {
                if library_scope.is_empty() {
                    conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM track \
                         WHERE server_id = ?1 AND deleted = 0 LIMIT 1)",
                        params![server_id],
                        |row| row.get(0),
                    )
                } else {
                    conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM track \
                         WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0 LIMIT 1)",
                        params![server_id, library_scope],
                        |row| row.get(0),
                    )
                }
            })
            .map_err(|e| e.to_string())
    }
}
