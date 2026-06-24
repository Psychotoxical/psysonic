//! Hi-Res transition blend: resample to a user-chosen rate when crossfade,
//! AutoDJ, or gapless must cross a sample-rate boundary.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rodio::Player;
use tauri::{AppHandle, State};

use super::engine::AudioEngine;
use super::playback_rate::raw_counter_samples_for_content_position;
use super::play_input::{url_format_hint, PlayInput};
use super::source_build::{build_playback_source_with_probe_fallback, BuildSourceArgs, PlaybackSource};
use super::stream::LocalFileSource;

const BLEND_44100: u32 = 44_100;
const BLEND_88200: u32 = 88_200;
const BLEND_96000: u32 = 96_000;

/// User-selected blend rate for hi-res transitions; `None` when inactive.
pub(crate) fn blend_rate_hz(
    hi_res_enabled: bool,
    transition_blend_active: bool,
    hz: Option<u32>,
) -> Option<u32> {
    if !hi_res_enabled || !transition_blend_active {
        return None;
    }
    let raw = hz.unwrap_or(BLEND_44100);
    match raw {
        BLEND_44100 | BLEND_88200 | BLEND_96000 => Some(raw),
        _ => Some(BLEND_44100),
    }
}

pub(crate) struct OutgoingBlendSnapshot {
    pub(crate) url: String,
    pub(crate) position_secs: f64,
    pub(crate) duration_secs: f64,
    pub(crate) base_volume: f32,
    pub(crate) gain_linear: f32,
    pub(crate) outgoing_fade_secs: f32,
    pub(crate) actual_fade_secs: f32,
    pub(crate) analysis_track_id: Option<String>,
}

/// Capture the currently playing track before a hi-res blend stream reopen.
pub(crate) fn capture_outgoing_blend_snapshot(
    state: &AudioEngine,
    outgoing_fade_secs: f32,
    actual_fade_secs: f32,
) -> Option<OutgoingBlendSnapshot> {
    let url = state.current_playback_url.lock().unwrap().clone()?;
    if url.is_empty() {
        return None;
    }
    let (position_secs, duration_secs, base_volume, gain_linear, playing) = {
        let cur = state.current.lock().unwrap();
        let playing = cur.sink.is_some() && cur.paused_at.is_none();
        (
            cur.position(),
            cur.duration_secs,
            cur.base_volume,
            cur.replay_gain_linear,
            playing,
        )
    };
    if !playing {
        return None;
    }
    let analysis_track_id = state.current_analysis_track_id.lock().unwrap().clone();
    Some(OutgoingBlendSnapshot {
        url,
        position_secs,
        duration_secs,
        base_volume,
        gain_linear,
        outgoing_fade_secs,
        actual_fade_secs,
        analysis_track_id,
    })
}

/// Drop the live main sink so a stream reopen does not leave dangling players.
pub(crate) fn detach_current_sink_for_blend_reopen(state: &AudioEngine) {
    let mut cur = state.current.lock().unwrap();
    if let Some(old) = cur.sink.take() {
        old.stop();
    }
    cur.fadeout_trigger = None;
    cur.fadeout_samples = None;
}

fn resolve_cached_play_input(engine: &AudioEngine, url: &str) -> Option<PlayInput> {
    if url.starts_with("psysonic-local://") {
        let path = url.strip_prefix("psysonic-local://").unwrap_or(url);
        let file = std::fs::File::open(path).ok()?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        return Some(PlayInput::SeekableMedia {
            reader: Box::new(LocalFileSource { file, len }),
            format_hint: url_format_hint(url),
            tag: "LocalFile[hi-res-blend]",
            random_access: true,
            mp4_probe_gate: None,
        });
    }

    let ram_bytes = {
        let guard = engine.stream_completed_cache.lock().unwrap();
        guard
            .as_ref()
            .filter(|t| t.url == url)
            .map(|t| t.data.clone())
    };
    let bytes = if let Some(b) = ram_bytes {
        b
    } else {
        let spill_path = {
            let guard = engine.stream_completed_spill.lock().unwrap();
            guard
                .as_ref()
                .filter(|s| s.url == url)
                .map(|s| s.path.clone())
        };
        match spill_path {
            Some(p) => std::fs::read(&p).ok()?,
            None => return None,
        }
    };
    Some(PlayInput::Bytes(bytes))
}

