use super::*;

#[test]
fn get_waveform_returns_none_without_analysis_track_row() {
    let cache = AnalysisCache::open_in_memory();
    let k = key("abc");
    cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
    // The JOIN against `analysis_track` requires a matching row; without
    // `touch_track_status` first, the lookup must miss.
    assert!(cache.get_waveform(&k).unwrap().is_none());
}

#[test]
fn waveform_roundtrip_preserves_all_fields() {
    let cache = AnalysisCache::open_in_memory();
    let k = key("abc");
    cache.touch_track_status(&k, "ok").unwrap();
    let entry = WaveformEntry {
        bins: (0u8..16).collect(),
        bin_count: 8,
        is_partial: true,
        known_until_sec: 4.5,
        duration_sec: 33.0,
        updated_at: 1_700_000_001,
    };
    cache.upsert_waveform(&k, &entry).unwrap();
    let got = cache.get_waveform(&k).unwrap().expect("waveform present");
    assert_eq!(got.bins, entry.bins);
    assert_eq!(got.bin_count, 8);
    assert!(got.is_partial);
    assert_eq!(got.known_until_sec, 4.5);
    assert_eq!(got.duration_sec, 33.0);
    assert_eq!(got.updated_at, 1_700_000_001);
}

#[test]
fn waveform_upsert_overwrites_existing_row() {
    let cache = AnalysisCache::open_in_memory();
    let k = key("abc");
    cache.touch_track_status(&k, "ok").unwrap();
    cache.upsert_waveform(&k, &waveform(4, true)).unwrap();
    let updated = WaveformEntry {
        bins: vec![0xAAu8; 8],
        bin_count: 4,
        is_partial: false,
        known_until_sec: 60.0,
        duration_sec: 60.0,
        updated_at: 1_700_000_999,
    };
    cache.upsert_waveform(&k, &updated).unwrap();
    let got = cache.get_waveform(&k).unwrap().expect("waveform present");
    assert!(!got.is_partial, "second upsert should overwrite is_partial");
    assert_eq!(got.bins, vec![0xAAu8; 8]);
    assert_eq!(got.updated_at, 1_700_000_999);
}

#[test]
fn waveform_with_inconsistent_blob_length_is_filtered_out() {
    let cache = AnalysisCache::open_in_memory();
    let k = key("abc");
    cache.touch_track_status(&k, "ok").unwrap();
    // Manually upsert an entry where bins.len() doesn't match 2 * bin_count.
    let bad = WaveformEntry {
        bins: vec![0u8; 5], // expected 2*4 = 8
        bin_count: 4,
        is_partial: false,
        known_until_sec: 0.0,
        duration_sec: 0.0,
        updated_at: 1_700_000_000,
    };
    cache.upsert_waveform(&k, &bad).unwrap();
    // Direct JOIN finds the row, but get_waveform filters by length.
    assert!(cache.get_waveform(&k).unwrap().is_none());
}

#[test]
fn loudness_roundtrip_records_existence() {
    let cache = AnalysisCache::open_in_memory();
    let k = key("abc");
    cache.touch_track_status(&k, "ok").unwrap();
    assert!(!cache.loudness_row_exists_for_key(&k).unwrap());
    cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
    assert!(cache.loudness_row_exists_for_key(&k).unwrap());
}

