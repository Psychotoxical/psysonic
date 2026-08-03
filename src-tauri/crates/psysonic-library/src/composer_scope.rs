//! Priority-deduped composer browse and detail over selected library scopes.

use std::collections::HashSet;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, OptionalExtension};
use serde_json::Value;

use crate::dto::{
    LibraryAlbumDto, LibraryArtistDto, LibraryScopeComposerDetailRequest,
    LibraryScopeComposerDetailResponse, LibraryScopeListRequest, LibraryScopePair,
};
use crate::scope_merge::{non_empty_scopes, scope_cte_sql};
use crate::store::LibraryStore;

fn parse_raw_json(raw: Option<String>) -> Value {
    raw.and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or(Value::Null)
}

pub fn list_composers(
    store: &LibraryStore,
    request: &LibraryScopeListRequest,
) -> Result<Vec<LibraryArtistDto>, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    crate::scope_merge::ensure_cluster_keys_for_scopes(store, scopes)?;
    let limit = request.limit.unwrap_or(10_000).clamp(1, 10_000);
    let offset = request.offset.unwrap_or(0);
    let (cte, mut binds) = scope_cte_sql(scopes);
    let order = match request.sort.as_deref().map(str::trim) {
        Some("albumCount") | Some("album_count") => {
            "ORDER BY g.album_count DESC, k.name_sort COLLATE NOCASE, k.composer_id"
        }
        _ => "ORDER BY k.name_sort COLLATE NOCASE, k.composer_id",
    };
    let sql = format!(
        "{cte}, \
         base AS MATERIALIZED ( \
           SELECT cp.server_id, cp.library_id, cp.composer_id, cp.composer_name, \
                  cp.name_sort, cp.identity_key, cp.album_id, cp.synced_at, s.pr \
           FROM scope s CROSS JOIN composer_album_projection cp \
             ON cp.server_id = s.server_id AND cp.library_id = s.library_id \
         ), \
         ambiguous AS ( \
           SELECT server_id, identity_key FROM base \
           GROUP BY server_id, identity_key HAVING COUNT(DISTINCT composer_id) > 1 \
         ), \
         keyed AS ( \
           SELECT b.*, \
                  CASE WHEN a.identity_key IS NULL THEN ('name:' || b.identity_key) \
                       ELSE ('owner:' || b.server_id || ':' || b.composer_id) END AS dedup_key, \
                  COALESCE(ap.identity_key, 'owner:' || b.server_id || ':' || b.album_id) AS album_key, \
                  printf('%08d|%s|%s|%s|%s', b.pr, b.server_id, b.library_id, b.composer_id, b.album_id) AS pick_key \
           FROM base b \
           LEFT JOIN ambiguous a ON a.server_id = b.server_id AND a.identity_key = b.identity_key \
           LEFT JOIN album_browse_projection ap \
             ON ap.server_id = b.server_id AND ap.library_id = b.library_id AND ap.album_id = b.album_id \
         ), \
         grouped AS ( \
           SELECT dedup_key, COUNT(DISTINCT album_key) AS album_count, \
                  MAX(synced_at) AS synced_at, MIN(pick_key) AS pick_key \
           FROM keyed GROUP BY dedup_key \
         ) \
         SELECT k.server_id, k.composer_id, k.composer_name, k.name_sort, \
                g.album_count, g.synced_at, ar.raw_json \
         FROM grouped g JOIN keyed k ON k.dedup_key = g.dedup_key AND k.pick_key = g.pick_key \
         LEFT JOIN artist ar ON ar.server_id = k.server_id AND ar.id = k.composer_id \
         {order} LIMIT ? OFFSET ?"
    );
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));
    store.with_read_conn(|conn| {
        let mut statement = conn.prepare(&sql)?;
        let mapped = statement
            .query_map(params_from_iter(binds.iter()), |row| {
                Ok(LibraryArtistDto {
                    server_id: row.get(0)?,
                    id: row.get(1)?,
                    name: row.get(2)?,
                    name_sort: Some(row.get(3)?),
                    album_count: Some(row.get(4)?),
                    synced_at: row.get(5)?,
                    raw_json: parse_raw_json(row.get(6)?),
                })
            })?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()
    })
}

#[derive(Debug)]
struct DetailRow {
    album_identity_key: Option<String>,
    album: LibraryAlbumDto,
}

fn anchor_identity(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    server_id: &str,
    composer_id: &str,
) -> Result<(String, String, String, i64, Option<String>), String> {
    let (cte, mut binds) = scope_cte_sql(scopes);
    binds.push(SqlValue::Text(server_id.to_string()));
    binds.push(SqlValue::Text(composer_id.to_string()));
    let sql = format!(
        "{cte} \
         SELECT cp.identity_key, cp.composer_name, cp.name_sort, MAX(cp.synced_at), ar.raw_json \
         FROM scope s CROSS JOIN composer_album_projection cp \
           ON cp.server_id = s.server_id AND cp.library_id = s.library_id \
         LEFT JOIN artist ar ON ar.server_id = cp.server_id AND ar.id = cp.composer_id \
         WHERE cp.server_id = ? AND cp.composer_id = ? \
         GROUP BY cp.identity_key, cp.composer_name, cp.name_sort, ar.raw_json \
         ORDER BY MIN(s.pr) LIMIT 1"
    );
    store.with_scope_detail_read_conn(|conn| {
        conn.query_row(
            &sql,
            params_from_iter(binds.iter()),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)
    })
    .map_err(|error| error.to_string())
}

