//! Audio-stage settings commands: volume, replay-gain / loudness normalization,
//! 10-band EQ, crossfade, gapless.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, State};

use super::engine::AudioEngine;
use super::helpers::*;
use super::ipc::{maybe_emit_normalization_state, NormalizationStatePayload};

#[tauri::command]
pub fn audio_set_volume(volume: f32, state: State<'_, AudioEngine>) {
    let mut cur = state.current.lock().unwrap();
    let prev_effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
    cur.base_volume = volume.clamp(0.0, 1.0);
    if let Some(sink) = &cur.sink {
        let next_effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
        ramp_sink_volume(Arc::clone(sink), prev_effective, next_effective);
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn audio_update_replay_gain(
    volume: f32,
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    loudness_gain_db: Option<f32>,
    pre_gain_db: f32,
    fallback_db: f32,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) {
    let norm_mode = state.normalization_engine.load(Ordering::Relaxed);
    let target_lufs = f32::from_bits(state.normalization_target_lufs.load(Ordering::Relaxed));
    let pre_analysis_db = loudness_pre_analysis_db_for_engine(&state);
    let url_for_loudness = if norm_mode == 2 {
        state.current_playback_url.lock().unwrap().clone()
    } else {
        None
    };
    let logical_for_loudness = state
        .current_analysis_track_id
        .lock()
        .ok()
        .and_then(|g| (*g).clone())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // If `current_playback_url` is not pinned yet, still honour JS `loudness_gain_db`
    // for the uncached path (`effective_loudness_db` / UI gain follow from `compute_gain`).
    let cache_loudness = url_for_loudness.as_deref().and_then(|u| {
        resolve_loudness_gain_from_cache_impl(
            &app,
            u,
            target_lufs,
            logical_for_loudness.as_deref(),
            ResolveLoudnessCacheOpts {
                touch_waveform: false,
                log_soft_misses: false,
            },
        )
    });
    let effective_loudness_db = if norm_mode == 2 {
        match url_for_loudness.as_deref() {
            Some(_u) => loudness_gain_db_after_resolve(
                cache_loudness,
                target_lufs,
                pre_analysis_db,
                true,
                loudness_gain_db,
            ),
            None => {
                loudness_gain_db.or(Some(loudness_gain_placeholder_until_cache(
                    target_lufs,
                    pre_analysis_db,
                )))
            }
        }
    } else {
        loudness_gain_db
    };
    let (gain_linear, effective) = compute_gain(
        norm_mode,
        replay_gain_db,
        replay_gain_peak,
        effective_loudness_db,
        pre_gain_db,
        fallback_db,
        volume,
    );
    let current_gain_db = loudness_ui_current_gain_db(gain_linear);
    crate::app_deprintln!(
        "[normalization] audio_update_replay_gain engine={} replay_gain_db={:?} replay_gain_peak={:?} loudness_gain_db={:?} gain_linear={:.4} current_gain_db={:?} target_lufs={:.2} volume={:.3} effective={:.3}",
        normalization_engine_name(norm_mode),
        replay_gain_db,
        replay_gain_peak,
        loudness_gain_db,
        gain_linear,
        current_gain_db,
        target_lufs,
        volume,
        effective
    );
    let mut cur = state.current.lock().unwrap();
    let prev_effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
    cur.replay_gain_linear = gain_linear;
    cur.base_volume = volume.clamp(0.0, 1.0);
    if let Some(sink) = &cur.sink {
        ramp_sink_volume(Arc::clone(sink), prev_effective, effective);
    }
    drop(cur);
    maybe_emit_normalization_state(
        &app,
        NormalizationStatePayload {
            engine: normalization_engine_name(norm_mode).to_string(),
            current_gain_db,
            target_lufs,
        },
    );
}

#[tauri::command]
pub fn audio_set_eq(gains: [f32; 10], enabled: bool, pre_gain: f32, state: State<'_, AudioEngine>) {
    state.eq_enabled.store(enabled, Ordering::Relaxed);
    state.eq_pre_gain.store(pre_gain.clamp(-30.0, 6.0).to_bits(), Ordering::Relaxed);
    for (i, &gain) in gains.iter().enumerate() {
        state.eq_gains[i].store(gain.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn audio_set_crossfade(enabled: bool, secs: f32, state: State<'_, AudioEngine>) {
    state.crossfade_enabled.store(enabled, Ordering::Relaxed);
    state.crossfade_secs.store(secs.clamp(0.1, 12.0).to_bits(), Ordering::Relaxed);
}

#[tauri::command]
pub fn audio_set_gapless(enabled: bool, state: State<'_, AudioEngine>) {
    state.gapless_enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn audio_set_normalization(
    engine: String,
    target_lufs: f32,
    pre_analysis_attenuation_db: f32,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) {
    let mode = match engine.as_str() {
        "replaygain" => 1,
        "loudness" => 2,
        _ => 0,
    };
    state.normalization_engine.store(mode, Ordering::Relaxed);
    let target = target_lufs.clamp(-30.0, -8.0);
    state
        .normalization_target_lufs
        .store(target.to_bits(), Ordering::Relaxed);
    let pre = pre_analysis_attenuation_db.clamp(-24.0, 0.0).min(0.0);
    state
        .loudness_pre_analysis_attenuation_db
        .store(pre.to_bits(), Ordering::Relaxed);
    crate::app_deprintln!(
        "[normalization] audio_set_normalization requested_engine={} resolved_engine={} target_lufs={:.2} pre_analysis_db={:.2}",
        engine,
        normalization_engine_name(mode),
        target,
        pre
    );
    maybe_emit_normalization_state(
        &app,
        NormalizationStatePayload {
            engine: normalization_engine_name(mode).to_string(),
            // At mode-switch time the effective track gain may not be recalculated yet.
            // Emit `None` and let audio_play/audio_update_replay_gain publish actual value.
            current_gain_db: None,
            target_lufs: target,
        },
    );
}
