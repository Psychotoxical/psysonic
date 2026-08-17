use super::super::cpu_seed::seed_revision_key;
use super::super::http_backfill::{source_unavailable_failure, AnalysisBackfillJobError};
use super::super::trusted_revision::*;
use crate::analysis_cache;
use psysonic_core::track_enrichment::TrackEnrichmentOutcome;
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

#[test]
fn late_registration_cannot_replace_a_newer_trusted_revision() {
    let app = tauri::test::mock_app();
    let older_generation = next_trusted_generation();
    let newer_generation = next_trusted_generation();

    register_trusted_revision_generation(
        "generation-order-server",
        "t1",
        "newer-fingerprint",
        newer_generation,
    );
    register_trusted_revision_generation(
        "generation-order-server",
        "t1",
        "older-fingerprint",
        older_generation,
    );

    assert!(!activate_trusted_identity(
        app.handle(),
        "generation-order-server",
        "generation-order-server",
        "t1",
        "older-fingerprint",
        older_generation,
    ));
    assert!(activate_trusted_identity(
        app.handle(),
        "generation-order-server",
        "generation-order-server",
        "t1",
        "newer-fingerprint",
        newer_generation,
    ));
}

#[test]
fn same_revision_reuses_the_current_generation() {
    let first_generation = next_trusted_generation();
    let second_generation = next_trusted_generation();
    let server_id = "same-revision-generation-server";
    let track_id = "same-revision-track";

    let first = register_trusted_revision_generation(
        server_id,
        track_id,
        "same-fingerprint",
        first_generation,
    );
    let second = register_trusted_revision_generation(
        server_id,
        track_id,
        "same-fingerprint",
        second_generation,
    );

    assert_eq!(first, first_generation);
    assert_eq!(second, first_generation);
    assert!(trusted_revision_generation_is_current(
        server_id,
        track_id,
        "same-fingerprint",
        first_generation,
    ));
}

#[test]
fn stale_source_unavailable_response_does_not_write_failed_status() {
    use tauri::Manager;

    let app = tauri::test::mock_app();
    app.handle()
        .manage(analysis_cache::AnalysisCache::open_in_memory());
    let server_id = "stale-unavailable-server";
    let track_id = "stale-unavailable-track";
    let stale_generation = next_trusted_generation();
    let current_generation = next_trusted_generation();
    register_trusted_revision_generation(
        server_id,
        track_id,
        "current-fingerprint",
        current_generation,
    );

    let outcome = source_unavailable_failure(
        app.handle(),
        server_id,
        track_id,
        &crate::raw_probe::SubsonicStreamError {
            code: 0,
            message: "open /private/music.flac: no such file or directory".to_string(),
        },
        stale_generation,
    );

    assert_eq!(outcome, AnalysisBackfillJobError::Superseded);
    let cache = app.handle().state::<analysis_cache::AnalysisCache>();
    assert_eq!(
        cache
            .get_latest_status_for_track(server_id, track_id)
            .unwrap(),
        None
    );
}
#[tokio::test]
async fn trusted_fetch_reservation_waits_for_stream_track_alias_owner() {
    let first = reserve_trusted_analysis_fetch(
        "fetch-reservation-server",
        "stream:fetch-reservation-track",
        "fetch-reservation-revision",
    )
    .await;
    assert!(!first.waited());

    let mut waiter = tokio::spawn(async {
        reserve_trusted_analysis_fetch(
            "fetch-reservation-server",
            "fetch-reservation-track",
            "fetch-reservation-revision",
        )
        .await
    });
    let key = seed_revision_key(
        "fetch-reservation-server",
        "fetch-reservation-track",
        "fetch-reservation-revision",
    );
    loop {
        let registered = TRUSTED_ANALYSIS_FETCHES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .get(&key)
            .is_some_and(|waiters| !waiters.is_empty());
        if registered {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), &mut waiter)
            .await
            .is_err()
    );

    drop(first);
    let second = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
        .await
        .expect("waiter should wake when the owner releases")
        .expect("waiter task should complete");
    assert!(second.waited());
}
use crate::analysis_cache::{AnalysisCache, LoudnessEntry, TrackKey, WaveformEntry};
use tauri::Manager;

fn key_for(server_id: &str, track_id: &str, md5: &str) -> TrackKey {
    TrackKey {
        server_id: server_id.into(),
        track_id: track_id.into(),
        md5_16kb: md5.into(),
    }
}

fn seed_complete_row_for(
    cache: &AnalysisCache,
    server_id: &str,
    track_id: &str,
    md5: &str,
    updated_at: i64,
) {
    let key = key_for(server_id, track_id, md5);
    cache.touch_track_status(&key, "ready").unwrap();
    cache
        .upsert_waveform(
            &key,
            &WaveformEntry {
                bins: vec![1, 2, 3, 4, 5, 6],
                bin_count: 3,
                is_partial: false,
                known_until_sec: 100.0,
                duration_sec: 100.0,
                updated_at,
            },
        )
        .unwrap();
    cache
        .upsert_loudness(
            &key,
            &LoudnessEntry {
                integrated_lufs: -14.0,
                true_peak: 0.5,
                recommended_gain_db: 0.0,
                target_lufs: -14.0,
                updated_at,
            },
        )
        .unwrap();
}

