use rusqlite::{params, OptionalExtension, Transaction};

use crate::genre_tags::{self, genres_for_track_raw_json};
use crate::store::{LibraryStore, WriteOpTiming};

fn sync_track_genre_row(tx: &Transaction<'_>, row: &TrackRow) -> rusqlite::Result<()> {
    if row.deleted {
        return genre_tags::delete_track_genre_for_track(tx, &row.server_id, &row.id);
    }
    let genres = genres_for_track_raw_json(&row.raw_json, row.genre.as_deref());
    genre_tags::replace_track_genre_rows(
        tx,
        &row.server_id,
        &row.id,
        row.album_id.as_deref(),
        row.library_id.as_deref(),
        &genres,
    )
}

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

pub struct TrackRepository<'a> {
    store: &'a LibraryStore,
}

impl<'a> TrackRepository<'a> {
    pub fn new(store: &'a LibraryStore) -> Self {
        Self { store }
    }

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
        self.upsert_batch_initial_ingest_timed(rows, None).map(|_| ())
    }

    pub fn upsert_batch_initial_ingest_timed(
        &self,
        rows: &[TrackRow],
        resync_gen: Option<i64>,
    ) -> Result<WriteOpTiming, String> {
        if rows.is_empty() {
            return Ok(WriteOpTiming::default());
        }
        let sql = match resync_gen {
            Some(_) => UPSERT_INITIAL_RESYNC_SQL,
            None => UPSERT_SQL,
        };
        let (_, timing) = self.store.with_conn_mut_timed("track.upsert_initial_ingest", |conn| {
            let tx = conn.transaction()?;
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
                        r.content_hash,
                        r.server_updated_at,
                        r.server_created_at,
                        if r.deleted { 1_i64 } else { 0 },
                        r.synced_at,
                        r.raw_json,
                        gen,
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
                        r.content_hash,
                        r.server_updated_at,
                        r.server_created_at,
                        if r.deleted { 1_i64 } else { 0 },
                        r.synced_at,
                        r.raw_json,
                    ])?;
                }
                sync_track_genre_row(&tx, r)?;
            }
            drop(upsert);
            tx.commit()?;
            Ok(())
        })?;
        Ok(timing)
    }

    /// Next generation stamp for a full-resync orphan sweep on this server.
    pub fn next_resync_gen(&self, server_id: &str) -> Result<i64, String> {
        self.store.with_conn("track.next_resync_gen", |c| {
            c.query_row(
                "SELECT COALESCE(MAX(resync_gen), 0) + 1 FROM track WHERE server_id = ?1",
                params![server_id],
                |r| r.get(0),
            )
        })
    }

    /// IS-7 — soft-delete live rows not re-stamped during the active resync.
    pub fn sweep_resync_orphans(&self, server_id: &str, resync_gen: i64) -> Result<u32, String> {
        let now = now_unix_ms();
        let changed = self.store.with_conn_mut("track.sweep_resync_orphans", |c| {
            c.execute(
                "DELETE FROM track_genre \
                 WHERE server_id = ?1 AND track_id IN ( \
                   SELECT id FROM track \
                   WHERE server_id = ?1 AND deleted = 0 AND resync_gen != ?2 \
                 )",
                params![server_id, resync_gen],
            )?;
            c.execute(
                "UPDATE track SET deleted = 1, synced_at = ?3 \
                 WHERE server_id = ?1 AND deleted = 0 AND resync_gen != ?2",
                params![server_id, resync_gen, now],
            )
        })?;
        Ok(changed as u32)
    }

    /// SELECT a single track by `(server_id, id)`. Returns `None`
    /// when missing or deleted (`deleted = 1`). Used by
    /// `library_get_track` and the offline-path command.
    pub fn find_one(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<Option<TrackRow>, String> {
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
    pub fn find_batch(
        &self,
        refs: &[(String, String)],
    ) -> Result<Vec<TrackRow>, String> {
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
    /// `disc_number ASC, track_number ASC` for stable display.
    pub fn find_by_album(
        &self,
        server_id: &str,
        album_id: &str,
    ) -> Result<Vec<TrackRow>, String> {
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
        self.store.with_read_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM track WHERE server_id = ?1 AND deleted = 0",
                params![server_id],
                |row| row.get(0),
            )
        })
        .map_err(|e| e.to_string())
    }

    /// Batch upsert with optional §6.9 id-remap detection. When
    /// `unstable_track_ids` is `true`, each incoming row is checked
    /// against the existing `track` table for a collision via
    /// `content_hash` or `server_path` carrying a different id. On
    /// collision, child tables (`track_offline` and the FK-bound
    /// extension / fact / artifact / canonical_link tables) are
    /// retargeted onto the new id, a `track_id_history` row is
    /// recorded, and the old `track` row is deleted — all inside the
    /// same SQLite transaction so partial remaps can't leak.
    pub fn upsert_batch_with_remap(
        &self,
        rows: &[TrackRow],
        unstable_track_ids: bool,
    ) -> Result<RemapStats, String> {
        if rows.is_empty() {
            return Ok(RemapStats::default());
        }
        self.store.with_conn_mut("track.upsert_batch_remap", |conn| {
            let tx = conn.transaction()?;
            let mut remapped: Vec<RemapEntry> = Vec::new();
            let mut upsert = tx.prepare_cached(UPSERT_SQL)?;
            let mut remap_lookup = if unstable_track_ids {
                Some((
                    tx.prepare_cached(REMAP_LOOKUP_BY_HASH_SQL)?,
                    tx.prepare_cached(REMAP_LOOKUP_BY_PATH_SQL)?,
                ))
            } else {
                None
            };

            for r in rows {
                // Spec §6.9: detect collision BEFORE the upsert so the
                // old id is known. The upsert itself comes next; only
                // then do we retarget children to the new id, since
                // child tables FK→track(server_id, id) and would refuse
                // an UPDATE pointing at an id that doesn't exist yet.
                let detected_old: Option<String> =
                    if let Some((ref mut by_hash, ref mut by_path)) = remap_lookup {
                        detect_remap_target_cached(by_hash, by_path, r)?
                    } else {
                        None
                    };

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
                    r.content_hash,
                    r.server_updated_at,
                    r.server_created_at,
                    if r.deleted { 1_i64 } else { 0 },
                    r.synced_at,
                    r.raw_json,
                ])?;
                sync_track_genre_row(&tx, r)?;

                if let Some(old_id) = detected_old {
                    remap_existing_to_new(
                        &tx,
                        &r.server_id,
                        &old_id,
                        &r.id,
                        r.content_hash.as_deref(),
                        r.server_path.as_deref(),
                        r.synced_at,
                    )?;
                    remapped.push(RemapEntry {
                        server_id: r.server_id.clone(),
                        old_id,
                        new_id: r.id.clone(),
                    });
                }

                // H2 (§5.5A): link this track to its canonical id by its
                // strong key (ISRC, else MBID recording). Inline + O(1);
                // a no-op for tracks that carry neither.
                crate::canonical::link_track(
                    &tx,
                    &r.server_id,
                    &r.id,
                    r.isrc.as_deref(),
                    r.mbid_recording.as_deref(),
                    r.synced_at,
                )?;
            }

            drop(upsert);
            drop(remap_lookup);

            tx.commit()?;
            Ok(RemapStats { remapped })
        })
    }
}

