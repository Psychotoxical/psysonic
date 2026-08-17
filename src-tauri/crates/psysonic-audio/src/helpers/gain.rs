use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};

use super::identity::analysis_cache_track_id;
use crate::engine::AudioEngine;

pub(crate) fn provisional_loudness_gain_from_progress(
    downloaded: usize,
    total_size: usize,
    target_lufs: f32,
    start_db_in: f32,
) -> Option<f32> {
    if total_size == 0 || downloaded == 0 {
        return None;
    }
    let progress = (downloaded as f32 / total_size as f32).clamp(0.0, 1.0);
    // Move from startup attenuation toward a more realistic late-stream level.
    // This avoids staying near -2 dB and then jumping hard when final LUFS lands.
    let start_db = start_db_in.clamp(-24.0, 0.0).min(0.0);
    let end_db = (target_lufs + 6.0).clamp(-10.0, -3.0).min(0.0);
    let shaped = progress.powf(0.75);
    Some(start_db + (end_db - start_db) * shaped)
}

#[derive(Clone, Copy)]
pub(crate) struct ResolveLoudnessCacheOpts {
    /// When false, omit `cache-miss` / `cache-invalid` debug lines (still log hits and errors).
    pub(crate) log_soft_misses: bool,
}

impl Default for ResolveLoudnessCacheOpts {
    fn default() -> Self {
        Self {
            log_soft_misses: true,
        }
    }
}

pub(crate) fn resolve_loudness_gain_from_cache(
    app: &AppHandle,
    url: &str,
    target_lufs: f32,
    logical_track_id: Option<&str>,
    server_id: &str,
) -> Option<f32> {
    resolve_loudness_gain_from_cache_impl(
        app,
        url,
        target_lufs,
        logical_track_id,
        server_id,
        ResolveLoudnessCacheOpts::default(),
    )
}

pub(crate) fn resolve_loudness_gain_from_cache_impl(
    app: &AppHandle,
    url: &str,
    target_lufs: f32,
    logical_track_id: Option<&str>,
    server_id: &str,
    opts: ResolveLoudnessCacheOpts,
) -> Option<f32> {
    // Only a SQLite loudness row counts here. Ephemeral JS hints (`analysis:loudness-partial`)
    // are applied in `audio_update_replay_gain` via `loudness_gain_db_or_startup(..., true, _)`.
    let Some(track_id) = analysis_cache_track_id(logical_track_id, url) else {
        if opts.log_soft_misses {
            crate::app_deprintln!(
                "[normalization] resolve_loudness_gain source=no-identity url_len={}",
                url.len()
            );
        }
        return None;
    };
    let Some(cache) = app.try_state::<psysonic_analysis::analysis_cache::AnalysisCache>() else {
        if opts.log_soft_misses {
            crate::app_deprintln!(
                "[normalization] resolve_loudness_gain source=no-analysis-cache track_id={}",
                track_id
            );
        }
        return None;
    };
    resolve_loudness_gain_with_cache(cache.inner(), server_id, &track_id, target_lufs, opts)
}

/// AppHandle-free core of [`resolve_loudness_gain_from_cache_impl`]. Looks up
/// the latest loudness row for `track_id` in `cache` and returns the
/// recommended gain in dB, or `None` for any miss / non-finite / error case.
/// Pulled out so tests can drive every branch via `AnalysisCache::open_in_memory()`.
///
pub(crate) fn resolve_loudness_gain_with_cache(
    cache: &psysonic_analysis::analysis_cache::AnalysisCache,
    server_id: &str,
    track_id: &str,
    target_lufs: f32,
    opts: ResolveLoudnessCacheOpts,
) -> Option<f32> {
    match cache.get_latest_loudness_for_track(server_id, track_id) {
        Ok(Some(row)) if row.integrated_lufs.is_finite() => {
            let recommended = psysonic_analysis::analysis_cache::recommended_gain_for_target(
                row.integrated_lufs,
                row.true_peak,
                target_lufs as f64,
            ) as f32;
            crate::app_deprintln!(
                "[normalization] resolve_loudness_gain source=cache track_id={} gain_db={:.2} target_lufs={:.2} integrated_lufs={:.2} updated_at={}",
                track_id,
                recommended,
                target_lufs,
                row.integrated_lufs,
                row.updated_at
            );
            Some(recommended)
        }
        Ok(Some(row)) => {
            if opts.log_soft_misses {
                crate::app_deprintln!(
                    "[normalization] resolve_loudness_gain source=cache-invalid track_id={} integrated_lufs={}",
                    track_id,
                    row.integrated_lufs
                );
            }
            None
        }
        Ok(None) => {
            if opts.log_soft_misses {
                crate::app_deprintln!(
                    "[normalization] resolve_loudness_gain source=cache-miss track_id={}",
                    track_id
                );
            }
            None
        }
        Err(e) => {
            crate::app_deprintln!(
                "[normalization] resolve_loudness_gain source=cache-error track_id={} err={}",
                track_id,
                e
            );
            None
        }
    }
}

