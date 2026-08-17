use std::io::Read;

use super::*;

static TEST_FILE_ID: AtomicU64 = AtomicU64::new(0);

#[test]
fn trusted_prefix_distinguishes_original_from_transcoded_capture() {
    let original = vec![7u8; 20 * 1024];
    let trusted = psysonic_analysis::analysis_cache::md5_first_16kb(&original);
    assert_eq!(
        provenance_from_trusted_bytes(&original, &trusted),
        StreamProvenance::Original,
    );
    assert_eq!(
        provenance_from_trusted_bytes(&vec![9u8; 20 * 1024], &trusted),
        StreamProvenance::Transcoded,
    );
}

#[test]
fn raw_original_fetch_requires_work_outside_the_same_revision_cpu_pipeline() {
    assert!(should_fetch_trusted_original(false, true));
    assert!(!should_fetch_trusted_original(true, true));
    assert!(!should_fetch_trusted_original(false, false));
}

#[test]
fn disk_backed_stream_spills_use_the_local_file_analysis_cap() {
    assert_eq!(
        max_bytes_for_dispatch(TrackAnalysisOrigin::StreamSpillFile),
        LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES,
    );
    assert_eq!(
        max_bytes_for_dispatch(TrackAnalysisOrigin::PrefetchOrCacheFile),
        TRACK_STREAM_PROMOTE_MAX_BYTES,
    );
}

#[test]
fn stream_spill_above_the_ram_capture_cap_remains_eligible_for_analysis() {
    let spill_cap = max_bytes_for_dispatch(TrackAnalysisOrigin::StreamSpillFile);
    assert!(TRACK_STREAM_PROMOTE_MAX_BYTES < spill_cap);
    assert_eq!(spill_cap, LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES);
}

#[test]
fn spill_analysis_keeps_raw_http_refetch_at_the_ram_cap() {
    assert_eq!(
        max_http_fetch_bytes_for_dispatch(),
        TRACK_STREAM_PROMOTE_MAX_BYTES
    );
    assert!(
        max_http_fetch_bytes_for_dispatch()
            < max_bytes_for_dispatch(TrackAnalysisOrigin::StreamSpillFile)
    );
}

#[test]
fn completed_spill_analysis_survives_a_stale_playback_generation() {
    let generation = Arc::new(AtomicU64::new(8));
    let stale_guard = (7, generation);
    assert!(generation_guard_allows_analysis(
        TrackAnalysisOrigin::StreamSpillFile,
        Some(&stale_guard),
    ));
    assert!(!generation_guard_allows_analysis(
        TrackAnalysisOrigin::StreamDownloadComplete,
        Some(&stale_guard),
    ));
}

#[test]
fn prepared_spill_handle_survives_path_removal_when_supported() {
    let path = std::env::temp_dir().join(format!(
        "psysonic-analysis-spill-{}-{}",
        std::process::id(),
        TEST_FILE_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let expected = b"stable spill bytes";
    std::fs::write(&path, expected).unwrap();
    let prepared =
        prepare_track_analysis_file(TrackAnalysisOrigin::StreamSpillFile, "track-1", &path)
            .unwrap();
    let removed = std::fs::remove_file(&path).is_ok();

    let PreparedTrackAnalysisFile { mut file, .. } = prepared;
    let mut actual = Vec::new();
    file.read_to_end(&mut actual).unwrap();
    assert_eq!(actual, expected);
    drop(file);
    if !removed {
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn live_http_provenance_requires_a_current_generation_guard() {
    let generation = Arc::new(AtomicU64::new(6));
    let guard = (6, generation.clone());
    assert_eq!(
        provenance_event_generation(
            TrackAnalysisOrigin::InMemoryReplay,
            Some("https://example.test/rest/stream.view?id=t1"),
            Some(&guard),
        ),
        Some(6),
    );
    assert_eq!(
        provenance_event_generation(
            TrackAnalysisOrigin::PrefetchOrCacheFile,
            Some("https://example.test/rest/stream.view?id=t1"),
            Some(&guard),
        ),
        None,
        "prefetch analysis must not create a live now-playing event",
    );
    assert_eq!(
        provenance_event_generation(
            TrackAnalysisOrigin::LocalFilePlayback,
            Some("psysonic-local:///music/t1.flac"),
            Some(&guard),
        ),
        None,
        "local originals do not need a stream-provenance event",
    );

    generation.store(7, Ordering::SeqCst);
    assert_eq!(
        provenance_event_generation(
            TrackAnalysisOrigin::StreamDownloadComplete,
            Some("https://example.test/rest/stream.view?id=t1"),
            Some(&guard),
        ),
        None,
        "superseded captures must not emit stale provenance",
    );
}
