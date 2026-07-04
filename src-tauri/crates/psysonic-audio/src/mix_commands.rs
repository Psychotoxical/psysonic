//! Audio-stage settings commands: volume, replay-gain / loudness normalization,
//! 10-band EQ, crossfade, gapless.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, State};

use super::engine::AudioEngine;
use super::helpers::*;
use super::ipc::{maybe_emit_normalization_state, NormalizationStatePayload};

#[tauri::command]
#[specta::specta]
pub fn audio_set_volume(volume: f32, state: State<'_, AudioEngine>) {
    let mut cur = state.current.lock().unwrap();
    cur.base_volume = volume.clamp(0.0, 1.0);
    if let Some(sink) = &cur.sink {
        let prev_effective = sink_volume_now(sink);
        let next_effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
        ramp_sink_volume(Arc::clone(sink), prev_effective, next_effective);
    }
}

#[tauri::command]
#[specta::specta]
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
    let server_for_loudness = crate::helpers::current_playback_server_id_str(&state);
    let cache_loudness = url_for_loudness.as_deref().and_then(|u| {
        resolve_loudness_gain_from_cache_impl(
            &app,
            u,
            target_lufs,
            logical_for_loudness.as_deref(),
            &server_for_loudness,
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
    if state
        .interrupt_outgoing_duck_active
        .load(Ordering::Relaxed)
    {
        // Interrupt prep ducked the outgoing sink; syncing B's loudness here would
        // ramp A back to full gain before the handoff swap.
        return;
    }
    let mut cur = state.current.lock().unwrap();
    cur.replay_gain_linear = gain_linear;
    cur.base_volume = volume.clamp(0.0, 1.0);
    if let Some(sink) = &cur.sink {
        let prev_effective = sink_volume_now(sink);
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
#[specta::specta]
pub fn audio_set_eq(gains: [f32; 10], enabled: bool, pre_gain: f32, state: State<'_, AudioEngine>) {
    state.eq_enabled.store(enabled, Ordering::Relaxed);
    state.eq_pre_gain.store(pre_gain.clamp(-30.0, 6.0).to_bits(), Ordering::Relaxed);
    for (i, &gain) in gains.iter().enumerate() {
        state.eq_gains[i].store(gain.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
    }
}

#[tauri::command]
#[specta::specta]
pub fn audio_set_crossfade(enabled: bool, secs: f32, state: State<'_, AudioEngine>) {
    state.crossfade_enabled.store(enabled, Ordering::Relaxed);
    state.crossfade_secs.store(secs.clamp(0.1, 12.0).to_bits(), Ordering::Relaxed);
}

#[tauri::command]
#[specta::specta]
pub fn audio_set_gapless(enabled: bool, state: State<'_, AudioEngine>) {
    state.gapless_enabled.store(enabled, Ordering::Relaxed);
}

/// Duck the current sink over `fade_secs` without exhausting its source (which
/// would spuriously emit `audio:ended` before the interrupt handoff).
#[tauri::command]
#[specta::specta]
pub fn audio_begin_outgoing_fade(fade_secs: f32, state: State<'_, AudioEngine>) {
    let fade_secs = fade_secs.clamp(0.1, 12.0);
    let cur = state.current.lock().unwrap();
    let Some(sink) = cur.sink.as_ref() else {
        return;
    };
    state
        .interrupt_outgoing_duck_active
        .store(true, Ordering::Relaxed);
    cancel_sink_volume_ramp();
    let from = sink_volume_now(sink);
    ramp_sink_volume_over_secs(Arc::clone(sink), from, 0.0, fade_secs);
}

/// AutoDJ: when `true`, the progress task stops firing its autonomous
/// crossfade `audio:ended` timer so the JS A-tail logic drives every advance
/// (only when the next track is actually playable). When `false`, the engine's
/// normal early crossfade trigger is restored (plain crossfade / loud→loud).
#[tauri::command]
#[specta::specta]
pub fn audio_set_autodj_suppress(enabled: bool, state: State<'_, AudioEngine>) {
    state
        .autodj_suppress_autocrossfade
        .store(enabled, Ordering::Relaxed);
}

#[tauri::command]
#[specta::specta]
pub fn audio_set_playback_rate(
    enabled: bool,
    strategy: String,
    speed: f32,
    pitch_semitones: f32,
    state: State<'_, AudioEngine>,
) {
    use crate::playback_rate::{
        content_position_from_samples, is_effect_active, raw_counter_samples_for_content_position,
        uses_preserve_dsp, STRATEGY_PRESERVE_PITCH, STRATEGY_SPEED_CORRECTED,
        STRATEGY_VARISPEED,
    };

    let clamped_speed = speed.clamp(0.5, 2.0);
    let clamped_pitch = pitch_semitones.clamp(-12.0, 12.0);
    let old_enabled = state.playback_rate.enabled.load(Ordering::Relaxed);
    let old_strat = state.playback_rate.load_strategy();
    let old_speed = state.playback_rate.load_speed();
    let was_active = is_effect_active(&state.playback_rate);
    let new_strat = match strategy.as_str() {
        "preserve_pitch" => STRATEGY_PRESERVE_PITCH,
        "speed_corrected" => STRATEGY_SPEED_CORRECTED,
        _ => STRATEGY_VARISPEED,
    };
    let speed_changed = (clamped_speed - old_speed).abs() > 0.001;

    let restamp_content = if was_active
        && enabled == old_enabled
        && uses_preserve_dsp(old_strat)
        && new_strat == old_strat
        && speed_changed
    {
        let sample_rate = state.current_sample_rate.load(Ordering::Relaxed);
        let channels = state.current_channels.load(Ordering::Relaxed);
        if sample_rate > 0 && channels > 0 {
            Some(content_position_from_samples(
                state.samples_played.load(Ordering::Relaxed),
                sample_rate,
                channels,
                &state.playback_rate,
            ))
        } else {
            None
        }
    } else {
        None
    };

    state
        .playback_rate
        .enabled
        .store(enabled, Ordering::Relaxed);
    state
        .playback_rate
        .strategy
        .store(new_strat, Ordering::Relaxed);
    state
        .playback_rate
        .speed
        .store(clamped_speed.to_bits(), Ordering::Relaxed);
    state
        .playback_rate
        .pitch_semitones
        .store(clamped_pitch.to_bits(), Ordering::Relaxed);

    if let Some(content_secs) = restamp_content {
        if is_effect_active(&state.playback_rate) {
            let sample_rate = state.current_sample_rate.load(Ordering::Relaxed);
            let channels = state.current_channels.load(Ordering::Relaxed);
            state.samples_played.store(
                raw_counter_samples_for_content_position(
                    content_secs,
                    sample_rate,
                    channels,
                    &state.playback_rate,
                ),
                Ordering::Relaxed,
            );
        }
    }
}

#[tauri::command]
#[specta::specta]
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