/// Typical integrated LUFS (streaming pivot) when SQLite has no row yet — so target changes
/// still move gain before real analysis completes.
const LOUDNESS_PLACEHOLDER_INTEGRATED_LUFS: f64 = -14.0;

#[inline]
pub(crate) fn loudness_gain_placeholder_until_cache(
    target_lufs: f32,
    pre_analysis_attenuation_db: f32,
) -> f32 {
    let pre = pre_analysis_attenuation_db.clamp(-24.0, 0.0).min(0.0);
    // `true_peak = 0.0` skips the headroom cap until integrated measurement exists.
    let pivot = psysonic_analysis::analysis_cache::recommended_gain_for_target(
        LOUDNESS_PLACEHOLDER_INTEGRATED_LUFS,
        0.0,
        f64::from(target_lufs),
    ) as f32;
    (pivot + pre).clamp(-24.0, 24.0)
}

/// LUFS gain after a single `resolve_loudness_gain_from_cache` result (`None` = miss).
/// Keeps `audio_update_replay_gain` / `audio_play` from resolving twice on the same URL.
/// Until a cache row exists, follow current target (see [`loudness_gain_placeholder_until_cache`]).
pub(crate) fn loudness_gain_db_after_resolve(
    resolved_from_cache: Option<f32>,
    target_lufs: f32,
    pre_analysis_attenuation_db: f32,
    allow_js_when_uncached: bool,
    js_gain_db: Option<f32>,
) -> Option<f32> {
    let uncached = loudness_gain_placeholder_until_cache(target_lufs, pre_analysis_attenuation_db);
    match resolved_from_cache {
        Some(g) => Some(g),
        None => {
            if allow_js_when_uncached {
                match js_gain_db {
                    Some(r) if r.is_finite() => Some(r),
                    _ => Some(uncached),
                }
            } else {
                Some(uncached)
            }
        }
    }
}

/// Resolved gain inputs that both `audio_play` and `audio_chain_preload` need
/// before calling [`compute_gain`]. Bundles the engine state reads + cache
/// resolution in one shot so the call sites don't drift apart on subtle
/// behaviour (e.g. one accidentally skipping the post-resolve step for
/// LUFS mode).
#[derive(Debug, Clone, Copy)]
pub(crate) struct TrackGainInputs {
    pub(crate) target_lufs: f32,
    pub(crate) norm_mode: u32,
    /// Pre-resolve cache value — kept around for logging in `audio_play`.
    pub(crate) cache_loudness_db: Option<f32>,
    /// Value to feed into `compute_gain` — for LUFS mode this is the
    /// post-`loudness_gain_db_after_resolve` value, otherwise the raw cache
    /// resolution (or `None` when not in normalisation mode).
    pub(crate) effective_loudness_db: Option<f32>,
}

impl TrackGainInputs {
    /// Partial stream hints are only useful until a final SQLite loudness row exists.
    pub(crate) fn needs_partial_loudness(self) -> bool {
        self.cache_loudness_db.is_none()
    }
}

