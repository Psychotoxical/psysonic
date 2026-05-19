use rusqlite::params;

use crate::store::LibraryStore;

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

pub struct TrackRepository<'a> {
    store: &'a LibraryStore,
}

impl<'a> TrackRepository<'a> {
    pub fn new(store: &'a LibraryStore) -> Self {
        Self { store }
    }

    /// Batch upsert. Wrapped in a single transaction; sync code can call with
    /// chunks of ~500 rows to hit the §5.1 perf target.
    pub fn upsert_batch(&self, rows: &[TrackRow]) -> Result<(), String> {
        if rows.is_empty() {
            return Ok(());
        }
        self.store.with_conn_mut(|conn| {
            let tx = conn.transaction()?;
            {
                let mut stmt = tx.prepare(UPSERT_SQL)?;
                for r in rows {
                    stmt.execute(params![
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
            }
            tx.commit()?;
            Ok(())
        })
    }
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
  content_hash         = excluded.content_hash,
  server_updated_at    = excluded.server_updated_at,
  server_created_at    = excluded.server_created_at,
  deleted              = excluded.deleted,
  synced_at            = excluded.synced_at,
  raw_json             = excluded.raw_json
"#;

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
    fn upsert_inserts_new_rows() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row("s1", "t1", "First"), row("s1", "t2", "Second")])
            .unwrap();
        let count: i64 = store
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
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
            .with_conn(|c| {
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
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
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
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn upsert_populates_fts_via_trigger() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row("s1", "t1", "Aurora Boreal")]).unwrap();
        let fts_hit: i64 = store
            .with_conn(|c| {
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
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track_fts WHERE track_fts MATCH 'old'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let new_hit: i64 = store
            .with_conn(|c| {
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
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(stored, 500);

        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "upsert_batch(500 rows) took {elapsed:?}; AC A3 target is <100ms typical, \
             test fails past 5× that"
        );
    }
}
