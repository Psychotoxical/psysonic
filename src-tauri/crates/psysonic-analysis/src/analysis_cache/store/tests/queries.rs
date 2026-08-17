use super::*;

#[test]
fn get_latest_waveform_finds_row_under_other_variant() {
    let cache = AnalysisCache::open_in_memory();
    let k = key("stream:abc");
    cache.touch_track_status(&k, "ok").unwrap();
    cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
    // Insert under stream:abc, look up with bare abc.
    let got = cache
        .get_latest_waveform_for_track("server-a", "abc")
        .unwrap();
    assert!(
        got.is_some(),
        "bare-id lookup must find stream-prefixed row"
    );
}

#[test]
fn get_latest_loudness_finds_row_under_other_variant() {
    let cache = AnalysisCache::open_in_memory();
    let k = key("abc");
    cache.touch_track_status(&k, "ok").unwrap();
    cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
    let got = cache
        .get_latest_loudness_for_track("server-a", "stream:abc")
        .unwrap();
    assert!(got.is_some(), "stream-prefixed lookup must find bare row");
}

#[test]
fn cpu_seed_redundant_requires_both_waveform_and_loudness() {
    let cache = AnalysisCache::open_in_memory();
    let k = key("abc");
    cache.touch_track_status(&k, "ok").unwrap();

    assert!(!cache
        .cpu_seed_redundant_for_track("server-a", "abc")
        .unwrap());

    cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
    assert!(
        !cache
            .cpu_seed_redundant_for_track("server-a", "abc")
            .unwrap(),
        "waveform alone is not enough"
    );

    cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
    assert!(cache
        .cpu_seed_redundant_for_track("server-a", "abc")
        .unwrap());
}

#[test]
fn content_cache_coverage_tracks_partial_and_complete_state() {
    let cache = AnalysisCache::open_in_memory();
    let k = key("abc");
    cache.touch_track_status(&k, "queued").unwrap();

    let none = cache
        .content_cache_coverage("server-a", "abc", "deadbeef")
        .unwrap();
    assert!(!none.has_waveform);
    assert!(!none.has_loudness);
    assert!(!none.complete());

    cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
    let only_waveform = cache
        .content_cache_coverage("server-a", "stream:abc", "deadbeef")
        .unwrap();
    assert!(only_waveform.has_waveform);
    assert!(!only_waveform.has_loudness);
    assert!(!only_waveform.complete());

    cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
    let full = cache
        .content_cache_coverage("server-a", "abc", "deadbeef")
        .unwrap();
    assert!(full.complete());
}

#[test]
fn get_latest_md5_uses_variant_and_filters_empty_values() {
    let cache = AnalysisCache::open_in_memory();
    let ok = key("stream:t1");
    cache.touch_track_status(&ok, "ready").unwrap();
    cache.upsert_waveform(&ok, &waveform(4, false)).unwrap();

    assert_eq!(
        cache
            .get_latest_md5_16kb_for_track("server-a", "t1")
            .unwrap()
            .as_deref(),
        Some("deadbeef")
    );

    let empty_md5 = TrackKey {
        server_id: "server-a".to_string(),
        track_id: "t2".to_string(),
        md5_16kb: "".to_string(),
    };
    cache.touch_track_status(&empty_md5, "ready").unwrap();
    cache
        .upsert_waveform(&empty_md5, &waveform(4, false))
        .unwrap();
    assert!(
        cache
            .get_latest_md5_16kb_for_track("server-a", "t2")
            .unwrap()
            .is_none(),
        "empty md5 rows must be ignored by latest-md5 lookup"
    );
}

#[test]
fn latest_status_for_track_prefers_newest_variant_timestamp() {
    let cache = AnalysisCache::open_in_memory();
    let base = key_on("server-a", "track-1");
    let prefixed = key_on("server-a", "stream:track-1");

    cache.touch_track_status(&base, "queued").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1200));
    cache.touch_track_status(&prefixed, "failed").unwrap();

    let row = cache
        .get_latest_status_for_track("server-a", "track-1")
        .unwrap()
        .expect("latest status row");
    assert_eq!(row.0, "failed");
}

#[test]
fn failed_track_queries_deduplicate_stream_variants() {
    let cache = AnalysisCache::open_in_memory();
    let base = key_on("server-a", "track-2");
    let prefixed = key_on("server-a", "stream:track-2");
    let other = key_on("server-a", "track-3");

    cache.touch_track_status(&base, "failed").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1200));
    cache.touch_track_status(&prefixed, "failed").unwrap();
    cache.touch_track_status(&other, "failed").unwrap();

    let count = cache.count_failed_tracks("server-a").unwrap();
    assert_eq!(count, 2);

    let listed = cache.list_failed_tracks("server-a", None).unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().any(|r| r.track_id == "track-2"));
    assert!(listed.iter().any(|r| r.track_id == "track-3"));
}