// Two single-column lookups instead of one `OR` across `content_hash`
// and `server_path`. The combined `OR` form could not use the partial
// `idx_track_remap_hash` / `idx_track_remap_path` indexes — SQLite only
// applies a partial index when the query's WHERE provably implies the
// index predicate (`… != ''`), and an `OR` spanning two columns blocks
// the per-branch index plan. The result was a full `track` scan per
// incoming row → O(rows × catalog) on large libraries (observed:
// `upsert_batch_remap exec_ms=162001` on a ~200k-track Navidrome sync).
// Each statement below repeats the index predicate so the planner picks
// the matching partial index (SEARCH, not SCAN); hash wins over path,
// matching §6.9's strong-key priority.
const REMAP_LOOKUP_BY_HASH_SQL: &str = r#"
SELECT id FROM track
 WHERE server_id = ?1
   AND deleted = 0
   AND content_hash IS NOT NULL
   AND content_hash != ''
   AND content_hash = ?2
   AND id != ?3
 LIMIT 1
"#;

const REMAP_LOOKUP_BY_PATH_SQL: &str = r#"
SELECT id FROM track
 WHERE server_id = ?1
   AND deleted = 0
   AND server_path IS NOT NULL
   AND server_path != ''
   AND server_path = ?2
   AND id != ?3
 LIMIT 1
