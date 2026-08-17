use crate::dto::{LibraryAdvancedSearchRequest, LibraryFilterClause, LibraryScopePair};
use crate::filter::{EntityKind, FilterOp};
use crate::repos::{TrackRepository, TrackRow};
use crate::store::LibraryStore;
use serde_json::Value;

pub(super) fn track(server: &str, id: &str, title: &str, artist: &str, album: &str) -> TrackRow {
    TrackRow {
        server_id: server.into(),
        id: id.into(),
        title: title.into(),
        title_sort: None,
        artist: Some(artist.into()),
        artist_id: Some(format!("ar_{artist}")),
        album: album.into(),
        album_id: Some(format!("al_{album}")),
        album_artist: Some(artist.into()),
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
    }
}

pub(super) fn insert_album(
    store: &LibraryStore,
    server: &str,
    id: &str,
    name: &str,
    year: Option<i64>,
    genre: Option<&str>,
) {
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO album (server_id, id, name, year, genre, synced_at, raw_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, '{}')",
                rusqlite::params![server, id, name, year, genre],
            )
        })
        .unwrap();
}

pub(super) fn insert_artist(store: &LibraryStore, server: &str, id: &str, name: &str) {
    insert_artist_with_album_count(store, server, id, name, Some(1));
}

pub(super) fn insert_artist_with_album_count(
    store: &LibraryStore,
    server: &str,
    id: &str,
    name: &str,
    album_count: Option<i64>,
) {
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO artist (server_id, id, name, name_sort, name_fold, album_count, synced_at, raw_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, '{}')",
                rusqlite::params![
                    server,
                    id,
                    name,
                    crate::artist_sort::sort_key_for_display_name(
                        name,
                        crate::artist_sort::DEFAULT_IGNORED_ARTICLES,
                    ),
                    name.trim().to_lowercase(),
                    album_count,
                ],
            )
        })
        .unwrap();
}

pub(super) fn req(server: &str, entities: &[EntityKind]) -> LibraryAdvancedSearchRequest {
    LibraryAdvancedSearchRequest {
        server_id: server.into(),
        library_scope: None,
        library_scopes: None,
        query: None,
        entity_types: entities.to_vec(),
        filters: Vec::new(),
        starred_only: None,
        restrict_album_ids: None,
        query_album_title_only: None,
        sort: Vec::new(),
        limit: 50,
        offset: 0,
        skip_totals: false,
        artist_credit_mode: None,
        artist_letter_bucket: None,
    }
}

pub(super) fn clause(
    field: &str,
    op: FilterOp,
    value: Option<Value>,
    value_to: Option<Value>,
) -> LibraryFilterClause {
    LibraryFilterClause {
        field: field.into(),
        op,
        value,
        value_to,
    }
}

pub(super) fn insert_album_raw(
    store: &LibraryStore,
    server: &str,
    id: &str,
    name: &str,
    raw_json: &str,
) {
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO album (server_id, id, name, synced_at, raw_json) \
                 VALUES (?1, ?2, ?3, 1, ?4)",
                rusqlite::params![server, id, name, raw_json],
            )
        })
        .unwrap();
}

pub(super) fn scope_pair(server: &str, lib: &str) -> LibraryScopePair {
    LibraryScopePair {
        server_id: server.into(),
        library_id: Some(lib.into()),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn scoped_track(
    server: &str,
    id: &str,
    title: &str,
    artist: &str,
    album: &str,
    album_id: &str,
    library_id: &str,
    genre: Option<&str>,
    year: Option<i64>,
    starred_at: Option<i64>,
) -> TrackRow {
    let mut t = track(server, id, title, artist, album);
    t.album_id = Some(album_id.into());
    t.library_id = Some(library_id.into());
    t.genre = genre.map(str::to_string);
    t.year = year;
    t.starred_at = starred_at;
    t
}

pub(super) fn seed_and_rebuild(store: &LibraryStore, rows: &[TrackRow]) {
    TrackRepository::new(store).upsert_batch(rows).unwrap();
    store
        .with_conn_mut("test.seed_scoped_artists", |conn| {
            for row in rows {
                let (Some(artist_id), Some(artist)) =
                    (row.artist_id.as_deref(), row.artist.as_deref())
                else {
                    continue;
                };
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) VALUES (?1, ?2, ?3, 1) \
                     ON CONFLICT(server_id, id) DO NOTHING",
                    rusqlite::params![&row.server_id, artist_id, artist],
                )?;
            }
            Ok(())
        })
        .unwrap();
    crate::identity::rebuild_cluster_keys(store, None).unwrap();
}
