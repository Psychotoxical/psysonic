//! Resolve cover cache keys from the local library index — same rules as
//! `psysonic_core::cover_cache_layout` / TS `resolveEntry.ts`.

use psysonic_core::cover_cache_layout::{resolve_album_cover, resolve_artist_cover, CoverEntry};
use rusqlite::OptionalExtension;

use crate::store::LibraryStore;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverEntryDto {
    pub cache_kind: String,
    pub cache_entity_id: String,
    pub fetch_cover_art_id: String,
}

impl From<CoverEntry> for CoverEntryDto {
    fn from(e: CoverEntry) -> Self {
        Self {
            cache_kind: e.cache_kind.to_string(),
            cache_entity_id: e.cache_entity_id,
            fetch_cover_art_id: e.fetch_cover_art_id,
        }
    }
}

fn song_fetch_cover_art_id(cover_art_id: Option<&str>, song_id: &str, album_id: &str) -> String {
    let album = album_id.trim();
    let song_id = song_id.trim();
    if let Some(cover) = cover_art_id.map(str::trim).filter(|s| !s.is_empty()) {
        if song_id.is_empty() || cover != song_id {
            return cover.to_string();
        }
    }
    album.to_string()
}

pub fn album_has_distinct_disc_covers(
    store: &LibraryStore,
    library_server_id: &str,
    album_id: &str,
) -> Result<bool, String> {
    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, disc_number, cover_art_id, album_id
             FROM track
             WHERE server_id = ?1 AND album_id = ?2 AND deleted = 0",
        )?;
        let rows = stmt.query_map(rusqlite::params![library_server_id, album_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut art_by_disc: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        for row in rows {
            let (track_id, disc_number, cover_art_id, row_album_id) = row?;
            let disc = disc_number.unwrap_or(1);
            let al = row_album_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(album_id);
            let fetch = song_fetch_cover_art_id(cover_art_id.as_deref(), &track_id, al);
            if let Some(prev) = art_by_disc.get(&disc) {
                if prev != &fetch {
                    return Ok(true);
                }
            } else {
                art_by_disc.insert(disc, fetch);
            }
        }
        if art_by_disc.len() <= 1 {
            return Ok(false);
        }
        let unique: std::collections::HashSet<_> = art_by_disc.values().collect();
        Ok(unique.len() > 1)
    })
}

pub fn resolve_album_cover_entry(
    store: &LibraryStore,
    library_server_id: &str,
    album_id: &str,
) -> Result<Option<CoverEntryDto>, String> {
    let album_id = album_id.trim();
    if album_id.is_empty() {
        return Ok(None);
    }
    let cover_art_id = match store.with_read_conn(|conn| {
        conn.query_row(
            "SELECT cover_art_id FROM album WHERE server_id = ?1 AND id = ?2",
            rusqlite::params![library_server_id, album_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
    })? {
        None => return Ok(None),
        Some(v) => v,
    };
    let distinct = album_has_distinct_disc_covers(store, library_server_id, album_id)?;
    Ok(resolve_album_cover(album_id, cover_art_id.as_deref(), distinct).map(Into::into))
}

/// Album id appears only on `track` rows (no `album` table row) — mirror catalog `fetch_id`.
fn track_only_album_backfill_entry(
    store: &LibraryStore,
    library_server_id: &str,
    album_id: &str,
) -> Result<Option<CoverEntryDto>, String> {
    store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT COALESCE(NULLIF(TRIM(cover_art_id), ''), TRIM(album_id))
             FROM track
             WHERE server_id = ?1 AND album_id = ?2 AND deleted = 0
             ORDER BY id ASC
             LIMIT 1",
                rusqlite::params![library_server_id, album_id],
                |row| {
                    let fetch: String = row.get(0)?;
                    Ok(resolve_album_cover(album_id, Some(fetch.as_str()), false).map(Into::into))
                },
            )
            .optional()
        })
        .map(|opt| opt.flatten())
}

/// All disk slots to warm for one album — includes per-CD `mf-*` / `dc-*` dirs when discs differ.
pub fn cover_backfill_items_for_album(
    store: &LibraryStore,
    library_server_id: &str,
    album_id: &str,
) -> Result<Vec<CoverEntryDto>, String> {
    let album_id = album_id.trim();
    if album_id.is_empty() {
        return Ok(Vec::new());
    }
    let distinct = album_has_distinct_disc_covers(store, library_server_id, album_id)?;
    if !distinct {
        if let Some(dto) = resolve_album_cover_entry(store, library_server_id, album_id)? {
            return Ok(vec![dto]);
        }
        return Ok(track_only_album_backfill_entry(store, library_server_id, album_id)?
            .into_iter()
            .collect());
    }

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut push = |dto: CoverEntryDto| {
        if seen.insert(dto.cache_entity_id.clone()) {
            out.push(dto);
        }
    };

    if let Some(dto) = resolve_album_cover_entry(store, library_server_id, album_id)? {
        push(dto);
    }

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, disc_number, cover_art_id, album_id
             FROM track
             WHERE server_id = ?1 AND album_id = ?2 AND deleted = 0",
        )?;
        let rows = stmt.query_map(rusqlite::params![library_server_id, album_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        for row in rows {
            let (track_id, disc_number, cover_art_id, row_album_id) = row?;
            let _disc = disc_number.unwrap_or(1);
            let al = row_album_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(album_id);
            let fetch = song_fetch_cover_art_id(cover_art_id.as_deref(), &track_id, al);
            if let Some(entry) = resolve_album_cover(album_id, Some(fetch.as_str()), true) {
                push(entry.into());
            }
        }
        Ok(())
    })?;

    Ok(out)
}