/// Rebuild the outgoing track on `fading_out_sink` at `blend_rate` after reopen.
pub(crate) async fn spawn_outgoing_blend_resample(
    app: &AppHandle,
    state: &State<'_, AudioEngine>,
    snap: &OutgoingBlendSnapshot,
    blend_rate: u32,
    gen: u64,
) -> Result<(), String> {
    if state.generation.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    let play_input = resolve_cached_play_input(state, &snap.url).ok_or_else(|| {
        format!(
            "[hi-res-blend] outgoing track not cached for blend reopen: {}",
            snap.url
        )
    })?;

    let done_flag = Arc::new(AtomicBool::new(false));
    let format_hint = url_format_hint(&snap.url);
    let stream_format_suffix: Option<String> = snap
        .url
        .rsplit('.')
        .next()
        .and_then(|e| e.split('?').next())
        .map(|s| s.to_lowercase());
    let resume_server = super::helpers::current_playback_server_id_str(state);

    let ps: PlaybackSource = build_playback_source_with_probe_fallback(
        play_input,
        BuildSourceArgs {
            url: &snap.url,
            gen,
            cache_id_for_tasks: snap.analysis_track_id.as_deref(),
            server_id: Some(resume_server.as_str()),
            url_format_hint: format_hint.as_deref(),
            stream_format_suffix: stream_format_suffix.as_deref(),
            done_flag: done_flag.clone(),
            fade_in_dur: Duration::from_millis(5),
            hi_res_enabled: true,
            resample_target_hz: blend_rate,
            duration_hint: snap.duration_secs,
        },
        state,
        app,
    )
    .await?;

    if state.generation.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    let stream = super::engine::ensure_output_stream_open(state)?;
    let sink = Arc::new(Player::connect_new(stream.mixer()));
    let effective_volume = (snap.base_volume * snap.gain_linear).clamp(0.0, 1.0);
    sink.set_volume(effective_volume);
    sink.append(ps.built.source);

    if ps.is_seekable && snap.position_secs > 0.05 {
        let target = Duration::from_secs_f64(snap.position_secs.max(0.0));
        sink.try_seek(target)
            .map_err(|e| format!("[hi-res-blend] outgoing seek failed: {e}"))?;
    }

    let fade_secs = snap.outgoing_fade_secs;
    if fade_secs > 0.0 {
        let rate = blend_rate;
        let ch = state.current_channels.load(Ordering::Relaxed).max(2);
        let fade_total = (fade_secs as f64 * rate as f64 * ch as f64) as u64;
        ps.built
            .fadeout_samples
            .store(fade_total.max(1), Ordering::SeqCst);
        ps.built.fadeout_trigger.store(true, Ordering::SeqCst);
    }

    sink.play();
    *state.fading_out_sink.lock().unwrap() = Some(sink);

    let fo_arc = state.fading_out_sink.clone();
    let cleanup_secs = snap.actual_fade_secs.max(snap.outgoing_fade_secs) + 0.5;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs_f32(cleanup_secs)).await;
        if let Some(s) = fo_arc.lock().unwrap().take() {
            s.stop();
        }
    });

    crate::app_deprintln!(
        "[hi-res-blend] outgoing rebuilt at {blend_rate} Hz from {:.2}s (fade {:.2}s)",
        snap.position_secs,
        fade_secs
    );
    Ok(())
}