"#;

/// Run the `SELECT old.id` half of §6.9 — returns `Some(old_id)` if a
/// non-deleted row with a different id on this server matches the
/// incoming row's `content_hash` or `server_path`. Hash is the stronger
/// key, so it is checked first.
fn detect_remap_target_cached(
    by_hash: &mut rusqlite::Statement<'_>,
    by_path: &mut rusqlite::Statement<'_>,
    incoming: &TrackRow,
) -> rusqlite::Result<Option<String>> {
    // Empty-string sentinels are *not* eligible — spec §6.9 explicitly
    // excludes them so the file-tree default never collides.
    let hash = incoming.content_hash.as_deref().filter(|s| !s.is_empty());
    let path = incoming.server_path.as_deref().filter(|s| !s.is_empty());

    if let Some(hash) = hash {
        let old = by_hash
            .query_row(params![incoming.server_id, hash, incoming.id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
        if old.is_some() {
            return Ok(old);
        }
    }

    if let Some(path) = path {
        let old = by_path
            .query_row(params![incoming.server_id, path, incoming.id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
        if old.is_some() {
            return Ok(old);
        }
    }

    Ok(None)
}

/// Run the §6.9 retarget half — UPDATE every FK-bound child to the
/// new id, INSERT into `track_id_history`, DELETE the old `track` row.
/// `track_offline` has no FK to `track` (spec §5.14) but still needs
/// its row retargeted so the cached file resolves under the new id.
fn remap_existing_to_new(
    tx: &rusqlite::Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
    content_hash: Option<&str>,
    server_path: Option<&str>,
    remapped_at: i64,
) -> rusqlite::Result<()> {
    for table in [
        "track_offline",
        "track_extension",
        "track_fact",
        "track_artifact",
        "track_canonical_link",
        "play_session",
    ] {
        tx.execute(
            &format!(
                "UPDATE {table} SET track_id = ?1 \
                 WHERE server_id = ?2 AND track_id = ?3"
            ),
            params![new_id, server_id, old_id],
        )?;
    }
    tx.execute(
        "INSERT INTO track_id_history \
         (server_id, old_id, new_id, content_hash, server_path, remapped_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(server_id, old_id) DO UPDATE SET \
           new_id = excluded.new_id, \
           content_hash = excluded.content_hash, \
           server_path = excluded.server_path, \
           remapped_at = excluded.remapped_at",
        params![server_id, old_id, new_id, content_hash, server_path, remapped_at],
    )?;
    tx.execute(
        "DELETE FROM track WHERE server_id = ?1 AND id = ?2",
        params![server_id, old_id],
    )?;
    Ok(())
}

/// Column list mirroring the `track` schema (§5.1) — used by every
/// `SELECT … FROM track` so the row-mapper can index by position.
const TRACK_COLUMNS: &str = "\
  server_id, id, title, title_sort, artist, artist_id, album, album_id, \
  album_artist, duration_sec, track_number, disc_number, year, genre, suffix, \
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count, \
  played_at, server_path, library_id, isrc, mbid_recording, bpm, \
  replay_gain_track_db, replay_gain_album_db, content_hash, server_updated_at, \
  server_created_at, deleted, synced_at, raw_json";

const SELECT_TRACK_BY_ID: &str = "SELECT server_id, id, title, title_sort, artist, artist_id, \
  album, album_id, album_artist, duration_sec, track_number, disc_number, year, genre, suffix, \
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count, played_at, \
  server_path, library_id, isrc, mbid_recording, bpm, replay_gain_track_db, replay_gain_album_db, \
  content_hash, server_updated_at, server_created_at, deleted, synced_at, raw_json \
  FROM track WHERE server_id = ?1 AND id = ?2 AND deleted = 0";

const SELECT_TRACK_BY_ID_ONLY: &str = "SELECT server_id, id, title, title_sort, artist, artist_id, \
  album, album_id, album_artist, duration_sec, track_number, disc_number, year, genre, suffix, \
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count, played_at, \
  server_path, library_id, isrc, mbid_recording, bpm, replay_gain_track_db, replay_gain_album_db, \
  content_hash, server_updated_at, server_created_at, deleted, synced_at, raw_json \
  FROM track WHERE id = ?1 AND deleted = 0";

const SELECT_TRACKS_BY_ALBUM: &str = "SELECT server_id, id, title, title_sort, artist, artist_id, \
  album, album_id, album_artist, duration_sec, track_number, disc_number, year, genre, suffix, \
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count, played_at, \
  server_path, library_id, isrc, mbid_recording, bpm, replay_gain_track_db, replay_gain_album_db, \
  content_hash, server_updated_at, server_created_at, deleted, synced_at, raw_json \
  FROM track WHERE server_id = ?1 AND album_id = ?2 AND deleted = 0 \
  ORDER BY disc_number ASC NULLS LAST, track_number ASC NULLS LAST, id ASC";

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
        content_hash: row.get(29)?,
        server_updated_at: row.get(30)?,
        server_created_at: row.get(31)?,
        deleted: row.get::<_, i64>(32)? != 0,
        synced_at: row.get(33)?,
        raw_json: row.get(34)?,
    })
}

const UPSERT_SQL: &str = r#"
INSERT INTO track (
  server_id, id, title, title_sort, artist, artist_id, album, album_id,
  album_artist, duration_sec, track_number, disc_number, year, genre, suffix,
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count,
  played_at, server_path, library_id, isrc, mbid_recording, bpm,
  replay_gain_track_db, replay_gain_album_db, content_hash, server_updated_at,
  server_created_at, deleted, synced_at, raw_json
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
  ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32,
  ?33, ?34, ?35
)
ON CONFLICT(server_id, id) DO UPDATE SET
  title                = excluded.title,
  title_sort           = excluded.title_sort,
  artist               = excluded.artist,
  artist_id            = excluded.artist_id,
  album                = excluded.album,
  album_id             = excluded.album_id,
  album_artist         = excluded.album_artist,
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
  library_id           = excluded.library_id,
  isrc                 = excluded.isrc,
  mbid_recording       = excluded.mbid_recording,
  bpm                  = excluded.bpm,
  replay_gain_track_db = excluded.replay_gain_track_db,
  replay_gain_album_db = excluded.replay_gain_album_db,
  -- E2: never let a sync (which passes NULL content_hash) clobber the
  -- playback-derived md5_16kb written via library_patch_track / the analysis
  -- bridge. A non-empty incoming hash still wins.
  content_hash         = COALESCE(NULLIF(excluded.content_hash, ''), track.content_hash),
  server_updated_at    = excluded.server_updated_at,
  server_created_at    = excluded.server_created_at,
  deleted              = excluded.deleted,
  synced_at            = excluded.synced_at,
  raw_json             = excluded.raw_json
"#;

const UPSERT_INITIAL_RESYNC_SQL: &str = r#"
INSERT INTO track (
  server_id, id, title, title_sort, artist, artist_id, album, album_id,
  album_artist, duration_sec, track_number, disc_number, year, genre, suffix,
  bit_rate, size_bytes, cover_art_id, starred_at, user_rating, play_count,
  played_at, server_path, library_id, isrc, mbid_recording, bpm,
  replay_gain_track_db, replay_gain_album_db, content_hash, server_updated_at,
  server_created_at, deleted, synced_at, raw_json, resync_gen
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
  ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32,
  ?33, ?34, ?35, ?36
)
ON CONFLICT(server_id, id) DO UPDATE SET
  title                = excluded.title,
  title_sort           = excluded.title_sort,
  artist               = excluded.artist,
  artist_id            = excluded.artist_id,
  album                = excluded.album,
  album_id             = excluded.album_id,
  album_artist         = excluded.album_artist,
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
  library_id           = excluded.library_id,
  isrc                 = excluded.isrc,
  mbid_recording       = excluded.mbid_recording,
  bpm                  = excluded.bpm,
  replay_gain_track_db = excluded.replay_gain_track_db,
  replay_gain_album_db = excluded.replay_gain_album_db,
  content_hash         = COALESCE(NULLIF(excluded.content_hash, ''), track.content_hash),
  server_updated_at    = excluded.server_updated_at,
  server_created_at    = excluded.server_created_at,
  deleted              = 0,
  synced_at            = excluded.synced_at,
  raw_json             = excluded.raw_json,
  resync_gen           = excluded.resync_gen
"#;

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(server: &str, id: &str, title: &str) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: Some("The Artist".into()),
            artist_id: Some("ar1".into()),
            album: "An Album".into(),
            album_id: Some("al1".into()),
            album_artist: Some("The Artist".into()),
            duration_sec: 240,
            track_number: Some(3),
            disc_number: Some(1),
            year: Some(2024),
            genre: Some("Ambient".into()),
            suffix: Some("flac".into()),
            bit_rate: Some(1000),
            size_bytes: Some(32_000_000),
            cover_art_id: Some("cv1".into()),
            starred_at: None,
            user_rating: None,
            play_count: Some(0),
            played_at: None,
            server_path: Some("Artist/Album/03.flac".into()),
            library_id: Some("lib-1".into()),
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            content_hash: Some("hash-abc".into()),
            server_updated_at: Some(1_700_000_000),
            server_created_at: Some(1_699_000_000),
            deleted: false,
            synced_at: 1_700_000_500,
            raw_json: r#"{"id":"t1"}"#.into(),
        }
    }

    #[test]
    fn resync_upsert_stamps_generation_and_sweep_deletes_stale_rows() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch_initial_ingest_timed(&[row("s1", "seen", "Seen")], Some(2))
            .unwrap();
        store
            .with_conn_mut("misc", |c| {
                c.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, resync_gen) \
                     VALUES ('s1', 'orphan', 'Orphan', 'Al', 1, 0, 1, '{}', 1)",
                    [],
                )
            })
            .unwrap();

        assert_eq!(repo.sweep_resync_orphans("s1", 2).unwrap(), 1);

        let live: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track WHERE server_id = 's1' AND deleted = 0",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(live, 1);

        let orphan_deleted: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT deleted FROM track WHERE id = 'orphan'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(orphan_deleted, 1);
    }

    #[test]
    fn resync_does_not_clobber_playback_content_hash() {
        // E2 safety property: a sync (which passes content_hash = None) must
        // never wipe the playback-derived md5 written via patch / the bridge.
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);

        let mut initial = row("s1", "t1", "First");
        initial.content_hash = None;
        repo.upsert_batch(&[initial]).unwrap();

        // Playback records the content fingerprint.
        store
            .with_conn("misc", |c| {
                c.execute(
                    "UPDATE track SET content_hash = 'playback-md5' WHERE server_id='s1' AND id='t1'",
                    [],
                )
            })
            .unwrap();

        let read = |store: &LibraryStore| -> Option<String> {
            store
                .with_conn("misc", |c| {
                    c.query_row(
                        "SELECT content_hash FROM track WHERE server_id='s1' AND id='t1'",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap()
        };

        // Resync with a NULL hash preserves the playback value.
        let mut resync = row("s1", "t1", "First (resynced)");
        resync.content_hash = None;
        repo.upsert_batch(&[resync]).unwrap();
        assert_eq!(read(&store).as_deref(), Some("playback-md5"));

        // A non-empty incoming hash still wins.
        let mut with_hash = row("s1", "t1", "First");
        with_hash.content_hash = Some("server-hash".into());
        repo.upsert_batch(&[with_hash]).unwrap();
        assert_eq!(read(&store).as_deref(), Some("server-hash"));
    }

    #[test]
    fn upsert_inserts_new_rows() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row("s1", "t1", "First"), row("s1", "t2", "Second")])
            .unwrap();
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn upsert_updates_existing_rows() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row("s1", "t1", "Original")]).unwrap();

        let mut updated = row("s1", "t1", "Updated");
        updated.bpm = Some(128);
        updated.starred_at = Some(1_700_000_999);
        repo.upsert_batch(&[updated]).unwrap();

        let (title, bpm, starred): (String, Option<i64>, Option<i64>) = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT title, bpm, starred_at FROM track WHERE server_id='s1' AND id='t1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap();
        assert_eq!(title, "Updated");
        assert_eq!(bpm, Some(128));
        assert_eq!(starred, Some(1_700_000_999));

        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 1, "upsert must not duplicate the row");
    }

    #[test]
    fn upsert_empty_batch_is_noop() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[]).unwrap();
    }

    #[test]
    fn upsert_keeps_server_scope_separate() {
        // Same `id` on two different servers must produce two rows
        // (PRIMARY KEY is composite).
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row("s1", "t1", "From S1"), row("s2", "t1", "From S2")])
            .unwrap();
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn upsert_populates_fts_via_trigger() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row("s1", "t1", "Aurora Boreal")]).unwrap();
        let fts_hit: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track_fts WHERE track_fts MATCH 'aurora'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(fts_hit, 1);
    }

    #[test]
    fn upsert_update_refreshes_fts_via_trigger() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row("s1", "t1", "Old Title")]).unwrap();
        repo.upsert_batch(&[row("s1", "t1", "Brand New Title")]).unwrap();

        let old_hit: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track_fts WHERE track_fts MATCH 'old'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let new_hit: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track_fts WHERE track_fts MATCH 'brand'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(old_hit, 0, "delete-trigger must drop the stale FTS row");
        assert_eq!(new_hit, 1);
    }

    #[test]
    fn initial_ingest_batch_skips_remap_and_canonical() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        let rows: Vec<TrackRow> = (0..500)
            .map(|i| {
                let mut r = row("s1", &format!("t{i:04}"), &format!("Track {i:04}"));
                r.server_path = Some(format!("/music/track{i:04}.flac"));
                r.isrc = Some(format!("USRC{i:06}"));
                r.raw_json = format!(r#"{{"id":"t{i:04}","payload":"#)
                    + &"x".repeat(512)
                    + r#""}"#;
                r
            })
            .collect();
        let start = std::time::Instant::now();
        repo.upsert_batch_initial_ingest(&rows).unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(1000),
            "initial ingest batch(500) took {elapsed:?}; includes per-row track_genre \
             maintenance and large raw_json payloads"
        );
    }

    #[test]
    fn upsert_500_rows_completes_well_under_perf_budget() {
        // Spec §5.1 / AC A3: `upsert_batch` should land 500 rows under 100ms
        // typical. The CI threshold is 5× that to absorb slow runners and
        // the difference between debug and release; any regression past it
        // is real signal.
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        let rows: Vec<TrackRow> = (0..500)
            .map(|i| row("s1", &format!("t{i:04}"), &format!("Track {i:04}")))
            .collect();

        let start = std::time::Instant::now();
        repo.upsert_batch(&rows).unwrap();
        let elapsed = start.elapsed();

        let stored: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(stored, 500);

        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "upsert_batch(500 rows) took {elapsed:?}; AC A3 target is <100ms typical, \
             test fails past 5× that"
        );
    }

    // ── PR-3b: §6.9 id remap detection ────────────────────────────────────

    fn row_with_id_hash(server: &str, id: &str, hash: &str, path: &str) -> TrackRow {
        let mut r = row(server, id, "Title");
        r.content_hash = if hash.is_empty() { None } else { Some(hash.into()) };
        r.server_path = if path.is_empty() { None } else { Some(path.into()) };
        r
    }

    #[test]
    fn remap_disabled_never_records_history_even_on_hash_collision() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row_with_id_hash("s1", "tr_old", "deadbeef", "")])
            .unwrap();

        // Generic Subsonic path: caller passes `unstable_track_ids = false`.
        let stats = repo
            .upsert_batch_with_remap(
                &[row_with_id_hash("s1", "tr_new", "deadbeef", "")],
                false,
            )
            .unwrap();
        assert!(stats.remapped.is_empty());

        let track_count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        let hist_count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track_id_history", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(track_count, 2, "both ids coexist when remap is off");
        assert_eq!(hist_count, 0);
    }

    #[test]
    fn remap_via_content_hash_replaces_old_row_and_records_history() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        // Seed with the old id; child tables get a row each that must
        // follow the remap.
        repo.upsert_batch(&[row_with_id_hash("s1", "tr_old", "deadbeef", "/path/x.flac")])
            .unwrap();
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO track_offline \
                     (server_id, track_id, local_path, cached_at) \
                     VALUES ('s1', 'tr_old', '/local/x.flac', 1)",
                    [],
                )?;
                c.execute(
                    "INSERT INTO track_extension \
                     (server_id, track_id, kind, payload, updated_at) \
                     VALUES ('s1', 'tr_old', 'user_note', X'7B7D', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let stats = repo
            .upsert_batch_with_remap(
                &[row_with_id_hash("s1", "tr_new", "deadbeef", "/path/x.flac")],
                true,
            )
            .unwrap();
        assert_eq!(stats.remapped.len(), 1);
        assert_eq!(stats.remapped[0].old_id, "tr_old");
        assert_eq!(stats.remapped[0].new_id, "tr_new");

        // Old track row gone, new one in place.
        let ids: Vec<String> = store
            .with_conn("misc", |c| {
                let mut stmt = c.prepare("SELECT id FROM track WHERE server_id = 's1'")?;
                let r: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();
                r
            })
            .unwrap();
        assert_eq!(ids, vec!["tr_new"]);

        // Child tables follow the new id.
        let offline_id: String = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT track_id FROM track_offline WHERE server_id = 's1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(offline_id, "tr_new");
        let ext_id: String = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT track_id FROM track_extension WHERE server_id = 's1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(ext_id, "tr_new");

        // History row recorded.
        let hist = crate::repos::TrackIdHistoryRepository::new(&store);
        assert_eq!(
            hist.lookup_new_id("s1", "tr_old").unwrap().as_deref(),
            Some("tr_new")
        );
    }

    #[test]
    fn remap_via_server_path_only_works_when_hash_missing() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row_with_id_hash("s1", "tr_old", "", "/path/y.mp3")])
            .unwrap();
        // Server only ships server_path on the new row — no hash yet.
        let stats = repo
            .upsert_batch_with_remap(
                &[row_with_id_hash("s1", "tr_new", "", "/path/y.mp3")],
                true,
            )
            .unwrap();
        assert_eq!(stats.remapped.len(), 1, "path-based remap must trigger");
    }

    #[test]
    fn remap_skips_when_neither_hash_nor_path_present() {
        // Defensive: empty-string sentinels must not cause spurious
        // remaps across unrelated rows that happen to lack hash + path.
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row_with_id_hash("s1", "tr_old", "", "")]).unwrap();
        let stats = repo
            .upsert_batch_with_remap(&[row_with_id_hash("s1", "tr_new", "", "")], true)
            .unwrap();
        assert!(stats.remapped.is_empty());
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 2, "both rows kept; identity-less rows can't shadow");
    }

    #[test]
    fn remap_lookup_uses_partial_indexes_not_full_scan() {
        // Regression: the §6.9 remap lookup must hit
        // idx_track_remap_hash / idx_track_remap_path. The prior
        // `OR`-based query fell back to a full `track` scan on every
        // incoming row → O(rows × catalog) stalls on large libraries
        // (`upsert_batch_remap exec_ms=162001` on a ~200k Navidrome sync).
        let store = LibraryStore::open_in_memory();
        let plan = |sql: &str| -> String {
            store
                .with_conn("misc", |c| {
                    let mut stmt = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                    let rows: rusqlite::Result<Vec<String>> = stmt
                        .query_map(params!["s1", "v", "id"], |r| r.get::<_, String>(3))?
                        .collect();
                    rows
                })
                .unwrap()
                .join("\n")
        };

        let hash_plan = plan(REMAP_LOOKUP_BY_HASH_SQL);
        assert!(
            hash_plan.contains("idx_track_remap_hash"),
            "hash lookup must use idx_track_remap_hash, got: {hash_plan}"
        );
        assert!(
            !hash_plan.contains("SCAN"),
            "hash lookup must not full-scan track, got: {hash_plan}"
        );

        let path_plan = plan(REMAP_LOOKUP_BY_PATH_SQL);
        assert!(
            path_plan.contains("idx_track_remap_path"),
            "path lookup must use idx_track_remap_path, got: {path_plan}"
        );
        assert!(
            !path_plan.contains("SCAN"),
            "path lookup must not full-scan track, got: {path_plan}"
        );
    }

    #[test]
    fn remap_is_noop_when_new_id_matches_existing_id() {
        // Standard delta-sync: same id, same hash. Must not trigger
        // remap (SELECT excludes id = T.id).
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row_with_id_hash("s1", "tr_1", "h", "/p")]).unwrap();
        let stats = repo
            .upsert_batch_with_remap(&[row_with_id_hash("s1", "tr_1", "h", "/p")], true)
            .unwrap();
        assert!(stats.remapped.is_empty());
    }

    // ── H2: canonical linking on the upsert path (§5.5A) ───────────────

    #[test]
    fn upsert_links_track_to_canonical_by_isrc() {
        let store = LibraryStore::open_in_memory();
        let mut r = row("s1", "t1", "Title");
        r.isrc = Some("USRC100".into());
        TrackRepository::new(&store).upsert_batch(&[r]).unwrap();
        let cid: Option<String> = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT canonical_id FROM track_canonical_link \
                     WHERE server_id='s1' AND track_id='t1'",
                    [],
                    |r| r.get(0),
                )
                .optional()
            })
            .unwrap();
        assert_eq!(cid.as_deref(), Some("isrc:USRC100"));
    }

    #[test]
    fn upsert_shares_canonical_across_servers_with_same_isrc() {
        let store = LibraryStore::open_in_memory();
        let mut a = row("s1", "t1", "T");
        a.isrc = Some("USRC200".into());
        let mut b = row("s2", "t9", "T");
        b.isrc = Some("USRC200".into());
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let distinct: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(DISTINCT canonical_id) FROM track_canonical_link",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(distinct, 1, "same ISRC on two servers → one canonical id");
    }

    #[test]
    fn upsert_without_strong_key_creates_no_canonical_link() {
        let store = LibraryStore::open_in_memory();
        // `row(...)` leaves isrc / mbid_recording as None.
        TrackRepository::new(&store)
            .upsert_batch(&[row("s1", "t1", "T")])
            .unwrap();
        let count: i64 = store
            .with_conn("misc", |c| {
                c.query_row("SELECT COUNT(*) FROM track_canonical_link", [], |r| r.get(0))
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn list_track_ids_after_pages_in_id_order() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        for id in ["a1", "b2", "c3"] {
            let mut r = row("s1", id, id);
            r.content_hash = None;
            repo.upsert_batch(&[r]).unwrap();
        }
        let first = repo.list_track_ids_after("s1", None, 2).unwrap();
        assert_eq!(first, vec!["a1", "b2"]);
        let second = repo.list_track_ids_after("s1", Some("b2"), 2).unwrap();
        assert_eq!(second, vec!["c3"]);
    }

    #[test]
    fn list_analysis_candidate_ids_skips_tracks_with_bpm_fact() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        let mut needs = row("s1", "needs", "Needs");
        needs.content_hash = None;
        repo.upsert_batch(&[needs, row("s1", "done", "Done")]).unwrap();
        store
            .with_conn_mut("misc", |c| {
                c.execute(
                    "INSERT INTO track_fact (server_id, track_id, fact_kind, source_kind, source_id, confidence, fetched_at) \
                     VALUES ('s1', 'done', 'bpm', 'analysis', 'oximedia-60s-center', 1.0, 1)",
                    [],
                )
            })
            .unwrap();
        let ids = repo
            .list_analysis_candidate_ids_after("s1", None, 10)
            .unwrap();
        assert_eq!(ids, vec!["needs"]);
    }
}
