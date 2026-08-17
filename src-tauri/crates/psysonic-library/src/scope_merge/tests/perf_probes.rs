/// Manual perf probe:
/// `cargo test --workspace scope_merge::tests::perf_probe_album_browse -- --ignored --nocapture`
#[test]
#[ignore]
fn perf_probe_album_browse() {
    use std::time::Instant;

    let store = LibraryStore::open_in_memory();
    // User-reported scale: ~4000 albums × 5 tracks = 20000 tracks over 3 libs.
    let albums = 4000usize;
    let tracks_per_album = 5usize;
    let artists = 200usize;
    let mut rows = Vec::with_capacity(albums * tracks_per_album);
    for a in 0..albums {
        let lib = match a % 3 {
            0 => "lib-a",
            1 => "lib-b",
            _ => "lib-c",
        };
        for t in 0..tracks_per_album {
            rows.push(track(
                "s1",
                &format!("t-{a}-{t}"),
                &format!("Song {t}"),
                Some(&format!("Artist {}", a % artists)),
                &format!("Album {a:05}"),
                &format!("alb-{a:05}"),
                Some(&format!("ar-{}", a % artists)),
                180 + t as i64,
                lib,
                Some(1990 + (a % 30) as i64),
                Some("Rock"),
                Some(&format!("cov-{a:05}")),
            ));
        }
    }
    seed_and_rebuild(&store, &rows);
    let scopes = vec![
        scope_pair("s1", "lib-a"),
        scope_pair("s1", "lib-b"),
        scope_pair("s1", "lib-c"),
    ];

    // Exact FE album path: `libraryAdvancedSearch` (empty filter) -> multi-scope
    // -> `list_albums_filtered` with skip_totals = true, PAGE_SIZE ~ 100.
    let time_albums = |offset: u32| {
        let start = Instant::now();
        let (rows, _total) = list_albums_filtered(
            &store,
            &scopes,
            "",
            &[],
            "ORDER BY album COLLATE NOCASE ASC, album_id ASC",
            100,
            offset,
            true,
        )
        .unwrap();
        (start.elapsed(), rows.len())
    };
    let _ = time_albums(0);
    let (t_first, n_first) = time_albums(0);
    let (t_deep, n_deep) = time_albums(2000);
    println!("--- list_albums_filtered (4000 albums, 20000 tracks, 3 libs, skip_totals) ---");
    println!("  offset 0    -> {:?} ({n_first} rows)", t_first);
    println!("  offset 2000 -> {:?} ({n_deep} rows)", t_deep);

    let two = vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")];
    let time_two = || {
        let start = Instant::now();
        let (rows, _t) = list_albums_filtered(
            &store,
            &two,
            "",
            &[],
            "ORDER BY album COLLATE NOCASE ASC, album_id ASC",
            100,
            0,
            true,
        )
        .unwrap();
        (start.elapsed(), rows.len())
    };
    let _ = time_two();
    let (t_two, n_two) = time_two();
    println!("  2-lib subset offset 0 -> {t_two:?} ({n_two} rows)");

    let time_artists = || {
        let req = LibraryScopeListRequest {
            scopes: scopes.clone(),
            sort: None,
            limit: Some(100),
            offset: Some(0),
        };
        let start = Instant::now();
        let n = list_artists(&store, &req).unwrap().len();
        (start.elapsed(), n)
    };
    let _ = time_artists();
    let (a_first, an_first) = time_artists();
    println!("--- list_artists ({artists} artists, 20000 tracks, 3 libs) ---");
    println!("  run -> {:?} ({an_first} rows)", a_first);

    let (cte, _b) = scope_cte_sql(&scopes);
    let plan_sql = format!(
        "EXPLAIN QUERY PLAN {cte}, base AS ( \
               SELECT t.album_id, t.duration_sec, t.id, s.pr, \
                      {ALBUM_DEDUP_KEY} AS album_dedup, {TRACK_DEDUP_KEY} AS track_dedup \
               {join} AND t.album_id IS NOT NULL AND t.album_id != '' \
             ) SELECT album_dedup FROM base GROUP BY album_dedup LIMIT 100",
        join = scoped_track_join(),
    );
    let plan: Vec<String> = store
        .with_read_conn(|c| {
            let mut stmt = c.prepare(&plan_sql)?;
            let rows = stmt
                .query_map(["s1", "lib-a", "s1", "lib-b", "s1", "lib-c"], |r| {
                    r.get::<_, String>(3)
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap();
    println!("--- multi-scope album query plan ---");
    for step in plan {
        println!("  {step}");
    }
}

/// Local benchmark on a real library DB:
/// `PSYSONIC_LIBRARY_DB=~/.local/share/.../library.sqlite cargo test --workspace perf_probe_real_db -- --ignored --nocapture`
#[test]
#[ignore]
fn perf_probe_real_db() {
    use std::path::PathBuf;
    use std::time::Instant;

    let db = std::env::var("PSYSONIC_LIBRARY_DB").unwrap_or_else(|_| {
        format!(
            "{}/.local/share/dev.psysonic.player/databases/library/library.sqlite",
            std::env::var("HOME").unwrap_or_default()
        )
    });
    let path = PathBuf::from(&db);
    if !path.exists() {
        println!("skip: DB not found at {db}");
        return;
    }
    let store = LibraryStore::open_path_for_test(&path).expect("open db");
    let server_id: String = std::env::var("PSYSONIC_LIBRARY_SERVER").unwrap_or_else(|_| {
        store
            .with_read_conn(|c| {
                c.query_row(
                    "SELECT server_id FROM track WHERE deleted = 0 \
                         GROUP BY server_id ORDER BY COUNT(*) DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
            })
            .expect("server id")
    });
    let libs: Vec<(String, i64)> = store
        .with_read_conn(|c| {
            let mut stmt = c.prepare(
                "SELECT library_id, COUNT(*) FROM track \
                     WHERE deleted = 0 AND server_id = ?1 AND COALESCE(library_id, '') != '' \
                     GROUP BY library_id ORDER BY 2 DESC LIMIT 5",
            )?;
            let rows = stmt
                .query_map([&server_id], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("libs");
    println!("server={server_id} libs={libs:?}");
    if libs.len() < 2 {
        println!("need at least 2 tagged libraries");
        return;
    }
    let scopes: Vec<LibraryScopePair> = libs[..2]
        .iter()
        .map(|(lib, _)| scope_pair(&server_id, lib))
        .collect();
    let order = "ORDER BY album COLLATE NOCASE ASC, album_id ASC".to_string();

    let bench = |label: &str, scopes: &[LibraryScopePair]| {
        let _ = list_albums_layer1_filtered(
            &store,
            scopes,
            "",
            &[],
            &order,
            &order,
            100,
            0,
            true,
            false,
        );
        let start = Instant::now();
        let (rows, _) = list_albums_layer1_filtered(
            &store,
            scopes,
            "",
            &[],
            &order,
            &order,
            100,
            0,
            true,
            false,
        )
        .unwrap();
        println!("  {label}: {:?} ({} albums)", start.elapsed(), rows.len());
    };

    let bench_all_libs = || {
        let sql = "SELECT t.album_id FROM track t \
                WHERE t.deleted = 0 AND t.server_id = ?1 AND t.album_id IS NOT NULL AND t.album_id != '' \
                GROUP BY t.album_id ORDER BY MAX(t.album) COLLATE NOCASE ASC LIMIT 100";
        let _ = store.with_read_conn(|c| {
            let mut s = c.prepare(sql)?;
            let rows = s
                .query_map([&server_id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.len())
        });
        let start = Instant::now();
        let n = store
            .with_read_conn(|c| {
                let mut s = c.prepare(sql)?;
                let rows = s
                    .query_map([&server_id], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows.len())
            })
            .unwrap();
        println!(
            "  all libs (legacy GROUP BY): {:?} ({n} albums)",
            start.elapsed()
        );
    };

    println!("--- layer1 album browse (real DB) ---");
    bench_all_libs();
    bench("1 lib", &[scopes[0].clone()]);
    bench("2 libs", &scopes);
}