/// Read engine state + resolve the loudness cache for a track that's about to
/// start playing. JS-supplied `loudness_gain_db` is **not** consulted at bind
/// time (only post-cache via `audio_update_replay_gain`).
/// Current playback server scope (`current_playback_server_id`, empty when
/// unset) for scoping analysis-cache reads on the gain-resolution path.
pub(crate) fn current_playback_server_id_str(state: &AudioEngine) -> String {
    state
        .current_playback_server_id
        .lock()
        .ok()
        .and_then(|g| (*g).clone())
        .unwrap_or_default()
}

pub(crate) fn resolve_track_gain_inputs(
    state: &AudioEngine,
    app: &AppHandle,
    url: &str,
    logical_track_id: Option<&str>,
    js_loudness_gain_db: Option<f32>,
) -> TrackGainInputs {
    let target_lufs = f32::from_bits(state.normalization_target_lufs.load(Ordering::Relaxed));
    let norm_mode = state.normalization_engine.load(Ordering::Relaxed);
    let pre_analysis_db = loudness_pre_analysis_db_for_engine(state);
    let server_id = current_playback_server_id_str(state);
    let cache_loudness_db =
        resolve_loudness_gain_from_cache(app, url, target_lufs, logical_track_id, &server_id);
    let effective_loudness_db = if norm_mode == 2 {
        loudness_gain_db_after_resolve(
            cache_loudness_db,
            target_lufs,
            pre_analysis_db,
            false,
            js_loudness_gain_db,
        )
    } else {
        cache_loudness_db
    };
    TrackGainInputs {
        target_lufs,
        norm_mode,
        cache_loudness_db,
        effective_loudness_db,
    }
}

#[inline]
pub(crate) fn loudness_pre_analysis_db_for_engine(state: &AudioEngine) -> f32 {
    f32::from_bits(
        state
            .loudness_pre_analysis_attenuation_db
            .load(Ordering::Relaxed),
    )
    .clamp(-24.0, 0.0)
    .min(0.0)
}

/// -1 dB headroom applied at full scale to prevent inter-sample clipping.
/// Modern masters are often at 0 dBFS; the EQ biquad chain and resampler
/// can produce inter-sample peaks slightly above ±1.0 → audible distortion.
/// 10^(-1/20) ≈ 0.891 — inaudible volume difference, eliminates clipping.
pub(crate) const MASTER_HEADROOM: f32 = 0.891_254;
pub(crate) const PARTIAL_LOUDNESS_MIN_BYTES: usize = 256 * 1024;
pub(crate) const PARTIAL_LOUDNESS_EMIT_INTERVAL_MS: u64 = 900;

pub(crate) fn compute_gain(
    normalization_engine: u32,
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    loudness_gain_db: Option<f32>,
    pre_gain_db: f32,
    fallback_db: f32,
    volume: f32,
) -> (f32, f32) {
    let gain_linear = match normalization_engine {
        2 => loudness_gain_db
            .map(|db| 10f32.powf(db / 20.0))
            .unwrap_or(1.0),
        1 => replay_gain_db
            .map(|db| 10f32.powf((db + pre_gain_db) / 20.0))
            .unwrap_or_else(|| 10f32.powf(fallback_db / 20.0)),
        _ => 1.0,
    };
    let peak = if normalization_engine == 1 {
        replay_gain_peak.unwrap_or(1.0).max(0.001)
    } else {
        1.0
    };
    let gain_linear = gain_linear.min(1.0 / peak);
    let effective = (volume.clamp(0.0, 1.0) * gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
    (gain_linear, effective)
}

pub(crate) fn normalization_engine_name(mode: u32) -> &'static str {
    match mode {
        1 => "replaygain",
        2 => "loudness",
        _ => "off",
    }
}

pub(crate) fn gain_linear_to_db(gain_linear: f32) -> Option<f32> {
    if gain_linear.is_finite() && gain_linear > 0.0 {
        Some(20.0 * gain_linear.log10())
    } else {
        None
    }
}

/// `audio:normalization-state` “Now dB” for the UI: effective applied gain, including
/// loudness pre-analysis trim from settings when no cache row exists yet (matches audible level).
pub(crate) fn loudness_ui_current_gain_db(gain_linear: f32) -> Option<f32> {
    gain_linear_to_db(gain_linear)
}

#[cfg(test)]
#[path = "gain_tests.rs"]
mod tests;