#[test]
fn loudness_primary_key_includes_target_lufs() {
    // Two rows with same (track_id, md5_16kb) but different target_lufs must coexist.
    let cache = AnalysisCache::open_in_memory();
    let k = key("abc");
    cache.touch_track_status(&k, "ok").unwrap();
    cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
    cache.upsert_loudness(&k, &loudness(-10.0)).unwrap();
    let conn = cache.conn.lock().unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loudness_cache WHERE track_id = ?1",
            params!["abc"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn delete_loudness_clears_both_id_variants() {
    let cache = AnalysisCache::open_in_memory();
    let bare = key("abc");
    let prefixed = key("stream:abc");
    cache.touch_track_status(&bare, "ok").unwrap();
    cache.touch_track_status(&prefixed, "ok").unwrap();
    cache.upsert_loudness(&bare, &loudness(-14.0)).unwrap();
    cache.upsert_loudness(&prefixed, &loudness(-14.0)).unwrap();

    let deleted = cache
        .delete_loudness_for_track_id("server-a", "abc")
        .unwrap();
    assert_eq!(
        deleted, 2,
        "delete must remove both bare and stream:abc rows"
    );
    assert!(!cache.loudness_row_exists_for_key(&bare).unwrap());
    assert!(!cache.loudness_row_exists_for_key(&prefixed).unwrap());
}

#[test]
fn delete_waveform_clears_both_id_variants() {
    let cache = AnalysisCache::open_in_memory();
    let bare = key("abc");
    let prefixed = key("stream:abc");
    cache.touch_track_status(&bare, "ok").unwrap();
    cache.touch_track_status(&prefixed, "ok").unwrap();
    cache.upsert_waveform(&bare, &waveform(4, false)).unwrap();
    cache
        .upsert_waveform(&prefixed, &waveform(4, false))
        .unwrap();

    let deleted = cache
        .delete_waveform_for_track_id("server-a", "abc")
        .unwrap();
    assert_eq!(deleted, 2);
    assert!(cache.get_waveform(&bare).unwrap().is_none());
    assert!(cache.get_waveform(&prefixed).unwrap().is_none());
}

#[test]
fn delete_with_empty_or_whitespace_track_id_is_noop() {
    let cache = AnalysisCache::open_in_memory();
    assert_eq!(cache.delete_waveform_for_track_id("", "").unwrap(), 0);
    assert_eq!(cache.delete_waveform_for_track_id("", "   ").unwrap(), 0);
    assert_eq!(cache.delete_loudness_for_track_id("", "").unwrap(), 0);
    assert_eq!(cache.delete_loudness_for_track_id("", "   ").unwrap(), 0);
}

#[test]
fn delete_scoped_to_server_keeps_other_servers_rows() {
    // A reseed on server-a must not wipe server-b's analysis for the same
    // bare track_id.
    let cache = AnalysisCache::open_in_memory();
    let on_a = key_on("server-a", "t");
    let on_b = key_on("server-b", "t");
    for k in [&on_a, &on_b] {
        cache.touch_track_status(k, "ok").unwrap();
        cache.upsert_waveform(k, &waveform(4, false)).unwrap();
        cache.upsert_loudness(k, &loudness(-14.0)).unwrap();
    }

    let deleted = cache.delete_waveform_for_track_id("server-a", "t").unwrap();
    assert_eq!(deleted, 1, "server-a waveform rows removed");
    assert!(cache.get_waveform(&on_a).unwrap().is_none());
    assert!(
        cache.get_waveform(&on_b).unwrap().is_some(),
        "another server's waveform must survive a scoped reseed"
    );

    let deleted_l = cache.delete_loudness_for_track_id("server-a", "t").unwrap();
    assert_eq!(deleted_l, 1);
    assert!(cache.loudness_row_exists_for_key(&on_b).unwrap());
}

#[test]
fn delete_all_waveforms_removes_every_row() {
    let cache = AnalysisCache::open_in_memory();
    for tid in ["a", "b", "c"] {
        let k = key(tid);
        cache.touch_track_status(&k, "ok").unwrap();
        cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
    }
    let deleted = cache.delete_all_waveforms().unwrap();
    assert_eq!(deleted, 3);
    for tid in ["a", "b", "c"] {
        assert!(cache.get_waveform(&key(tid)).unwrap().is_none());
    }
}

#[test]
fn touch_track_status_upserts_status_field() {
    let cache = AnalysisCache::open_in_memory();
    let k = key("abc");
    cache.touch_track_status(&k, "queued").unwrap();
    cache.touch_track_status(&k, "done").unwrap();
    let conn = cache.conn.lock().unwrap();
    let status: String = conn
        .query_row(
            "SELECT status FROM analysis_track WHERE track_id = ?1 AND md5_16kb = ?2",
            params!["abc", "deadbeef"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "done");
}

#[test]
fn server_id_scopes_exact_key_lookups() {
    let cache = AnalysisCache::open_in_memory();
    let on_a = key_on("server-a", "t");
    let on_b = key_on("server-b", "t");
    cache.touch_track_status(&on_a, "ready").unwrap();
    cache.touch_track_status(&on_b, "ready").unwrap();
    // Only server-a has a waveform.
    cache.upsert_waveform(&on_a, &waveform(4, false)).unwrap();

    assert!(cache.get_waveform(&on_a).unwrap().is_some());
    assert!(
        cache.get_waveform(&on_b).unwrap().is_none(),
        "exact lookup must not return another server's analysis"
    );

    // Same (track_id, md5_16kb) under two server ids are independent rows.
    let conn = cache.conn.lock().unwrap();
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM analysis_track WHERE track_id='t'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 2);
}

#[test]
fn delete_all_for_server_removes_only_targeted_server_rows() {
    let cache = AnalysisCache::open_in_memory();
    let a = key_on("server-a", "t");
    let b = key_on("server-b", "t");
    for k in [&a, &b] {
        cache.touch_track_status(k, "ready").unwrap();
        cache.upsert_waveform(k, &waveform(4, false)).unwrap();
        cache.upsert_loudness(k, &loudness(-14.0)).unwrap();
    }

    let report = cache.delete_all_for_server("server-a").unwrap();
    assert_eq!(report.analysis_tracks, 1);
    assert_eq!(report.waveforms, 1);
    assert_eq!(report.loudness, 1);
    assert!(cache.get_waveform(&a).unwrap().is_none());
    assert!(cache.get_waveform(&b).unwrap().is_some());
    assert!(cache.loudness_row_exists_for_key(&b).unwrap());
}

#[test]
fn migrate_server_keys_drops_only_legacy_rows() {
    let cache = AnalysisCache::open_in_memory();
    let legacy = key_on("legacy-uuid", "t");
    let modern = key_on("modern-index-key", "t");
    for k in [&legacy, &modern] {
        cache.touch_track_status(k, "ready").unwrap();
        cache.upsert_waveform(k, &waveform(4, false)).unwrap();
        cache.upsert_loudness(k, &loudness(-14.0)).unwrap();
    }

    cache
        .migrate_server_keys(&[
            ("legacy-uuid".to_string(), "modern-index-key".to_string()),
            ("".to_string(), "skip".to_string()),
            ("same".to_string(), "same".to_string()),
        ])
        .unwrap();

    assert!(cache.get_waveform(&legacy).unwrap().is_none());
    assert!(cache.get_waveform(&modern).unwrap().is_some());
}

#[test]
fn clear_failed_tracks_removes_only_failed_rows() {
    let cache = AnalysisCache::open_in_memory();
    let failed = key_on("server-a", "track-failed");
    let ready = key_on("server-a", "track-ready");
    cache.touch_track_status(&failed, "failed").unwrap();
    cache.touch_track_status(&ready, "ready").unwrap();

    let deleted = cache
        .clear_failed_tracks("server-a", &["track-failed".to_string()])
        .unwrap();
    assert_eq!(deleted, 1);
    assert_eq!(cache.count_failed_tracks("server-a").unwrap(), 0);
    let ready_latest = cache
        .get_latest_status_for_track("server-a", "track-ready")
        .unwrap()
        .expect("ready row stays");
    assert_eq!(ready_latest.0, "ready");
}
