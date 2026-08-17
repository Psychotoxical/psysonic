use super::support::{insert_artist_with_album_count, req, scope_pair, scoped_track};
use crate::advanced_search::run_advanced_search;
use crate::dto::ArtistCreditMode;
use crate::filter::EntityKind;
use crate::repos::TrackRepository;
use crate::store::LibraryStore;

#[test]
fn single_scope_artists_do_not_block_on_cluster_key_rebuild() {
    let store = LibraryStore::open_in_memory();
    insert_artist_with_album_count(&store, "s1", "ar_in", "In Sampler", Some(1));
    insert_artist_with_album_count(&store, "s1", "ar_out", "Outside", Some(1));
    let mut t_in = scoped_track(
        "s1",
        "t-in",
        "Song",
        "In Sampler",
        "Alb",
        "alb-in",
        "sampler",
        None,
        None,
        None,
    );
    t_in.artist_id = Some("ar_in".into());
    let mut t_out = scoped_track(
        "s1",
        "t-out",
        "Song",
        "Outside",
        "Alb2",
        "alb-out",
        "other-lib",
        None,
        None,
        None,
    );
    t_out.artist_id = Some("ar_out".into());
    TrackRepository::new(&store)
        .upsert_batch(&[t_in, t_out])
        .unwrap();
    crate::identity::rebuild_cluster_keys(&store, None).unwrap();
    store
        .with_conn_mut("test.stale_identity", |conn| {
            conn.execute(
                "UPDATE cluster.cluster_meta SET value = 'stale' WHERE key = 'norm_version'",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    let mut r = req("s1", &[EntityKind::Artist]);
    r.library_scopes = Some(vec![scope_pair("s1", "sampler")]);
    r.artist_credit_mode = Some(ArtistCreditMode::Album);
    let resp = run_advanced_search(&store, &r).unwrap();
    let ids: Vec<&str> = resp.artists.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(ids, vec!["ar_in"]);
    assert!(
        store
            .with_read_conn(crate::identity::cluster_rebuild_needed)
            .unwrap(),
        "single-scope album artists must not trigger identity maintenance"
    );

    r.artist_credit_mode = Some(ArtistCreditMode::Track);
    let resp = run_advanced_search(&store, &r).unwrap();
    let ids: Vec<&str> = resp.artists.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(ids, vec!["ar_in"]);
    assert!(
        store
            .with_read_conn(crate::identity::cluster_rebuild_needed)
            .unwrap(),
        "single-scope track artists must not trigger identity maintenance"
    );
}

#[test]
fn album_credit_mode_layer1_scope_excludes_backfill_track_performers() {
    let store = LibraryStore::open_in_memory();
    insert_artist_with_album_count(&store, "s1", "ar_real", "Real Band", Some(2));
    insert_artist_with_album_count(&store, "s1", "ar_guest", "Sampler Guest", None);
    let mut t_guest = scoped_track(
        "s1",
        "t-va",
        "Track One",
        "Sampler Guest",
        "VA Sampler",
        "alb-va",
        "sampler",
        None,
        None,
        None,
    );
    t_guest.artist_id = Some("ar_guest".into());
    t_guest.album_artist = Some("Various Artists".into());
    let mut t_real = scoped_track(
        "s1",
        "t-real",
        "Song",
        "Real Band",
        "Real Album",
        "alb-real",
        "sampler",
        None,
        None,
        None,
    );
    t_real.artist_id = Some("ar_real".into());
    TrackRepository::new(&store)
        .upsert_batch(&[t_guest, t_real])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.library_scopes = Some(vec![scope_pair("s1", "sampler")]);
    r.artist_credit_mode = Some(ArtistCreditMode::Album);
    let resp = run_advanced_search(&store, &r).unwrap();
    let ids: Vec<&str> = resp.artists.iter().map(|a| a.id.as_str()).collect();
    assert!(
        !ids.contains(&"ar_guest"),
        "backfill performer must not appear in album mode"
    );
    assert!(ids.contains(&"ar_real"));
}

#[test]
fn multi_scope_artist_browse_without_cluster_keys_returns_scoped_artists() {
    let store = LibraryStore::open_in_memory();
    insert_artist_with_album_count(&store, "s1", "ar_Alpha", "Alpha", Some(1));
    insert_artist_with_album_count(&store, "s1", "ar_Beta", "Beta", Some(1));
    let mut t1 = scoped_track(
        "s1", "t-a", "Song", "Alpha", "Alb", "alb-a", "lib-a", None, None, None,
    );
    t1.artist_id = Some("ar_Alpha".into());
    let mut t2 = scoped_track(
        "s1", "t-b", "Song", "Beta", "Alb2", "alb-b", "lib-b", None, None, None,
    );
    t2.artist_id = Some("ar_Beta".into());
    TrackRepository::new(&store)
        .upsert_batch(&[t1, t2])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")]);
    r.artist_credit_mode = Some(ArtistCreditMode::Album);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.artists.len(), 2);
}

#[test]
fn multi_scope_album_artist_search_matches_cyrillic_prefixes() {
    let store = LibraryStore::open_in_memory();
    insert_artist_with_album_count(&store, "s1", "ar_kino", "Кино", Some(1));
    insert_artist_with_album_count(&store, "s2", "ar_kinoproby", "Кинопробы", Some(1));
    let mut kino = scoped_track(
        "s1", "t-kino", "Song", "Кино", "Album", "alb-kino", "lib-a", None, None, None,
    );
    kino.artist_id = Some("ar_kino".into());
    let mut kinoproby = scoped_track(
        "s2",
        "t-kinoproby",
        "Song",
        "Кинопробы",
        "Album",
        "alb-kinoproby",
        "lib-b",
        None,
        None,
        None,
    );
    kinoproby.artist_id = Some("ar_kinoproby".into());
    TrackRepository::new(&store)
        .upsert_batch(&[kino, kinoproby])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")]);
    r.artist_credit_mode = Some(ArtistCreditMode::Album);
    r.query = Some("Кино".into());
    let resp = run_advanced_search(&store, &r).unwrap();

    assert_eq!(
        resp.artists
            .iter()
            .map(|artist| artist.id.as_str())
            .collect::<Vec<_>>(),
        vec!["ar_kino", "ar_kinoproby"],
    );
}

#[test]
fn multi_scope_track_artist_search_matches_cyrillic_prefixes() {
    let store = LibraryStore::open_in_memory();
    let mut kino = scoped_track(
        "s1", "t-kino", "Song", "Кино", "Album", "alb-kino", "lib-a", None, None, None,
    );
    kino.artist_id = Some("ar_kino".into());
    let mut kinoproby = scoped_track(
        "s2",
        "t-kinoproby",
        "Song",
        "Кинопробы",
        "Album",
        "alb-kinoproby",
        "lib-b",
        None,
        None,
        None,
    );
    kinoproby.artist_id = Some("ar_kinoproby".into());
    TrackRepository::new(&store)
        .upsert_batch(&[kino, kinoproby])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")]);
    r.artist_credit_mode = Some(ArtistCreditMode::Track);
    r.query = Some("Кино".into());
    let resp = run_advanced_search(&store, &r).unwrap();

    assert_eq!(
        resp.artists
            .iter()
            .map(|artist| artist.id.as_str())
            .collect::<Vec<_>>(),
        vec!["ar_kino", "ar_kinoproby"],
    );
}

#[test]
fn layer1_album_artist_search_matches_cyrillic_credit_case_variants() {
    let store = LibraryStore::open_in_memory();
    insert_artist_with_album_count(&store, "s1", "ar_kino", "Кино", Some(1));
    insert_artist_with_album_count(&store, "s1", "ar_kinoproby", "КИНО-пробы", Some(1));
    let mut kino = scoped_track(
        "s1", "t-kino", "Song", "Кино", "Album", "alb-kino", "lib-a", None, None, None,
    );
    kino.artist_id = Some("ar_kino".into());
    let mut kinoproby = scoped_track(
        "s1",
        "t-kinoproby",
        "Song",
        "Кино-пробы",
        "Album",
        "alb-kinoproby",
        "lib-b",
        None,
        None,
        None,
    );
    kinoproby.artist_id = Some("ar_kinoproby".into());
    TrackRepository::new(&store)
        .upsert_batch(&[kino, kinoproby])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")]);
    r.artist_credit_mode = Some(ArtistCreditMode::Album);
    r.query = Some("Кино".into());
    let resp = run_advanced_search(&store, &r).unwrap();

    assert_eq!(
        resp.artists
            .iter()
            .map(|artist| artist.id.as_str())
            .collect::<Vec<_>>(),
        vec!["ar_kino", "ar_kinoproby"],
    );
}

#[test]
fn multi_server_album_artist_search_uses_album_credit_not_track_performer() {
    let store = LibraryStore::open_in_memory();
    insert_artist_with_album_count(&store, "s1", "ar-kino", "КИНО-пробы", Some(1));
    insert_artist_with_album_count(&store, "s2", "ar-other", "Other", Some(1));
    let mut sampler_track = scoped_track(
        "s1",
        "t-sampler",
        "Song",
        "Guest Performer",
        "Tribute",
        "alb-tribute",
        "lib-a",
        None,
        None,
        None,
    );
    sampler_track.artist_id = Some("ar-guest".into());
    sampler_track.album_artist = Some("Кино-пробы".into());
    let mut other_track = scoped_track(
        "s2",
        "t-other",
        "Song",
        "Other",
        "Other Album",
        "alb-other",
        "lib-b",
        None,
        None,
        None,
    );
    other_track.artist_id = Some("ar-other".into());
    TrackRepository::new(&store)
        .upsert_batch(&[sampler_track, other_track])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")]);
    r.artist_credit_mode = Some(ArtistCreditMode::Album);
    r.query = Some("Кино".into());
    let resp = run_advanced_search(&store, &r).unwrap();

    assert_eq!(
        resp.artists
            .iter()
            .map(|artist| artist.id.as_str())
            .collect::<Vec<_>>(),
        vec!["ar-kino"],
    );
}