fn anchor_is_ambiguous(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    server_id: &str,
    identity_key: &str,
) -> Result<bool, String> {
    let (cte, mut binds) = scope_cte_sql(scopes);
    binds.push(SqlValue::Text(server_id.to_string()));
    binds.push(SqlValue::Text(identity_key.to_string()));
    let sql = format!(
        "{cte} SELECT COUNT(DISTINCT cp.composer_id) > 1 \
         FROM scope s CROSS JOIN composer_album_projection cp \
           ON cp.server_id = s.server_id AND cp.library_id = s.library_id \
         WHERE cp.server_id = ? AND cp.identity_key = ?"
    );
    store
        .with_scope_detail_read_conn(|conn| {
            conn.query_row(&sql, params_from_iter(binds.iter()), |row| row.get(0))
        })
        .map_err(|error| error.to_string())
}

pub fn composer_detail(
    store: &LibraryStore,
    request: &LibraryScopeComposerDetailRequest,
) -> Result<LibraryScopeComposerDetailResponse, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    crate::scope_merge::ensure_cluster_keys_for_scopes(store, scopes)?;
    let server_id = request.server_id.trim();
    let composer_id = request.composer_id.trim();
    if server_id.is_empty() || composer_id.is_empty() {
        return Err("server_id and composer_id are required".into());
    }
    let (identity_key, name, name_sort, synced_at, raw_json) =
        anchor_identity(store, scopes, server_id, composer_id)?;
    let ambiguous = anchor_is_ambiguous(store, scopes, server_id, &identity_key)?;

    let (cte, mut binds) = scope_cte_sql(scopes);
    binds.push(SqlValue::Integer(i64::from(ambiguous)));
    binds.push(SqlValue::Text(server_id.to_string()));
    binds.push(SqlValue::Text(composer_id.to_string()));
    binds.push(SqlValue::Text(identity_key));
    let sql = format!(
        "{cte} \
         SELECT cp.server_id, cp.composer_id, cp.composer_name, cp.name_sort, cp.synced_at, ar.raw_json, \
                ap.identity_key, ap.album_id, ap.name, ap.artist, ap.artist_id, ap.song_count, \
                ap.duration_sec, ap.year, ap.genre, ap.cover_art_id, ap.starred_at, ap.synced_at \
         FROM scope s CROSS JOIN composer_album_projection cp \
           ON cp.server_id = s.server_id AND cp.library_id = s.library_id \
         JOIN album_browse_projection ap \
           ON ap.server_id = cp.server_id AND ap.library_id = cp.library_id AND ap.album_id = cp.album_id \
         LEFT JOIN artist ar ON ar.server_id = cp.server_id AND ar.id = cp.composer_id \
         WHERE ( \
           (? = 1 AND cp.server_id = ? AND cp.composer_id = ?) OR \
           (? = 0 AND cp.identity_key = ? AND ( \
             SELECT COUNT(DISTINCT other.composer_id) \
             FROM scope other_scope CROSS JOIN composer_album_projection other \
               ON other.server_id = other_scope.server_id AND other.library_id = other_scope.library_id \
             WHERE other.server_id = cp.server_id AND other.identity_key = cp.identity_key \
           ) = 1) \
         ) \
         ORDER BY s.pr, ap.name COLLATE NOCASE, ap.album_id"
    );
    // The ambiguity flag is used twice in the WHERE clause.
    binds.insert(binds.len() - 1, SqlValue::Integer(i64::from(ambiguous)));

    let rows = store.with_scope_detail_read_conn(|conn| {
        let mut statement = conn.prepare(&sql)?;
        let mapped = statement
            .query_map(params_from_iter(binds.iter()), |row| {
                Ok(DetailRow {
                    album_identity_key: row.get(6)?,
                    album: LibraryAlbumDto {
                        server_id: row.get(0)?,
                        id: row.get(7)?,
                        name: row.get(8)?,
                        artist: row.get(9)?,
                        artist_id: row.get(10)?,
                        song_count: Some(row.get(11)?),
                        duration_sec: Some(row.get(12)?),
                        year: row.get(13)?,
                        genre: row.get(14)?,
                        cover_art_id: row.get(15)?,
                        starred_at: row.get(16)?,
                        synced_at: row.get(17)?,
                        raw_json: Value::Null,
                    },
                })
            })?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()
    })?;

    let mut seen_albums = HashSet::new();
    let mut albums = Vec::new();
    for row in rows {
        let album_key = row.album_identity_key.unwrap_or_else(|| {
            format!("owner:{}:{}", row.album.server_id, row.album.id)
        });
        if seen_albums.insert(album_key) {
            albums.push(row.album);
        }
    }
    // Same projection columns as All Albums, so the same compilation mislink applies.
    crate::browse_support::overlay_album_artist_links_for_store(store, &mut albums)?;
    Ok(LibraryScopeComposerDetailResponse {
        composer: LibraryArtistDto {
            server_id: server_id.to_string(),
            id: composer_id.to_string(),
            name,
            name_sort: Some(name_sort),
            album_count: Some(albums.len() as i64),
            synced_at,
            raw_json: parse_raw_json(raw_json),
        },
        albums,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};

    fn track(server_id: &str, id: &str, album_id: &str, composer_id: &str, composer: &str) -> TrackRow {
        TrackRow {
            server_id: server_id.into(),
            id: id.into(),
            title: id.into(),
            title_sort: None,
            artist: Some("Performer".into()),
            artist_id: Some("performer".into()),
            album: format!("Album {album_id}"),
            album_id: Some(album_id.into()),
            album_artist: Some("Performer".into()),
            duration_sec: 60,
            track_number: None,
            disc_number: None,
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: Some(album_id.into()),
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: Some("lib".into()),
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
            raw_json: serde_json::json!({
                "contributors": [{ "role": "composer", "artistId": composer_id, "name": composer }]
            })
            .to_string(),
        }
    }

    fn scopes() -> Vec<LibraryScopePair> {
        vec![
            LibraryScopePair { server_id: "s1".into(), library_id: Some("lib".into()) },
            LibraryScopePair { server_id: "s2".into(), library_id: Some("lib".into()) },
        ]
    }

    #[test]
    fn whole_server_scope_includes_empty_library_composers() {
        let store = LibraryStore::open_in_memory();
        let mut empty = track("s1", "t-empty", "a-empty", "c-empty", "Empty Composer");
        empty.library_id = Some(String::new());
        let tagged = track("s1", "t-tagged", "a-tagged", "c-tagged", "Tagged Composer");
        TrackRepository::new(&store)
            .upsert_batch(&[empty, tagged])
            .unwrap();

        let composers = list_composers(
            &store,
            &LibraryScopeListRequest {
                scopes: vec![LibraryScopePair {
                    server_id: "s1".into(),
                    library_id: None,
                }],
                sort: None,
                limit: None,
                offset: None,
            },
        )
        .unwrap();
        assert_eq!(
            composers.iter().map(|composer| composer.name.as_str()).collect::<Vec<_>>(),
            vec!["Empty Composer", "Tagged Composer"]
        );
    }

    #[test]
    fn browse_merges_unique_names_across_servers_and_detail_dedupes_album() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.composer_scope.artist", |conn| {
                conn.execute(
                    "INSERT INTO artist(server_id, id, name, synced_at) VALUES \
                     ('s1', 'performer', 'Performer', 1), \
                     ('s2', 'performer', 'Performer', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let repo = TrackRepository::new(&store);
        let mut first = track("s1", "t1", "a1", "c1", "Composer");
        first.album = "Shared Album".into();
        let mut second = track("s2", "t2", "a2", "c2", "Composer");
        second.album = "Shared Album".into();
        repo.upsert_batch(&[first, second]).unwrap();

        let composers = list_composers(
            &store,
            &LibraryScopeListRequest { scopes: scopes(), sort: None, limit: None, offset: None },
        )
        .unwrap();
        assert_eq!(composers.len(), 1);
        assert_eq!(composers[0].server_id, "s1");
        assert_eq!(composers[0].album_count, Some(1));

        let detail = composer_detail(
            &store,
            &LibraryScopeComposerDetailRequest {
                scopes: scopes(),
                composer_id: "c1".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(detail.albums.len(), 1);
        assert_eq!(detail.composer.server_id, "s1");
    }

    #[test]
    fn ambiguous_same_server_name_stays_separate() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "a1", "c1", "Shared Name"),
                track("s1", "t2", "a2", "c2", "Shared Name"),
                track("s2", "t3", "a3", "c3", "Shared Name"),
            ])
            .unwrap();
        let composers = list_composers(
            &store,
            &LibraryScopeListRequest { scopes: scopes(), sort: None, limit: None, offset: None },
        )
        .unwrap();
        assert_eq!(composers.len(), 3);
    }

    #[test]
    fn stable_composer_id_uses_one_name_and_keeps_every_album() {
        let store = LibraryStore::open_in_memory();
        let mut renamed = track("s1", "t2", "a2", "c1", "New Name");
        renamed.synced_at = 2;
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "a1", "c1", "Old Name"),
                renamed,
            ])
            .unwrap();
        let single_scope = vec![LibraryScopePair {
            server_id: "s1".into(),
            library_id: Some("lib".into()),
        }];
        let composers = list_composers(
            &store,
            &LibraryScopeListRequest {
                scopes: single_scope.clone(),
                sort: None,
                limit: None,
                offset: None,
            },
        )
        .unwrap();
        assert_eq!(composers.len(), 1);
        assert_eq!(composers[0].album_count, Some(2));
        assert_eq!(composers[0].name, "New Name");

        let detail = composer_detail(
            &store,
            &LibraryScopeComposerDetailRequest {
                scopes: single_scope,
                composer_id: "c1".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(detail.albums.len(), 2);
    }
}
