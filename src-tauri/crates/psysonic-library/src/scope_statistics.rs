//! Scope-aware catalog aggregates and play-session identity views.

use rusqlite::types::Value as SqlValue;
use rusqlite::params_from_iter;
use serde_json::Value;

use crate::album_compilation_filter::pick_album_group_artist;
use crate::browse_support::overlay_album_starred_at_rows;
use crate::dto::{
    LibraryAlbumDto, LibraryScopeCatalogStatisticsDto,
    LibraryScopeCatalogStatisticsRequest, LibraryScopeFormatCountDto,
    LibraryScopeMostPlayedAlbumDto, LibraryScopeMostPlayedRequest,
    LibraryArtistDto, LibraryScopeArtistRoleRequest,
};
use crate::identity::norm_part;
use crate::scope_merge::{
    ensure_cluster_keys_for_scopes, normalize_scope_pairs, scope_cte_sql, ALBUM_DEDUP_KEY,
    TRACK_DEDUP_KEY,
};
use crate::store::LibraryStore;

const ARTIST_DEDUP_KEY: &str = "CASE WHEN ck.artist_key IS NOT NULL THEN ck.artist_key \
    ELSE ('null:' || t.server_id || ':' || COALESCE(NULLIF(t.artist_id, ''), t.id)) END";

fn validated_scopes(
    scopes: &[crate::dto::LibraryScopePair],
) -> Result<Vec<crate::dto::LibraryScopePair>, String> {
    let scopes = normalize_scope_pairs(scopes)?;
    if scopes.is_empty() {
        return Err("scopes must not be empty".into());
    }
    Ok(scopes)
}

pub fn catalog_statistics(
    store: &LibraryStore,
    request: &LibraryScopeCatalogStatisticsRequest,
) -> Result<LibraryScopeCatalogStatisticsDto, String> {
    let scopes = validated_scopes(&request.scopes)?;
    ensure_cluster_keys_for_scopes(store, &scopes)?;
    let sample_limit = request.format_sample_limit.unwrap_or(500).clamp(1, 5_000);
    let (cte, binds) = scope_cte_sql(&scopes);
    let sql = format!(
        "{cte}, base AS ( \
           SELECT t.rowid, t.server_id, t.id, t.duration_sec, t.suffix, t.album_id, t.artist_id, \
                  s.pr, {TRACK_DEDUP_KEY} AS track_dedup, {ALBUM_DEDUP_KEY} AS album_dedup, \
                  {ARTIST_DEDUP_KEY} AS artist_dedup \
           FROM scoped_track s CROSS JOIN track t ON t.rowid = s.rowid \
           LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
           WHERE t.deleted = 0 \
         ), winners AS ( \
           SELECT rowid, server_id, id, duration_sec, suffix, album_id, artist_id, \
                  album_dedup, artist_dedup, MIN(printf('%08d|%s|%s', pr, server_id, id)) AS _pick \
           FROM base GROUP BY track_dedup \
         ) \
         SELECT COUNT(*), COALESCE(SUM(duration_sec), 0), \
                COUNT(DISTINCT CASE WHEN album_id IS NOT NULL AND album_id != '' THEN album_dedup END), \
                COUNT(DISTINCT CASE WHEN artist_id IS NOT NULL AND artist_id != '' THEN artist_dedup END) \
         FROM winners"
    );
    let (track_count, duration_sec, album_count, artist_count) = store
        .with_read_conn(|conn| {
            conn.query_row(&sql, params_from_iter(binds.iter()), |row| {
                Ok((
                    row.get::<_, i64>(0)?.max(0) as u32,
                    row.get::<_, i64>(1)?.max(0),
                    row.get::<_, i64>(2)?.max(0) as u32,
                    row.get::<_, i64>(3)?.max(0) as u32,
                ))
            })
        })
        .map_err(|e| e.to_string())?;

    let genres = crate::browse_support::genre_album_counts_for_scopes(store, &scopes)?;
    let format_sql = format!(
        "{cte}, base AS ( \
           SELECT t.server_id, t.id, t.suffix, s.pr, {TRACK_DEDUP_KEY} AS track_dedup \
           FROM scoped_track s CROSS JOIN track t ON t.rowid = s.rowid \
           LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
           WHERE t.deleted = 0 \
         ), winners AS ( \
           SELECT suffix, MIN(printf('%08d|%s|%s', pr, server_id, id)) AS _pick \
           FROM base GROUP BY track_dedup ORDER BY RANDOM() LIMIT ? \
         ) \
         SELECT COALESCE(NULLIF(UPPER(TRIM(suffix)), ''), 'UNKNOWN'), COUNT(*) \
         FROM winners GROUP BY 1 ORDER BY 2 DESC, 1 ASC"
    );
    let mut format_binds = binds;
    format_binds.push(SqlValue::Integer(i64::from(sample_limit)));
    let formats = store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&format_sql)?;
            let rows = stmt.query_map(params_from_iter(format_binds.iter()), |row| {
                Ok(LibraryScopeFormatCountDto {
                    format: row.get(0)?,
                    count: row.get::<_, i64>(1)?.max(0) as u32,
                })
            })?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .map_err(|e| e.to_string())?;
    let format_sample_size = formats.iter().map(|row| row.count).sum();

    Ok(LibraryScopeCatalogStatisticsDto {
        artist_count,
        album_count,
        track_count,
        duration_sec,
        genres,
        formats,
        format_sample_size,
    })
}