/// Review scenario: a COMPLETE trusted row exists, then a backfill/legacy
/// pass writes a transcode-variant row with a newer `updated_at`. A later
/// trusted resolution hits the "already complete" branch — which must
/// still purge the stale variant so latest-row reads return the trusted
/// fingerprint, not the newest write.
#[test]
fn complete_trusted_row_purges_newer_stale_variant() {
    let app = tauri::test::mock_app();
    app.handle().manage(AnalysisCache::open_in_memory());
    let cache = app.handle().state::<AnalysisCache>();
    let server_id = "srv-complete-repair";

    seed_complete_row_for(&cache, server_id, "t1", "trusted-fp", 100);
    seed_complete_row_for(&cache, server_id, "t1", "stale-transcode-fp", 200); // newer wins reads today

    assert_eq!(
        cache
            .get_latest_md5_16kb_for_track(server_id, "t1")
            .unwrap()
            .as_deref(),
        Some("stale-transcode-fp"),
        "precondition: the stale variant is what reads currently select"
    );

    let generation = begin_trusted_revision(server_id, "t1", "trusted-fp");
    activate_trusted_identity(
        app.handle(),
        server_id,
        server_id,
        "t1",
        "trusted-fp",
        generation,
    );

    assert_eq!(
        cache
            .get_latest_md5_16kb_for_track(server_id, "t1")
            .unwrap()
            .as_deref(),
        Some("trusted-fp"),
        "the stale variant must be purged on the complete-repair path"
    );
}

#[test]
fn trusted_revisions_completing_in_reverse_keep_the_newer_result() {
    let app = tauri::test::mock_app();
    app.handle().manage(AnalysisCache::open_in_memory());
    let recorded = Arc::new(Mutex::new(Vec::<String>::new()));
    let recorded_for_sink = recorded.clone();
    app.handle()
        .manage(psysonic_core::ports::ContentHashSink::new(
            move |_, _, hash| recorded_for_sink.lock().unwrap().push(hash.to_string()),
        ));
    let cache = app.handle().state::<AnalysisCache>();

    let older_generation = begin_trusted_revision("srv-reverse", "stream:t1", "older-fp");
    let newer_generation = begin_trusted_revision("srv-reverse", "t1", "newer-fp");
    seed_complete_row_for(&cache, "srv-reverse", "t1", "newer-fp", 200);
    assert!(activate_trusted_identity(
        app.handle(),
        "srv-reverse",
        "srv-reverse",
        "t1",
        "newer-fp",
        newer_generation,
    ));

    seed_complete_row_for(&cache, "srv-reverse", "t1", "older-fp", 300);
    assert!(!activate_trusted_identity(
        app.handle(),
        "srv-reverse",
        "srv-reverse",
        "stream:t1",
        "older-fp",
        older_generation,
    ));

    assert!(cache
        .content_cache_coverage("srv-reverse", "t1", "newer-fp")
        .unwrap()
        .complete());
    assert!(
        !cache
            .content_cache_coverage("srv-reverse", "t1", "older-fp")
            .unwrap()
            .has_waveform
    );
    assert_eq!(&*recorded.lock().unwrap(), &["newer-fp".to_string()]);
}

#[test]
fn trusted_enrichment_commit_rejects_superseded_generation() {
    let server_id = "srv-enrichment-generation-guard";
    let track_id = "t1";
    let older_generation = begin_trusted_revision(server_id, track_id, "older-fp");
    let newer_generation = begin_trusted_revision(server_id, track_id, "newer-fp");
    let committed = std::sync::atomic::AtomicBool::new(false);

    assert!(commit_trusted_enrichment_if_current(
        server_id,
        track_id,
        "older-fp",
        older_generation,
        || committed.store(true, Ordering::Relaxed),
    )
    .is_none());
    assert!(!committed.load(Ordering::Relaxed));

    assert!(commit_trusted_enrichment_if_current(
        server_id,
        track_id,
        "newer-fp",
        newer_generation,
        || committed.store(true, Ordering::Relaxed),
    )
    .is_some());
    assert!(committed.load(Ordering::Relaxed));
}

#[test]
fn successful_trusted_enrichment_repairs_hash_and_purges_variants() {
    let app = tauri::test::mock_app();
    app.handle().manage(AnalysisCache::open_in_memory());
    let recorded = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let recorded_for_sink = recorded.clone();
    app.handle()
        .manage(psysonic_core::ports::ContentHashSink::new(
            move |server_id, _, hash| {
                recorded_for_sink
                    .lock()
                    .unwrap()
                    .push((server_id.to_string(), hash.to_string()))
            },
        ));
    let cache = app.handle().state::<AnalysisCache>();
    let server_id = "srv-enrichment-repair";
    seed_complete_row_for(&cache, server_id, "t1", "trusted-enrichment", 100);
    seed_complete_row_for(&cache, server_id, "t1", "stale-enrichment", 200);
    let generation = begin_trusted_revision(server_id, "t1", "trusted-enrichment");

    assert!(activate_trusted_enrichment(
        app.handle(),
        server_id,
        "library-scope",
        "t1",
        "trusted-enrichment",
        generation,
        TrackEnrichmentOutcome::Applied,
    ));
    assert_eq!(
        cache
            .get_latest_md5_16kb_for_track(server_id, "t1")
            .unwrap()
            .as_deref(),
        Some("trusted-enrichment")
    );
    assert_eq!(
        &*recorded.lock().unwrap(),
        &[(
            "library-scope".to_string(),
            "trusted-enrichment".to_string()
        )]
    );
}
