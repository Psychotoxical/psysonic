//! Plan what a track still needs: waveform, LUFS, enrichment (BPM/mood), …
//!
//! All byte-backed enqueue paths should call [`crate::analysis_runtime::enqueue_track_analysis`],
//! which uses this module to decide full CPU seed vs enrichment-only vs no-op.

use psysonic_core::track_analysis::TrackAnalysisPlan;
use psysonic_core::track_enrichment::TrackEnrichmentPort;
use tauri::{AppHandle, Manager};

use crate::analysis_cache::{AnalysisCache, TrackKey};

pub fn plan_track_analysis(
    app: &AppHandle,
    server_id: &str,
    track_id: &str,
    content_hash: &str,
) -> TrackAnalysisPlan {
    let (need_waveform, need_loudness) = cache_gaps(app, server_id, track_id, content_hash);
    let enrichment = enrichment_plan(app, server_id, track_id, content_hash);
    TrackAnalysisPlan {
        need_waveform,
        need_loudness,
        enrichment,
    }
}

/// Plan from the latest cached fingerprint when bytes are not available yet (HTTP backfill gate).
pub fn plan_track_analysis_from_cache(
    app: &AppHandle,
    server_id: &str,
    track_id: &str,
) -> Result<TrackAnalysisPlan, String> {
    let Some(cache) = app.try_state::<AnalysisCache>() else {
        return Ok(TrackAnalysisPlan {
            need_waveform: true,
            need_loudness: true,
            enrichment: Default::default(),
        });
    };
    let Some(md5) = cache.get_latest_md5_16kb_for_track(server_id, track_id)? else {
        return Ok(TrackAnalysisPlan {
            need_waveform: true,
            need_loudness: true,
            enrichment: Default::default(),
        });
    };
    Ok(plan_track_analysis(app, server_id, track_id, &md5))
}

pub fn track_analysis_needs_work(
    app: &AppHandle,
    server_id: &str,
    track_id: &str,
) -> Result<bool, String> {
    if let Some(cache) = app.try_state::<AnalysisCache>() {
        let latest_status = cache.get_latest_status_for_track(server_id, track_id)?;
        if latest_status
            .as_ref()
            .is_some_and(|(status, _)| status == "failed")
        {
            return Ok(false);
        }
        let plan = plan_track_analysis_from_cache(app, server_id, track_id)?;
        if !plan.any() {
            return Ok(false);
        }
        // Legacy reconciliation: some old rows are persisted as `ready` with
        // waveform present but no loudness (typically unsupported decode path).
        // Those tracks spin forever in pending without converging. Promote to
        // terminal `failed` so scheduler/progress can converge.
        if latest_status
            .as_ref()
            .is_some_and(|(status, _)| status == "ready")
            && plan.need_loudness
            && !plan.need_waveform
        {
            if let Some(md5) = cache.get_latest_md5_16kb_for_track(server_id, track_id)? {
                let key = TrackKey {
                    server_id: server_id.to_string(),
                    track_id: track_id.to_string(),
                    md5_16kb: md5,
                };
                let _ = cache.touch_track_status(&key, "failed");
            }
            return Ok(false);
        }
        return Ok(plan.any());
    }
    Ok(plan_track_analysis_from_cache(app, server_id, track_id)?.any())
}

fn cache_gaps(
    app: &AppHandle,
    server_id: &str,
    track_id: &str,
    content_hash: &str,
) -> (bool, bool) {
    cache_gaps_for_content(
        app.try_state::<AnalysisCache>().as_deref(),
        server_id,
        track_id,
        content_hash,
    )
}

fn enrichment_plan(
    app: &AppHandle,
    server_id: &str,
    track_id: &str,
    content_hash: &str,
) -> psysonic_core::track_enrichment::TrackEnrichmentPlan {
    if server_id.is_empty() {
        return Default::default();
    }
    app.try_state::<TrackEnrichmentPort>()
        .map(|port| port.plan(server_id, track_id, content_hash))
        .unwrap_or_default()
}

fn cache_gaps_for_content(
    cache: Option<&AnalysisCache>,
    server_id: &str,
    track_id: &str,
    content_hash: &str,
) -> (bool, bool) {
    let Some(cache) = cache else {
        return (true, true);
    };
    match cache.content_cache_coverage(server_id, track_id, content_hash) {
        Ok(coverage) => (!coverage.has_waveform, !coverage.has_loudness),
        Err(_) => (true, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis_cache::{LoudnessEntry, TrackKey, WaveformEntry};

    fn seed_waveform_loudness(cache: &AnalysisCache, server_id: &str, track_id: &str, md5: &str) {
        let key = TrackKey {
            server_id: server_id.to_string(),
            track_id: track_id.to_string(),
            md5_16kb: md5.to_string(),
        };
        cache.touch_track_status(&key, "ready").unwrap();
        cache
            .upsert_waveform(
                &key,
                &WaveformEntry {
                    bins: vec![0u8; 1000],
                    bin_count: 500,
                    is_partial: false,
                    known_until_sec: 0.0,
                    duration_sec: 0.0,
                    updated_at: 1,
                },
            )
            .unwrap();
        cache
            .upsert_loudness(
                &key,
                &LoudnessEntry {
                    integrated_lufs: -14.0,
                    true_peak: 1.0,
                    recommended_gain_db: 0.0,
                    target_lufs: -14.0,
                    updated_at: 1,
                },
            )
            .unwrap();
    }

    #[test]
    fn cache_gaps_true_when_empty() {
        let cache = AnalysisCache::open_in_memory();
        let (wf, ld) = cache_gaps_for_content(Some(&cache), "s1", "t1", "abc");
        assert!(wf && ld);
    }

    #[test]
    fn cache_gaps_false_when_fingerprint_present() {
        let cache = AnalysisCache::open_in_memory();
        seed_waveform_loudness(&cache, "s1", "t1", "abc");
        let (wf, ld) = cache_gaps_for_content(Some(&cache), "s1", "t1", "abc");
        assert!(!wf && !ld);
    }

    #[test]
    fn cache_gaps_finds_stream_prefix_row_for_bare_track_id() {
        let cache = AnalysisCache::open_in_memory();
        seed_waveform_loudness(&cache, "s1", "stream:t1", "abc");
        let (wf, ld) = cache_gaps_for_content(Some(&cache), "s1", "t1", "abc");
        assert!(!wf && !ld, "bare id should resolve stream: cached fingerprint");
    }

}
