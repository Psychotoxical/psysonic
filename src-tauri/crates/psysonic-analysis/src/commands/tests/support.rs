use crate::analysis_cache::{AnalysisCache, LoudnessEntry, TrackKey, WaveformEntry};

fn key(track_id: &str, md5: &str) -> TrackKey {
    TrackKey {
        server_id: "server-a".to_string(),
        track_id: track_id.to_string(),
        md5_16kb: md5.to_string(),
    }
}

pub(super) fn upsert_waveform(cache: &AnalysisCache, track_id: &str, md5: &str, bins: Vec<u8>) {
    let k = key(track_id, md5);
    cache.touch_track_status(&k, "ready").unwrap();
    cache
        .upsert_waveform(
            &k,
            &WaveformEntry {
                bin_count: (bins.len() / 2) as i64,
                bins,
                is_partial: false,
                known_until_sec: 0.0,
                duration_sec: 60.0,
                updated_at: 1_700_000_000,
            },
        )
        .unwrap();
}

pub(super) fn upsert_loudness(cache: &AnalysisCache, track_id: &str, md5: &str, target_lufs: f64) {
    let k = key(track_id, md5);
    cache.touch_track_status(&k, "ready").unwrap();
    cache
        .upsert_loudness(
            &k,
            &LoudnessEntry {
                integrated_lufs: -14.0,
                true_peak: 0.5,
                recommended_gain_db: 0.0,
                target_lufs,
                updated_at: 1_700_000_000,
            },
        )
        .unwrap();
}
