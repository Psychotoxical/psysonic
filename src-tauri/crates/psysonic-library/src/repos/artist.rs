//! `artist` table — browse index rows from `getArtists` and track-derived backfill.

use rusqlite::{params, Transaction};

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
            for bucket in &index.index {
                for artist in &bucket.artist {
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
            tx.commit()?;
            Ok(())
        })?;
        Ok(count)
    }

    /// One-time repair: fill `name_sort` where null (upgrade path).
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
        "INSERT INTO artist (server_id, id, name, name_sort, album_count, synced_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(server_id, id) DO UPDATE SET \
           name = excluded.name, \
           name_sort = excluded.name_sort, \
           album_count = COALESCE(excluded.album_count, artist.album_count), \
           synced_at = excluded.synced_at",
        params![server_id, id, name, name_sort, album_count, synced_at],
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
}