/// Rebuild the **current** track on a freshly opened blend-rate stream (gapless
/// chain realign) so the next source can append to the same sink.
pub(crate) async fn rebuild_current_track_at_blend_rate(
    app: &AppHandle,
    state: &State<'_, AudioEngine>,
    snap: &OutgoingBlendSnapshot,
    blend_rate: u32,
    gen: u64,
) -> Result<(), String> {
    if state.generation.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    let play_input = resolve_cached_play_input(state, &snap.url).ok_or_else(|| {
        format!(
            "[hi-res-blend] current track not cached for gapless realign: {}",
            snap.url
        )
    })?;

    let done_flag = Arc::new(AtomicBool::new(false));
    let format_hint = url_format_hint(&snap.url);
    let stream_format_suffix: Option<String> = snap
        .url
        .rsplit('.')
        .next()
        .and_then(|e| e.split('?').next())
        .map(|s| s.to_lowercase());
    let resume_server = super::helpers::current_playback_server_id_str(state);

    let ps: PlaybackSource = build_playback_source_with_probe_fallback(
        play_input,
        BuildSourceArgs {
            url: &snap.url,
            gen,
            cache_id_for_tasks: snap.analysis_track_id.as_deref(),
            server_id: Some(resume_server.as_str()),
            url_format_hint: format_hint.as_deref(),
            stream_format_suffix: stream_format_suffix.as_deref(),
            done_flag: done_flag.clone(),
            fade_in_dur: Duration::from_millis(5),
            hi_res_enabled: true,
            resample_target_hz: blend_rate,
            duration_hint: snap.duration_secs,
        },
        state,
        app,
    )
    .await?;

    if state.generation.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    state
        .current_sample_rate
        .store(ps.built.output_rate, Ordering::Relaxed);
    state
        .current_channels
        .store(ps.built.output_channels as u32, Ordering::Relaxed);

    let stream = super::engine::ensure_output_stream_open(state)?;
    let sink = Arc::new(Player::connect_new(stream.mixer()));
    let effective_volume = (snap.base_volume * snap.gain_linear).clamp(0.0, 1.0);
    sink.set_volume(effective_volume);
    sink.append(ps.built.source);

    if ps.is_seekable && snap.position_secs > 0.05 {
        let target = Duration::from_secs_f64(snap.position_secs.max(0.0));
        sink.try_seek(target)
            .map_err(|e| format!("[hi-res-blend] gapless realign seek failed: {e}"))?;
    }

    sink.play();

    {
        let mut cur = state.current.lock().unwrap();
        cur.sink = Some(sink);
        cur.duration_secs = ps.built.duration_secs;
        cur.seek_offset = snap.position_secs;
        cur.play_started = Some(Instant::now());
        cur.paused_at = None;
        cur.replay_gain_linear = snap.gain_linear;
        cur.base_volume = snap.base_volume;
        cur.fadeout_trigger = Some(ps.built.fadeout_trigger);
        cur.fadeout_samples = Some(ps.built.fadeout_samples);
    }

    state.samples_played.store(
        raw_counter_samples_for_content_position(
            snap.position_secs,
            ps.built.output_rate,
            ps.built.output_channels as u32,
            &state.playback_rate,
        ),
        Ordering::Relaxed,
    );

    crate::app_deprintln!(
        "[hi-res-blend] gapless realigned current track at {blend_rate} Hz from {:.2}s",
        snap.position_secs
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blend_rate_inactive_without_hi_res_or_transition() {
        assert_eq!(blend_rate_hz(false, true, Some(96_000)), None);
        assert_eq!(blend_rate_hz(true, false, Some(96_000)), None);
    }

    #[test]
    fn blend_rate_sanitizes_hz() {
        assert_eq!(blend_rate_hz(true, true, None), Some(44_100));
        assert_eq!(blend_rate_hz(true, true, Some(88_200)), Some(88_200));
        assert_eq!(blend_rate_hz(true, true, Some(48_000)), Some(44_100));
    }
}
