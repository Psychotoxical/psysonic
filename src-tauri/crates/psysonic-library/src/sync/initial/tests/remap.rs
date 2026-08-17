use super::support::*;

// ── Remap path (§6.9) — exercised on delta / full upsert, not IS-3 bulk ─

#[test]
fn remap_fires_on_unstable_track_ids_batch_upsert() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[TrackRow {
        server_id: "s1".into(),
        id: "tr_old".into(),
        title: "Aurora".into(),
        title_sort: None,
        artist: Some("A".into()),
        artist_id: None,
        album: "An Album".into(),
        album_id: None,
        album_artist: None,
        duration_sec: 240,
        track_number: None,
        disc_number: None,
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
        server_path: Some("/path/aurora.flac".into()),
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
    }])
    .unwrap();

    let stats = repo
        .upsert_batch_with_remap(
            &[TrackRow {
                server_id: "s1".into(),
                id: "tr_new".into(),
                title: "Aurora".into(),
                title_sort: None,
                artist: Some("A".into()),
                artist_id: None,
                album: "An Album".into(),
                album_id: None,
                album_artist: None,
                duration_sec: 240,
                track_number: None,
                disc_number: None,
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
                server_path: Some("/path/aurora.flac".into()),
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
                synced_at: 2,
                raw_json: "{}".into(),
            }],
            true,
        )
        .unwrap();
    assert_eq!(stats.remapped.len(), 1);

    let ids: Vec<String> = store
        .with_conn("misc", |c| {
            let mut s = c.prepare("SELECT id FROM track WHERE server_id='s1' ORDER BY id")?;
            let r: rusqlite::Result<Vec<String>> = s.query_map([], |r| r.get(0))?.collect();
            r
        })
        .unwrap();
    assert_eq!(ids, vec!["tr_new"]);
}
