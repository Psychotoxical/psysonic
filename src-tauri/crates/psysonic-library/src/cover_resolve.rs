//! Resolve cover cache keys from the local library index — same rules as
//! `psysonic_core::cover_cache_layout` / TS `resolveEntry.ts`.

use psysonic_core::cover_cache_layout::{resolve_album_cover, resolve_artist_cover, CoverEntry};
use rusqlite::OptionalExtension;

use crate::store::LibraryStore;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
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
        // Genuine per-disc artwork = a multi-disc release where each disc has ONE
        // consistent cover and those covers differ between discs (e.g. a box set).
        // It must NOT be tripped by per-song cover ids: Navidrome (and other
        // OpenSubsonic servers) give every track its own `mf-<id>` coverArt, so a
        // disc whose tracks carry many different ids is per-song art, not per-disc
        // art — treating it as distinct explodes the backfill into one cover per
        // track instead of one per album.
        let mut art_by_disc: std::collections::HashMap<i64, std::collections::HashSet<String>> =
            std::collections::HashMap::new();
        for row in rows {
            let (track_id, disc_number, cover_art_id, row_album_id) = row?;
            let disc = disc_number.unwrap_or(1);
            let al = row_album_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(album_id);
            let fetch = song_fetch_cover_art_id(cover_art_id.as_deref(), &track_id, al);
            art_by_disc.entry(disc).or_default().insert(fetch);
        }
        if art_by_disc.len() <= 1 {
            return Ok(false);
        }
        let mut disc_covers: std::collections::HashSet<String> = std::collections::HashSet::new();
        for covers in art_by_disc.values() {
            // Tracks within a disc disagree → per-song ids, not a shared disc cover.
            if covers.len() != 1 {
                return Ok(false);
            }
            if let Some(cover) = covers.iter().next() {
                disc_covers.insert(cover.clone());
            }
        }
        Ok(disc_covers.len() > 1)
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

/// Human-readable label for a cover target, for failure logs:
/// `album "Name" — Artist` / `artist "Name"`. Best-effort: returns `None` when
/// the entity is not in the local index (e.g. a stale per-disc `mf-*` id), so
/// the caller can fall back to the raw id.
pub fn describe_cover_entity(
    store: &LibraryStore,
    library_server_id: &str,
    cache_kind: &str,
    cache_entity_id: &str,
) -> Option<String> {
    let id = cache_entity_id.trim();
    if id.is_empty() {
        return None;
    }
    store
        .with_read_conn(|conn| {
            let label = if cache_kind == "artist" {
                let name = conn
                    .query_row(
                        "SELECT name FROM artist WHERE server_id = ?1 AND id = ?2",
                        rusqlite::params![library_server_id, id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .or(conn
                        .query_row(
                            "SELECT artist FROM track
                             WHERE server_id = ?1 AND artist_id = ?2 AND deleted = 0
                               AND NULLIF(TRIM(artist), '') IS NOT NULL
                             LIMIT 1",
                            rusqlite::params![library_server_id, id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?);
                name.map(|n| format!("artist \"{n}\""))
            } else {
                let pair = conn
                    .query_row(
                        "SELECT name, artist FROM album WHERE server_id = ?1 AND id = ?2",
                        rusqlite::params![library_server_id, id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                    )
                    .optional()?
                    .or(conn
                        .query_row(
                            "SELECT album, artist FROM track
                             WHERE server_id = ?1 AND album_id = ?2 AND deleted = 0
                               AND NULLIF(TRIM(album), '') IS NOT NULL
                             LIMIT 1",
                            rusqlite::params![library_server_id, id],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                        )
                        .optional()?);
                pair.map(|(name, artist)| {
                    match artist.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                        Some(a) => format!("album \"{name}\" — {a}"),
                        None => format!("album \"{name}\""),
                    }
                })
            };
            Ok(label)
        })
        .ok()
        .flatten()
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

    // Navidrome gives every song its own `mf-<id>` coverArt. Many tracks on a
    // single disc must NOT count as distinct disc covers, or backfill would warm
    // one cover per track instead of one per album.
    #[test]
    fn per_song_ids_within_one_disc_are_not_distinct() {
        let store = LibraryStore::open_in_memory();
        seed_album(&store, "srv", "al-nav", None);
        seed_track(&store, "srv", "tr1", "al-nav", 1, Some("mf-1"));
        seed_track(&store, "srv", "tr2", "al-nav", 1, Some("mf-2"));
        seed_track(&store, "srv", "tr3", "al-nav", 1, Some("mf-3"));
        assert!(!album_has_distinct_disc_covers(&store, "srv", "al-nav").unwrap());
        let items = cover_backfill_items_for_album(&store, "srv", "al-nav").unwrap();
        let ids: Vec<_> = items.iter().map(|i| i.cache_entity_id.as_str()).collect();
        assert_eq!(ids, vec!["al-nav"]);
    }

    #[test]
    fn describe_entity_labels_album_and_artist() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("seed_describe", |conn| {
                conn.execute(
                    "INSERT INTO album (server_id, id, name, artist, synced_at, raw_json)
                     VALUES ('srv', 'al-1', 'Discovery', 'Daft Punk', 1, '{}')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at, raw_json)
                     VALUES ('srv', 'ar-1', 'Daft Punk', 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            describe_cover_entity(&store, "srv", "album", "al-1").as_deref(),
            Some("album \"Discovery\" — Daft Punk"),
        );
        assert_eq!(
            describe_cover_entity(&store, "srv", "artist", "ar-1").as_deref(),
            Some("artist \"Daft Punk\""),
        );
        assert_eq!(describe_cover_entity(&store, "srv", "album", "al-missing"), None);
    }

    // Multi-disc, but each disc still exposes per-song ids (not a shared disc
    // cover) → per-song art, so backfill collapses to the single album cover.
    #[test]
    fn per_song_ids_across_discs_are_not_distinct() {
        let store = LibraryStore::open_in_memory();
        seed_album(&store, "srv", "al-nav2", None);
        seed_track(&store, "srv", "tr1", "al-nav2", 1, Some("mf-1"));
        seed_track(&store, "srv", "tr2", "al-nav2", 1, Some("mf-2"));
        seed_track(&store, "srv", "tr3", "al-nav2", 2, Some("mf-3"));
        seed_track(&store, "srv", "tr4", "al-nav2", 2, Some("mf-4"));
        assert!(!album_has_distinct_disc_covers(&store, "srv", "al-nav2").unwrap());
        let items = cover_backfill_items_for_album(&store, "srv", "al-nav2").unwrap();
        let ids: Vec<_> = items.iter().map(|i| i.cache_entity_id.as_str()).collect();
        assert_eq!(ids, vec!["al-nav2"]);
    }
}
