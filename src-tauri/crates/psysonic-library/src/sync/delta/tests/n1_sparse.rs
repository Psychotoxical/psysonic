// ── N1 native delta preserves richer OpenSubsonic raw fields ─────

#[tokio::test(flavor = "multi_thread")]
async fn n1_delta_preserves_structured_artist_refs_when_native_row_omits_them() {
    let server = MockServer::start().await;

    // Trigger DS-4 with an artists watermark change. The same response also
    // satisfies the DS-9 refresh after ingest.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "artists": {
                    "lastModified": 1_717_200_000_000_i64,
                    "ignoredArticles": "",
                    "index": []
                }
            }
        })))
        .mount(&server)
        .await;

    // Navidrome native /api/song carries the flat display artist but omits
    // OpenSubsonic `artists[]`. This is the shape that previously replaced the
    // richer raw_json and collapsed "FOVOS, Max Cardona" into one UI artist.
    Mock::given(wm_method("GET"))
        .and(wm_path("/api/song"))
        .and(query_param("_start", "0"))
        .and(query_param("_sort", "updated_at"))
        .and(query_param("_order", "DESC"))
        .and(header("X-ND-Authorization", "Bearer nd-tok"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {
                "id": "tr_existing",
                "title": "Adore You (Extended Mix)",
                "artist": "FOVOS, Max Cardona",
                "artistId": "fovos",
                "updatedAt": "2024-06-01T00:00:00Z"
            }
        ])))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    seed_track(&store, "tr_existing", "al_x", 1_714_521_600_000);

    let rich_raw = json!({
        "id": "tr_existing",
        "title": "Adore You (Extended Mix)",
        "artist": "FOVOS, Max Cardona",
        "artistId": "fovos",
        "displayArtist": "FOVOS, Max Cardona",
        "artists": [
            { "id": "fovos", "name": "FOVOS" },
            { "id": "max-cardona", "name": "Max Cardona" }
        ],
        "albumArtists": [
            { "id": "fovos", "name": "FOVOS" },
            { "id": "max-cardona", "name": "Max Cardona" }
        ]
    })
    .to_string();

    store
        .with_conn("misc", |c| {
            c.execute(
                "UPDATE track SET artist = ?1, artist_id = ?2, raw_json = ?3 \
                 WHERE server_id = 's1' AND id = 'tr_existing'",
                rusqlite::params!["FOVOS, Max Cardona", "fovos", rich_raw],
            )?;
            Ok(())
        })
        .unwrap();

    let nav = NavidromeProbeCredentials {
        server_url: server.uri(),
        bearer_token: "nd-tok".into(),
    };
    let subsonic = test_subsonic(&server.uri());
    let report = DeltaSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(
            CapabilityFlags::NAVIDROME_NATIVE_BULK
                | CapabilityFlags::UNSTABLE_TRACK_IDS,
        ),
    )
    .with_navidrome_credentials(nav)
    .with_batch_size(10)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert_eq!(report.strategy.as_deref(), Some("n1"));
    assert_eq!(report.changed_count, 1);

    let (title, raw): (String, String) = store
        .with_read_conn(|c| {
            c.query_row(
                "SELECT title, raw_json FROM track \
                 WHERE server_id = 's1' AND id = 'tr_existing'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(title, "Adore You (Extended Mix)");

    let raw: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let artists = raw
        .get("artists")
        .and_then(|v| v.as_array())
        .expect("structured artists[] must survive sparse N1 delta");
    assert_eq!(artists.len(), 2);
    assert_eq!(artists[0].get("name").and_then(|v| v.as_str()), Some("FOVOS"));
    assert_eq!(
        artists[1].get("name").and_then(|v| v.as_str()),
        Some("Max Cardona")
    );

    let album_artists = raw
        .get("albumArtists")
        .and_then(|v| v.as_array())
        .expect("albumArtists[] must survive sparse N1 delta");
    assert_eq!(album_artists.len(), 2);
}
