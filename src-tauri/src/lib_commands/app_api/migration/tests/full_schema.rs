use super::*;

fn full_library_schema() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    for migration in [
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/001_initial.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/012_track_genre_legacy_repair.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/013_artist_artwork_lookup.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/014_artist_name_sort.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/015_replay_gain_peak.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/016_multi_library_scope.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/017_library_tag_state.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/018_artist_synced_index.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/019_mainstage_feed_indexes.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/020_scope_browse_projection.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/021_scope_browse_tracks.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/022_artist_name_fold.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/023_starred_browse_indexes.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/024_composer_browse_projection.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/025_identity_invalidation.sql"
        )),
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/crates/psysonic-library/migrations/026_library_tag_cursor.sql"
        )),
    ] {
        conn.execute_batch(migration)
            .expect("apply library migration");
    }
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .expect("enable foreign keys");
    conn
}

fn populate_all_library_scopes(conn: &Connection) {
    conn.execute_batch(
        "INSERT INTO canonical_track(id, created_at, updated_at) VALUES ('canonical-1', 1, 1);
         INSERT INTO sync_state(server_id, library_scope) VALUES ('legacy-a', '');
         INSERT INTO artist(server_id, id, name, synced_at) VALUES ('legacy-a', 'artist-1', 'Artist', 1);
         INSERT INTO album(server_id, id, name, synced_at) VALUES ('legacy-a', 'album-1', 'Album', 1);
         INSERT INTO track(server_id, id, title, album, duration_sec, synced_at, raw_json)
           VALUES ('legacy-a', 'track-1', 'Track', 'Album', 1, 1, '{}');
         INSERT INTO track_extension(server_id, track_id, kind, payload, updated_at)
           VALUES ('legacy-a', 'track-1', 'waveform', X'01', 1);
         INSERT INTO track_fact(server_id, track_id, fact_kind, source_kind, source_id, fetched_at)
           VALUES ('legacy-a', 'track-1', 'bpm', 'server', 'source', 1);
         INSERT INTO track_artifact(server_id, track_id, artifact_kind, format, source_kind, source_id, fetched_at)
           VALUES ('legacy-a', 'track-1', 'lyrics', 'text', 'server', 'source', 1);
         INSERT INTO track_canonical_link(server_id, track_id, canonical_id, match_method, confidence, linked_at)
           VALUES ('legacy-a', 'track-1', 'canonical-1', 'isrc', 1.0, 1);
         INSERT INTO track_id_history(server_id, old_id, new_id, remapped_at)
           VALUES ('legacy-a', 'old-track', 'track-1', 1);
         INSERT INTO play_session(server_id, track_id, started_at_ms, listened_sec, position_max_sec, completion, end_reason)
           VALUES ('legacy-a', 'track-1', 1, 1.0, 1.0, 'full', 'ended');
         INSERT INTO track_offline(server_id, track_id, local_path, cached_at)
           VALUES ('legacy-a', 'track-1', '/tmp/track-1', 1);
         INSERT INTO track_genre(server_id, track_id, genre, album_id)
           VALUES ('legacy-a', 'track-1', 'Rock', 'album-1');
         INSERT INTO artist_artwork_lookup(server_id, artist_id, surface_kind, status, updated_at)
           VALUES ('legacy-a', 'artist-1', 'fanart', 'hit', 1);
          INSERT INTO library_tag_state(server_id, folders_hash, completed_at)
            VALUES ('legacy-a', 'hash', 1);
          INSERT INTO library_tag_cursor(server_id, folders_hash, next_folder_id, updated_at)
            VALUES ('legacy-a', 'hash', 'folder-1', 1);
         INSERT INTO entity_user_rating(server_id, entity_kind, entity_id, rating, fetched_at)
           VALUES ('legacy-a', 'track', 'track-1', 5, 1);
          INSERT INTO album_browse_projection(
           server_id, library_id, album_id, name, song_count, duration_sec, synced_at, representative_track_id
          ) VALUES ('legacy-a', '', 'album-1', 'Album', 1, 1, 1, 'track-1');
          INSERT INTO composer_album_projection(
            server_id, library_id, composer_id, composer_name, name_sort, identity_key,
            album_id, synced_at, representative_track_id
          ) VALUES ('legacy-a', '', 'composer-1', 'Composer', 'composer', 'composer',
                    'album-1', 1, 'track-1');
         INSERT INTO canonical_enrichment_link(
           canonical_id, enrichment_kind, owner_server_id, owner_track_id, linked_at
         ) VALUES ('canonical-1', 'lyrics', 'legacy-a', 'track-1', 1);",
    )
    .expect("populate every server-scoped table");
}

#[test]
fn full_library_schema_rewrites_every_server_scope_and_keeps_foreign_keys_clean() {
    let conn = full_library_schema();
    populate_all_library_scopes(&conn);
    let mappings = vec![ServerIndexMapping {
        legacy_id: "legacy-a".to_string(),
        index_key: "index-a".to_string(),
    }];

    with_foreign_keys_disabled(&conn, || {
        rewrite_scoped_tables(&conn, LIBRARY_TABLES, &mappings, None, |_| Ok(()))
    })
    .expect("rewrite populated production schema");

    for table in LIBRARY_TABLES {
        assert_eq!(
            count_rows_eq(&conn, *table, "legacy-a").unwrap(),
            0,
            "legacy rows remain in {}.{}",
            table.table,
            table.column
        );
        assert_eq!(
            count_rows_eq(&conn, *table, "index-a").unwrap(),
            1,
            "rewritten row missing from {}.{}",
            table.table,
            table.column
        );
    }
    ensure_foreign_keys_clean(&conn).expect("rewritten production schema foreign keys");
}
