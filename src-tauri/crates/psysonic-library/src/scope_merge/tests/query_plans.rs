#[test]
fn artist_dedup_collapses_across_libraries() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            track(
                "s1",
                "t-a1",
                "S1",
                Some("Shared"),
                "Al1",
                "alb1",
                Some("artist-x"),
                100,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s1",
                "t-b1",
                "S2",
                Some("Shared"),
                "Al2",
                "alb2",
                Some("artist-y"),
                100,
                "lib-b",
                None,
                None,
                None,
            ),
        ],
    );
    let req = LibraryScopeListRequest {
        scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
        sort: None,
        limit: Some(10),
        offset: None,
    };
    let artists = list_artists(&store, &req).unwrap();
    assert_eq!(artists.len(), 1);
    assert_eq!(artists[0].name, "Shared");
}

#[test]
fn album_credit_lookup_uses_name_fold_index() {
    let store = LibraryStore::open_in_memory();
    let plan: Vec<String> = store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "EXPLAIN QUERY PLAN \
                     SELECT ar.id FROM artist ar \
                     WHERE ar.server_id = 's1' AND ar.name_fold = psysonic_lower_name('Кино')",
            )?;
            let rows = stmt.query_map([], |row| row.get(3))?;
            rows.collect()
        })
        .unwrap();
    assert!(
        plan.iter()
            .any(|detail| detail.contains("idx_artist_name_fold")),
        "expected name-fold index lookup, got: {plan:?}"
    );
}

/// #1360: the layer-1 artist browse joins a CTE to `artist` through
/// `psysonic_lower_name`, which the planner cannot cost. Left to choose, it
/// drove from `artist` and re-scanned the CTE per row — on a 172k-track
/// library that query never returned.
///
/// Unlike the index-choice guard in #1359, a plan assertion **does** work
/// here, and it was checked rather than assumed: with the `CROSS` removed
/// this same empty database reports `SEARCH ar … / SCAN ac`, the exact bad
/// order measured on the real library. Nothing about the choice depends on
/// row counts — a CTE has no statistics, so SQLite applies the same default
/// estimate whether the table holds three rows or three hundred thousand.
///
/// `EXPLAIN` also prepares the statement, so a dropped or narrowed
/// `idx_artist_name_fold` fails here too: `INDEXED BY` on an unusable index
/// is a prepare-time error.
#[test]
fn layer1_artist_credit_join_drives_from_the_cte() {
    let store = LibraryStore::open_in_memory();
    let sql = format!(
        "EXPLAIN QUERY PLAN \
             WITH album_scoped(album_id, credit_name) AS (SELECT NULL, NULL) \
             SELECT DISTINCT ar.id FROM album_scoped ac {LAYER1_ARTIST_CREDIT_JOIN_SQL}"
    );
    let plan: Vec<String> = store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params!["s1"], |row| row.get(3))?;
            rows.collect()
        })
        .unwrap();

    let scan_ac = plan.iter().position(|step| step.contains("SCAN ac"));
    let search_ar = plan
        .iter()
        .position(|step| step.contains("SEARCH ar USING INDEX idx_artist_name_fold"));
    assert!(
        scan_ac.is_some() && search_ar.is_some() && scan_ac < search_ar,
        "the CTE must be the outer loop and `artist` the indexed inner lookup, got: {plan:?}"
    );
}

fn detail_key_query_plan(key_column: &'static str, key: &str) -> Vec<String> {
    let store = LibraryStore::open_in_memory();
    let scopes = vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")];
    let (scope_cte, mut binds) = scope_cte_sql(&scopes);
    let (cte, scoped, _, _) = keyed_detail_track_source(scope_cte, Some(key_column), "");
    binds.push(SqlValue::Text(key.into()));
    let sql = format!("EXPLAIN QUERY PLAN {cte} SELECT t.id {scoped}");
    store
        .with_scope_detail_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(binds.iter()), |row| row.get(3))?;
            rows.collect()
        })
        .unwrap()
}

#[test]
fn album_detail_uses_scope_album_key_index() {
    let plan = detail_key_query_plan("album_key", "album-key");

    assert!(
        plan.iter()
            .any(|detail| detail.contains("idx_ck_scope_album")),
        "expected scope album-key index lookup, got: {plan:?}"
    );
    assert!(
        plan.iter()
            .any(|detail| detail.contains("sqlite_autoindex_track_1")),
        "expected track primary-key lookup, got: {plan:?}"
    );
}

#[test]
fn artist_detail_uses_scope_artist_key_index() {
    let plan = detail_key_query_plan("artist_key", "artist-key");

    assert!(
        plan.iter()
            .any(|detail| detail.contains("idx_ck_scope_artist")),
        "expected scope artist-key index lookup, got: {plan:?}"
    );
    assert!(
        plan.iter()
            .any(|detail| detail.contains("sqlite_autoindex_track_1")),
        "expected track primary-key lookup, got: {plan:?}"
    );
}
