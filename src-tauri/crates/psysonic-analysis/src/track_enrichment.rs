//! Client-side track enrichment — oximedia BPM + mood into library facts.

use oximedia_mir::{mood, tempo, MirConfig};
use psysonic_core::track_enrichment::{
    TrackEnrichmentFacts, TrackEnrichmentIntFact, TrackEnrichmentOutcome, TrackEnrichmentPort,
    TrackEnrichmentPlan, TrackEnrichmentRealFact,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::analysis_cache::{
    analysis_pcm_window, audio_duration_from_bytes, decode_mono_pcm_window, md5_first_16kb,
};

pub const ENRICHMENT_WINDOW_SEC: f64 = 60.0;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichmentUpdatedPayload {
    pub track_id: String,
    pub server_id: String,
}

fn emit_enrichment_updated<R: Runtime>(app: &AppHandle<R>, server_id: &str, track_id: &str) {
    let _ = app.emit(
        "analysis:enrichment-updated",
        EnrichmentUpdatedPayload {
            track_id: track_id.to_string(),
            server_id: server_id.to_string(),
        },
    );
}

pub fn run_track_enrichment_if_needed<R: Runtime>(
    app: &AppHandle<R>,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    notify_ui: bool,
) -> TrackEnrichmentOutcome {
    if server_id.is_empty() {
        return TrackEnrichmentOutcome::SkippedNoServer;
    }
    let Some(port) = app.try_state::<TrackEnrichmentPort>() else {
        return TrackEnrichmentOutcome::SkippedNoPort;
    };
    let content_hash = md5_first_16kb(bytes);
    let plan = port.plan(server_id, track_id, &content_hash);
    if !plan.any() {
        return TrackEnrichmentOutcome::SkippedComplete;
    }

    match analyze_and_store(&port, server_id, track_id, &content_hash, bytes, plan) {
        Ok(()) => {
            crate::app_deprintln!(
                "[analysis][enrichment] applied track_id={} server_id={} hash={}",
                track_id,
                server_id,
                content_hash
            );
            if notify_ui {
                emit_enrichment_updated(app, server_id, track_id);
            }
            TrackEnrichmentOutcome::Applied
        }
        Err(e) => {
            crate::app_eprintln!(
                "[analysis][enrichment] failed track_id={} server_id={}: {}",
                track_id,
                server_id,
                e
            );
            TrackEnrichmentOutcome::Failed
        }
    }
}

fn analyze_and_store(
    port: &TrackEnrichmentPort,
    server_id: &str,
    track_id: &str,
    content_hash: &str,
    bytes: &[u8],
    plan: TrackEnrichmentPlan,
) -> Result<(), String> {
    let total_duration = audio_duration_from_bytes(bytes).unwrap_or(0.0);
    let window = analysis_pcm_window(total_duration, ENRICHMENT_WINDOW_SEC);
    let (mono, sample_rate) =
        decode_mono_pcm_window(bytes, window.start_sec, window.duration_sec)?;
    if mono.is_empty() || sample_rate <= 0.0 {
        return Err("empty PCM window".to_string());
    }

    let config = MirConfig::default();
    let mut facts = TrackEnrichmentFacts::default();

    if plan.need_bpm {
        let detector = tempo::TempoDetector::new(sample_rate, config.min_tempo, config.max_tempo);
        let tempo = detector.detect(&mono).map_err(|e| format!("tempo: {e}"))?;
        let bpm = tempo.bpm.round().clamp(20.0, 999.0) as i64;
        facts.bpm = Some(TrackEnrichmentIntFact {
            value: bpm,
            confidence: tempo.confidence,
        });
    }

    if plan.need_valence || plan.need_arousal || plan.need_moods {
        let detector = mood::MoodDetector::new(sample_rate);
        let mood = detector.detect(&mono).map_err(|e| format!("mood: {e}"))?;
        let confidence = mood.intensity.clamp(0.0, 1.0);
        if plan.need_valence {
            facts.valence = Some(TrackEnrichmentRealFact {
                value: mood.valence as f64,
                confidence,
            });
        }
        if plan.need_arousal {
            facts.arousal = Some(TrackEnrichmentRealFact {
                value: mood.arousal as f64,
                confidence,
            });
        }
        if plan.need_moods && !mood.moods.is_empty() {
            facts.moods = Some(
                serde_json::to_string(&mood.moods).map_err(|e| format!("moods json: {e}"))?,
            );
        }
    }

    port.store(server_id, track_id, content_hash, &facts)
}
