//! `artist` table — browse index rows from `getArtists` and track-derived backfill.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension, Transaction};

use crate::artist_sort::{ignored_articles_or_default, sort_key_for_display_name};
use crate::store::LibraryStore;
use psysonic_integration::subsonic::ArtistIndex;

pub struct ArtistRepository<'a> {
    store: &'a LibraryStore,
}

impl<'a> ArtistRepository<'a> {
    pub fn new(store: &'a LibraryStore) -> Self {
        Self { store }
    }

    /// Upsert artists from a Subsonic `getArtists` / `getIndexes` body.
    pub fn upsert_index(
        &self,
        server_id: &str,
        index: &ArtistIndex,
        synced_at: i64,
    ) -> Result<u32, String> {
        let ignored = ignored_articles_or_default(index.ignored_articles.as_deref());
        let mut count = 0u32;
        self.store.with_conn_mut("artist.upsert_index", |conn| {
            let tx = conn.transaction()?;
            let mut changed_identity = HashSet::new();
            let mut previous_name = tx.prepare_cached(
                "SELECT name FROM artist WHERE server_id = ?1 AND id = ?2",
            )?;
            for bucket in &index.index {
                for artist in &bucket.artist {
                    let previous = previous_name
                        .query_row(params![server_id, artist.id], |row| row.get::<_, String>(0))
                        .optional()?;
                    if previous.as_deref() != Some(artist.name.as_str()) {
                        changed_identity.insert(artist.id.as_str());
                    }
                    let name_sort = sort_key_for_display_name(&artist.name, ignored);
                    upsert_artist_row(
                        &tx,
                        server_id,
                        &artist.id,
                        &artist.name,
                        &name_sort,
                        artist.album_count,
                        synced_at,
                    )?;
                    count += 1;
                }
            }
            drop(previous_name);
            crate::identity::record_artists(&tx, server_id, changed_identity)?;
            tx.commit()?;
            Ok(())
        })?;
        Ok(count)
    }

    /// Materialize missing `artist` rows from synced tracks (pre-pass backfill).
    pub fn backfill_from_tracks(
        &self,
        server_id: &str,
        ignored_articles: &str,
        synced_at: i64,
    ) -> Result<u32, String> {
        let rows: Vec<(String, String)> = self
            .store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT artist_id, MAX(artist) \
                     FROM track \
                     WHERE server_id = ?1 AND deleted = 0 \
                       AND artist_id IS NOT NULL AND artist_id != '' \
                       AND artist IS NOT NULL AND artist != '' \
                       AND NOT EXISTS ( \
                         SELECT 1 FROM artist ar \
                         WHERE ar.server_id = track.server_id AND ar.id = track.artist_id \
                       ) \
                     GROUP BY artist_id",
                )?;
                let collected = stmt
                    .query_map(params![server_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(collected)
            })
            .map_err(|e| e.to_string())?;

        if rows.is_empty() {
            return Ok(0);
        }

        let mut count = 0u32;
        self.store.with_conn_mut("artist.backfill_from_tracks", |conn| {
            let tx = conn.transaction()?;
            for (id, name) in &rows {
                let name_sort = sort_key_for_display_name(name, ignored_articles);
                upsert_artist_row(&tx, server_id, id, name, &name_sort, None, synced_at)?;
                count += 1;
            }
            crate::identity::record_artists(
                &tx,
                server_id,
                rows.iter().map(|(id, _)| id.as_str()),
            )?;
            tx.commit()?;
            Ok(())
        })?;
        Ok(count)
    }

    /// One-time repair: fill `name_sort` where null (upgrade path).
    /// Resolve credit names to indexed artist ids, positionally aligned with `names`.
    ///
    /// Used to make the individual artists of a joined credit ("A feat. B") clickable
    /// when the server sent no structured participant list: the split-out names carry
    /// no id, but the artist rows are already in the index. Matching goes through the
    /// persisted `name_fold` column (the same `trim().to_lowercase()` fold the upsert
    /// writes), so it uses `idx_artist_name_fold` and tolerates case differences
    /// between a track tag and the artist row.
    ///
    /// A name with no artist row resolves to `None` — the caller renders it as plain
    /// text. When several rows share a fold, the one that heads albums wins, then the
    /// lowest id, so repeated calls are stable.
    pub fn resolve_ids_by_name(
        &self,
        server_id: &str,
        names: &[String],
    ) -> Result<Vec<Option<String>>, String> {
        let server_id = server_id.trim();
        if server_id.is_empty() || names.is_empty() {
            return Ok(vec![None; names.len()]);
        }
        self.store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(
                    // `COALESCE(album_count, 0) DESC` first: a row reporting 0 albums
                    // is as useless a link target as a NULL one, so ordering only on
                    // "IS NULL" would let an empty artist page win over a real
                    // discography. `id` keeps it deterministic among equals.
                    "SELECT id FROM artist \
                     WHERE server_id = ?1 AND name_fold = psysonic_lower_name(?2) \
                     ORDER BY COALESCE(album_count, 0) DESC, id ASC LIMIT 1",
                )?;
                let mut out = Vec::with_capacity(names.len());
                for name in names {
                    if name.trim().is_empty() {
                        out.push(None);
                        continue;
                    }
                    out.push(
                        stmt.query_row(params![server_id, name], |row| row.get::<_, String>(0))
                            .optional()?,
                    );
                }
                Ok(out)
            })
            .map_err(|e| e.to_string())
    }

    pub fn backfill_null_name_sort(&self, ignored_articles: &str) -> Result<u32, String> {
        let rows: Vec<(String, String, String)> = self
            .store
            .with_read_conn(|conn| {
                let mut stmt =
                    conn.prepare("SELECT server_id, id, name FROM artist WHERE name_sort IS NULL")?;
                let collected = stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(collected)
            })
            .map_err(|e| e.to_string())?;

        if rows.is_empty() {
            return Ok(0);
        }

        let mut count = 0u32;
        self.store.with_conn_mut("artist.backfill_null_name_sort", |conn| {
            let tx = conn.transaction()?;
            for (server_id, id, name) in &rows {
                let name_sort = sort_key_for_display_name(name, ignored_articles);
                tx.execute(
                    "UPDATE artist SET name_sort = ?1 WHERE server_id = ?2 AND id = ?3",
                    params![name_sort, server_id, id],
                )?;
                count += 1;
            }
            tx.commit()?;
            Ok(())
        })?;
        Ok(count)
    }
}