pub fn most_played_albums(
    store: &LibraryStore,
    request: &LibraryScopeMostPlayedRequest,
) -> Result<Vec<LibraryScopeMostPlayedAlbumDto>, String> {
    let scopes = validated_scopes(&request.scopes)?;
    ensure_cluster_keys_for_scopes(store, &scopes)?;
    let limit = request.limit.unwrap_or(50).clamp(1, 500);
    let offset = request.offset.unwrap_or(0);
    let (cte, mut binds) = scope_cte_sql(&scopes);
    let sql = format!(
        "{cte}, base AS ( \
           SELECT t.server_id, t.id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                   t.year, t.genre, t.cover_art_id, t.synced_at, t.duration_sec, s.pr, \
                   {ALBUM_DEDUP_KEY} AS album_dedup, {TRACK_DEDUP_KEY} AS track_dedup \
           FROM scoped_track s CROSS JOIN track t ON t.rowid = s.rowid \
           LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
           WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
          ), track_winners AS ( \
            SELECT server_id, id, album_id, album, artist, artist_id, album_artist, year, genre, \
                   cover_art_id, synced_at, duration_sec, pr, album_dedup, track_dedup, \
                   MIN(printf('%08d|%s|%s', pr, server_id, id)) AS _track_pick \
            FROM base GROUP BY album_dedup, track_dedup \
          ), album_totals AS ( \
            SELECT album_dedup, COUNT(*) AS song_count, SUM(duration_sec) AS duration_total \
            FROM track_winners GROUP BY album_dedup \
          ), played AS ( \
            SELECT b.*, ps.id AS session_id \
            FROM base b INNER JOIN play_session ps ON ps.server_id = b.server_id AND ps.track_id = b.id \
          ), played_albums AS ( \
            SELECT server_id, album_id, album, artist, artist_id, album_artist, year, genre, cover_art_id, \
                   synced_at, album_dedup, COUNT(session_id) AS play_count, \
                   MIN(printf('%08d|%s|%s', pr, server_id, album_id)) AS _pick \
            FROM played GROUP BY album_dedup \
          ) \
          SELECT p.server_id, p.album_id, p.album, p.artist, p.artist_id, p.album_artist, \
                 a.song_count, a.duration_total, p.year, p.genre, p.cover_art_id, p.synced_at, \
                 p.play_count, \
                 p._pick \
          FROM played_albums p INNER JOIN album_totals a ON a.album_dedup = p.album_dedup \
          ORDER BY p.play_count DESC, p.album COLLATE NOCASE ASC, p.album_id ASC LIMIT ? OFFSET ?"
    );
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));
    let mut rows = store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
                let track_artist: Option<String> = row.get(3)?;
                let album_artist: Option<String> = row.get(5)?;
                Ok(LibraryScopeMostPlayedAlbumDto {
                    album: LibraryAlbumDto {
                        server_id: row.get(0)?,
                        id: row.get(1)?,
                        name: row.get(2)?,
                        artist: pick_album_group_artist(track_artist, album_artist),
                        artist_id: row.get(4)?,
                        song_count: Some(row.get(6)?),
                        duration_sec: Some(row.get(7)?),
                        year: row.get(8)?,
                        genre: row.get(9)?,
                        cover_art_id: row.get(10)?,
                        starred_at: None,
                        synced_at: row.get(11)?,
                        raw_json: Value::Null,
                    },
                    play_count: row.get::<_, i64>(12)?.max(0) as u32,
                })
            })?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .map_err(|e| e.to_string())?;
    store
        .with_read_conn(|conn| {
            let mut albums = rows.iter_mut().map(|row| &mut row.album).collect::<Vec<_>>();
            for album in albums.iter_mut() {
                let one = std::slice::from_mut(&mut **album);
                overlay_album_starred_at_rows(conn, one);
            }
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn artists_by_role(
    store: &LibraryStore,
    request: &LibraryScopeArtistRoleRequest,
) -> Result<Vec<LibraryArtistDto>, String> {
    let scopes = validated_scopes(&request.scopes)?;
    ensure_cluster_keys_for_scopes(store, &scopes)?;
    let role = request.role.trim().to_ascii_lowercase();
    if role.is_empty() {
        return Err("role must not be empty".into());
    }
    let limit = request.limit.unwrap_or(10_000).clamp(1, 20_000);
    let (cte, mut binds) = scope_cte_sql(&scopes);
    let rows_sql = format!(
        "{cte}, role_rows AS ( \
            SELECT t.server_id, json_extract(j.value, '$.artist.id') AS artist_id, \
                   json_extract(j.value, '$.artist.name') AS artist_name, \
                   COALESCE(ck.album_key, 'null:' || t.server_id || ':' || COALESCE(t.album_id, t.id)) AS album_dedup, \
                   t.synced_at, s.pr, \
                   MIN(printf('%08d|%s|%s', s.pr, t.server_id, json_extract(j.value, '$.artist.id'))) AS _pick \
            FROM scoped_track s CROSS JOIN track t ON t.rowid = s.rowid \
            JOIN json_each(CASE WHEN json_valid(t.raw_json) THEN t.raw_json ELSE '{{}}' END, '$.contributors') j \
            LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
            WHERE t.deleted = 0 AND LOWER(COALESCE(json_extract(j.value, '$.role'), '')) = ? \
              AND json_extract(j.value, '$.artist.id') IS NOT NULL \
            GROUP BY t.server_id, artist_id, artist_name, album_dedup, t.synced_at, s.pr \
          ) \
          SELECT server_id, artist_id, artist_name, album_dedup, synced_at, pr \
          FROM role_rows ORDER BY pr ASC, server_id ASC, artist_id ASC"
    );
    binds.push(SqlValue::Text(role));
    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&rows_sql)?;
        let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut grouped: std::collections::HashMap<String, (LibraryArtistDto, std::collections::HashSet<String>)> =
            std::collections::HashMap::new();
        for (server_id, artist_id, name, album_dedup, synced_at) in rows {
            let key = norm_part(&name)
                .unwrap_or_else(|| format!("null:{server_id}:{artist_id}"));
            let entry = grouped.entry(key).or_insert_with(|| {
                (LibraryArtistDto {
                    server_id,
                    id: artist_id,
                    name: name.clone(),
                    name_sort: Some(crate::artist_sort::sort_key_for_display_name(
                        &name,
                        crate::artist_sort::DEFAULT_IGNORED_ARTICLES,
                    )),
                    album_count: Some(0),
                    synced_at,
                    raw_json: Value::Null,
                }, std::collections::HashSet::new())
            });
            if let Some(album_dedup) = album_dedup {
                entry.1.insert(album_dedup);
            }
        }
        let mut artists = grouped.into_values().map(|(mut artist, album_ids)| {
            artist.album_count = Some(album_ids.len() as i64);
            artist
        }).collect::<Vec<_>>();
        artists.sort_by(|a, b| a.name_sort.cmp(&b.name_sort).then_with(|| a.id.cmp(&b.id)));
        artists.truncate(limit as usize);
        Ok(artists)
    }).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use crate::dto::{
        LibraryScopeArtistRoleRequest, LibraryScopeCatalogStatisticsRequest,
        LibraryScopeMostPlayedRequest, LibraryScopePair,
    };
    use crate::repos::{PlaySessionRepository, TrackRepository, TrackRow};
    use crate::store::LibraryStore;

    use super::{artists_by_role, catalog_statistics, most_played_albums};

    fn row(server: &str, id: &str, album: &str, library: &str, duration: i64) -> TrackRow {
        TrackRow {
            server_id: server.into(), id: id.into(), title: "Song".into(), title_sort: None,
            artist: Some("Artist".into()), artist_id: Some("artist".into()), album: album.into(),
            album_id: Some(album.into()), album_artist: Some("Artist".into()), duration_sec: duration,
            track_number: Some(1), disc_number: Some(1), year: Some(2024), genre: Some("Rock".into()),
            suffix: Some("flac".into()), bit_rate: None, size_bytes: None, cover_art_id: Some(album.into()),
            starred_at: None, user_rating: None, play_count: None, played_at: None, server_path: None,
            library_id: Some(library.into()), isrc: Some("same-isrc".into()), mbid_recording: None,
            bpm: None, replay_gain_track_db: None, replay_gain_album_db: None, replay_gain_peak: None,
            content_hash: None, server_updated_at: None, server_created_at: None, deleted: false,
            synced_at: 1, raw_json: "{}".into(),
        }
    }

    fn contributor_row(
        server: &str,
        id: &str,
        album: &str,
        library: &str,
        contributors: serde_json::Value,
    ) -> TrackRow {
        let mut track = row(server, id, album, library, 200);
        track.raw_json = serde_json::json!({ "contributors": contributors }).to_string();
        track
    }

    fn scopes() -> Vec<LibraryScopePair> {
        vec![
            LibraryScopePair { server_id: "s1".into(), library_id: Some("a".into()) },
            LibraryScopePair { server_id: "s2".into(), library_id: Some("b".into()) },
        ]
    }

    #[test]
    fn catalog_totals_dedup_shared_recording_and_album_by_priority() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store).upsert_batch(&[
            row("s1", "t1", "shared-album", "a", 200),
            row("s2", "t2", "shared-album", "b", 201),
        ]).unwrap();
        let stats = catalog_statistics(&store, &LibraryScopeCatalogStatisticsRequest {
            scopes: scopes(), format_sample_limit: Some(500),
        }).unwrap();
        assert_eq!(stats.track_count, 1);
        assert_eq!(stats.album_count, 1);
        assert_eq!(stats.artist_count, 1);
        assert_eq!(stats.duration_sec, 200);
        assert_eq!(stats.format_sample_size, 1);
    }

    #[test]
    fn most_played_counts_concrete_sessions_once_but_displays_priority_identity() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store).upsert_batch(&[
            row("s1", "t1", "shared-album", "a", 200),
            row("s2", "t2", "shared-album", "b", 201),
        ]).unwrap();
        let repo = PlaySessionRepository::new(&store);
        for (server_id, track_id, started_at_ms) in [("s1", "t1", 1000), ("s2", "t2", 2000)] {
            repo.insert(&crate::dto::PlaySessionInputDto {
                server_id: server_id.into(), track_id: track_id.into(), started_at_ms,
                listened_sec: 30.0, position_max_sec: 30.0, end_reason: "next".into(),
                duration_sec_hint: None,
            }).unwrap();
        }
        let rows = most_played_albums(&store, &LibraryScopeMostPlayedRequest {
            scopes: scopes(), limit: Some(10), offset: None,
        }).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].play_count, 2);
        assert_eq!(rows[0].album.server_id, "s1");
        assert_eq!(rows[0].album.id, "shared-album");
        assert_eq!(rows[0].album.song_count, Some(1));
        assert_eq!(rows[0].album.duration_sec, Some(200));
    }

    #[test]
    fn most_played_song_count_does_not_collide_equal_raw_ids_across_servers() {
        let store = LibraryStore::open_in_memory();
        let mut first = row("s1", "same-id", "shared-album", "a", 200);
        first.title = "First".into();
        first.isrc = Some("first-isrc".into());
        let mut second = row("s2", "same-id", "shared-album", "b", 240);
        second.title = "Second".into();
        second.isrc = Some("second-isrc".into());
        TrackRepository::new(&store).upsert_batch(&[first, second]).unwrap();
        let repo = PlaySessionRepository::new(&store);
        for (server_id, started_at_ms) in [("s1", 1000), ("s2", 2000)] {
            repo.insert(&crate::dto::PlaySessionInputDto {
                server_id: server_id.into(), track_id: "same-id".into(), started_at_ms,
                listened_sec: 30.0, position_max_sec: 30.0, end_reason: "next".into(),
                duration_sec_hint: None,
            }).unwrap();
        }
        let rows = most_played_albums(&store, &LibraryScopeMostPlayedRequest {
            scopes: scopes(), limit: Some(10), offset: None,
        }).unwrap();
        assert_eq!(rows[0].album.song_count, Some(2));
        assert_eq!(rows[0].album.duration_sec, Some(440));
    }

    #[test]
    fn contributor_roles_keep_distinct_people_on_one_track() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store).upsert_batch(&[contributor_row(
            "s1", "t1", "album-one", "a",
            serde_json::json!([
                { "role": "composer", "artist": { "id": "c1", "name": "Composer One" } },
                { "role": "composer", "artist": { "id": "c2", "name": "Composer Two" } }
            ]),
        )]).unwrap();
        let artists = artists_by_role(&store, &LibraryScopeArtistRoleRequest {
            scopes: vec![LibraryScopePair { server_id: "s1".into(), library_id: Some("a".into()) }],
            role: "composer".into(), limit: Some(10),
        }).unwrap();
        assert_eq!(artists.iter().map(|artist| artist.name.as_str()).collect::<Vec<_>>(),
            vec!["Composer One", "Composer Two"]);
    }

    #[test]
    fn contributor_roles_merge_same_person_across_servers_by_contributor_identity() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store).upsert_batch(&[
            contributor_row(
                "s1", "t1", "shared-album", "a",
                serde_json::json!([{ "role": "composer", "artist": { "id": "composer-a", "name": "Béla Bartók" } }]),
            ),
            contributor_row(
                "s2", "t2", "shared-album", "b",
                serde_json::json!([{ "role": "composer", "artist": { "id": "composer-b", "name": "Bela Bartok" } }]),
            ),
        ]).unwrap();
        let artists = artists_by_role(&store, &LibraryScopeArtistRoleRequest {
            scopes: scopes(), role: "composer".into(), limit: Some(10),
        }).unwrap();
        assert_eq!(artists.len(), 1);
        assert_eq!(artists[0].server_id, "s1");
        assert_eq!(artists[0].id, "composer-a");
        assert_eq!(artists[0].album_count, Some(1));
    }
}