pub fn resolve_artist_cover_entry(
    _store: &LibraryStore,
    _library_server_id: &str,
    artist_id: &str,
) -> Result<Option<CoverEntryDto>, String> {
    let artist_id = artist_id.trim();
    if artist_id.is_empty() {
        return Ok(None);
    }
    Ok(resolve_artist_cover(artist_id, None).map(Into::into))
}

pub fn resolve_track_cover_entry(
    store: &LibraryStore,
    library_server_id: &str,
    track_id: &str,
) -> Result<Option<CoverEntryDto>, String> {
    let track_id = track_id.trim();
    if track_id.is_empty() {
        return Ok(None);
    }
    let row: Option<(String, Option<String>, Option<String>)> = store.with_read_conn(|conn| {
        conn.query_row(
            "SELECT id, cover_art_id, album_id FROM track
             WHERE server_id = ?1 AND id = ?2 AND deleted = 0",
            rusqlite::params![library_server_id, track_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                ))
            },
        )
        .optional()
    })?;
    let Some((id, cover_art_id, Some(album_id))) = row else {
        return Ok(None);
    };
    let album_id = album_id.trim();
    if album_id.is_empty() {
        return Ok(None);
    }
    let fetch = song_fetch_cover_art_id(cover_art_id.as_deref(), &id, album_id);
    let distinct = album_has_distinct_disc_covers(store, library_server_id, album_id)?;
    Ok(resolve_album_cover(album_id, Some(fetch.as_str()), distinct).map(Into::into))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::LibraryStore;

    fn seed_album(store: &LibraryStore, server_id: &str, album_id: &str, cover_art: Option<&str>) {
        store
            .with_conn_mut("seed_album", |conn| {
                conn.execute(
                    "INSERT INTO album (
                      server_id, id, name, cover_art_id, synced_at, raw_json
                    ) VALUES (?1, ?2, 'A', ?3, 1, '{}')",
                    rusqlite::params![server_id, album_id, cover_art],
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn seed_track(
        store: &LibraryStore,
        server_id: &str,
        track_id: &str,
        album_id: &str,
        disc: i64,
        cover: Option<&str>,
    ) {
        store
            .with_conn_mut("seed_track", |conn| {
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, disc_number,
                      duration_sec, deleted, synced_at, raw_json, cover_art_id
                    ) VALUES (?1, ?2, 't', 'A', ?3, ?4, 200, 0, 1, '{}', ?5)",
                    rusqlite::params![server_id, track_id, album_id, disc, cover],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn resolve_album_uses_bare_id_and_stored_cover_art() {
        let store = LibraryStore::open_in_memory();
        seed_album(
            &store,
            "srv",
            "ca78bec6",
            Some("al-ca78bec6_60fc987f"),
        );
        let e = resolve_album_cover_entry(&store, "srv", "ca78bec6")
            .unwrap()
            .unwrap();
        assert_eq!(e.cache_entity_id, "ca78bec6");
        assert_eq!(e.fetch_cover_art_id, "al-ca78bec6_60fc987f");
    }

    #[test]
    fn resolve_track_defaults_to_album_bucket() {
        let store = LibraryStore::open_in_memory();
        seed_album(&store, "srv", "al-1", None);
        seed_track(&store, "srv", "tr1", "al-1", 1, Some("mf-a"));
        let e = resolve_track_cover_entry(&store, "srv", "tr1").unwrap().unwrap();
        assert_eq!(e.cache_entity_id, "al-1");
        assert_eq!(e.fetch_cover_art_id, "mf-a");
    }

    #[test]
    fn backfill_album_slots_include_each_disc_mf() {
        let store = LibraryStore::open_in_memory();
        seed_album(&store, "srv", "al-box", None);
        seed_track(&store, "srv", "tr1", "al-box", 1, Some("mf-a"));
        seed_track(&store, "srv", "tr2", "al-box", 2, Some("mf-b"));
        let items = cover_backfill_items_for_album(&store, "srv", "al-box").unwrap();
        let ids: Vec<_> = items.iter().map(|i| i.cache_entity_id.as_str()).collect();
        assert!(ids.contains(&"mf-a"));
        assert!(ids.contains(&"mf-b"));
    }

    #[test]
    fn distinct_disc_covers_change_cache_entity() {
        let store = LibraryStore::open_in_memory();
        seed_album(&store, "srv", "al-box", None);
        seed_track(&store, "srv", "tr1", "al-box", 1, Some("mf-a"));
        seed_track(&store, "srv", "tr2", "al-box", 2, Some("mf-b"));
        assert!(album_has_distinct_disc_covers(&store, "srv", "al-box").unwrap());
        let e = resolve_track_cover_entry(&store, "srv", "tr2").unwrap().unwrap();
        assert_eq!(e.cache_entity_id, "mf-b");
    }
}