fn upsert_artist_row(
    tx: &Transaction<'_>,
    server_id: &str,
    id: &str,
    name: &str,
    name_sort: &str,
    album_count: Option<i64>,
    synced_at: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO artist (server_id, id, name, name_sort, name_fold, album_count, synced_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(server_id, id) DO UPDATE SET \
            name = excluded.name, \
            name_sort = excluded.name_sort, \
            name_fold = excluded.name_fold, \
            album_count = COALESCE(excluded.album_count, artist.album_count), \
            synced_at = excluded.synced_at",
        params![server_id, id, name, name_sort, name.trim().to_lowercase(), album_count, synced_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::LibraryStore;
    use psysonic_integration::subsonic::{ArtistIndex, ArtistRef, IndexBucket};

    #[test]
    fn upsert_index_stores_name_sort_for_the_beatles() {
        let store = LibraryStore::open_in_memory();
        let repo = ArtistRepository::new(&store);
        let index = ArtistIndex {
            last_modified_ms: Some(1),
            ignored_articles: Some("The".into()),
            index: vec![IndexBucket {
                name: "B".into(),
                artist: vec![ArtistRef {
                    id: "ar_1".into(),
                    name: "The Beatles".into(),
                    album_count: Some(3),
                    cover_art: None,
                }],
            }],
        };
        repo.upsert_index("s1", &index, 1000).unwrap();
        let name_sort: String = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT name_sort FROM artist WHERE server_id = 's1' AND id = 'ar_1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(name_sort, "beatles");
    }

    fn seed_artist(store: &LibraryStore, server: &str, id: &str, name: &str, albums: Option<i64>) {
        store
            .with_conn_mut("test.seed_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, name_sort, name_fold, album_count, synced_at) \
                     VALUES (?1, ?2, ?3, ?3, ?4, ?5, 1)",
                    params![server, id, name, name.trim().to_lowercase(), albums],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn resolve_ids_by_name_matches_on_the_persisted_fold() {
        let store = LibraryStore::open_in_memory();
        seed_artist(&store, "s1", "ar_lead", "Alice", Some(4));
        seed_artist(&store, "s1", "ar_guest", "Bob", None);
        let repo = ArtistRepository::new(&store);

        let names = vec![
            "Alice".to_string(),
            // Case and padding differ from the stored row — a track tag routinely does.
            "  bOB ".to_string(),
            "Nobody".to_string(),
            "   ".to_string(),
        ];
        assert_eq!(
            repo.resolve_ids_by_name("s1", &names).unwrap(),
            vec![
                Some("ar_lead".to_string()),
                Some("ar_guest".to_string()),
                None,
                None,
            ]
        );
    }

    #[test]
    fn resolve_ids_by_name_is_scoped_per_server_and_stable_on_ties() {
        let store = LibraryStore::open_in_memory();
        // Same name several times on one server: the row with the most albums wins, so
        // the link lands on a real discography. `ar_aa_zero` proves a reported 0 is
        // treated like NULL — sorting only on "IS NULL" would let it win on id order.
        seed_artist(&store, "s1", "ar_zz_albums", "Echo", Some(2));
        seed_artist(&store, "s1", "ar_aa_plain", "Echo", None);
        seed_artist(&store, "s1", "ar_aa_zero", "Echo", Some(0));
        seed_artist(&store, "s2", "ar_other", "Alice", Some(1));
        let repo = ArtistRepository::new(&store);

        assert_eq!(
            repo.resolve_ids_by_name("s1", &["Echo".to_string()]).unwrap(),
            vec![Some("ar_zz_albums".to_string())]
        );
        // An artist that only exists on another server must not leak into this one.
        assert_eq!(
            repo.resolve_ids_by_name("s1", &["Alice".to_string()]).unwrap(),
            vec![None]
        );
    }

    #[test]
    fn backfill_from_tracks_accepts_cjk_artist_display_name() {
        use crate::artist_sort::DEFAULT_IGNORED_ARTICLES;
        use crate::repos::{TrackRepository, TrackRow};

        let store = LibraryStore::open_in_memory();
        let cjk = "北村友香, 齋藤司, 桜庭統 & 鈴木伸嘉";
        let row = TrackRow {
            server_id: "s1".into(),
            id: "tr_1".into(),
            title: "Song".into(),
            title_sort: None,
            artist: Some(cjk.into()),
            artist_id: Some("ar_cjk".into()),
            album: "al_1".into(),
            album_id: Some("al_1".into()),
            album_artist: None,
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        };
        TrackRepository::new(&store).upsert_batch(&[row]).unwrap();

        let repo = ArtistRepository::new(&store);
        let n = repo
            .backfill_from_tracks("s1", DEFAULT_IGNORED_ARTICLES, 2)
            .unwrap();
        assert_eq!(n, 1);

        let name_sort: String = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT name_sort FROM artist WHERE server_id = 's1' AND id = 'ar_cjk'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(name_sort, cjk.to_lowercase());
    }
}
