//! Short preview playback on a secondary sink (same output stream).
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rodio::Player;
use rodio::Source;
use tauri::{AppHandle, Emitter, State};

use super::decode::SizedDecoder;
use super::engine::{audio_http_client, AudioEngine, PlaybackHttpHeaders};
use super::helpers::{
    content_type_to_hint, format_hint_from_content_disposition, normalize_stream_suffix_for_hint,
    resolve_playback_format_hint, sniff_stream_format_extension, STREAM_FORMAT_SNIFF_PROBE_BYTES,
    MASTER_HEADROOM,
};
use super::play_input::url_format_hint;
use super::sources::PriorityBoostSource;
use super::stream::{
    mp4_needs_tail_prefetch, ranged_download_task, wait_for_ranged_mp4_probe_ready,
    RangedHttpSource, RangedMp4ProbeGate,
};

// ────────────────────────────────────────────────────────────────────────────
// Preview engine — secondary Sink on the same OutputStream, fed by Symphonia.
// ────────────────────────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
struct PreviewProgressPayload {
    id: String,
    elapsed: f64,
    duration: f64,
}

#[derive(Clone, serde::Serialize)]
struct PreviewEndPayload {
    id: String,
    /// "natural" = 30 s timer / source ended; "user" = explicit stop;
    /// "interrupted" = a new preview superseded this one.
    reason: &'static str,
}

/// Pause main sink and remember whether to resume it after preview ends.
/// Mirrors `audio_pause` semantics so progress timestamps stay consistent.
pub(crate) fn preview_pause_main(state: &AudioEngine) {
    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = &cur.sink {
        if !sink.is_paused() && !sink.empty() {
            let pos = cur.position();
            sink.pause();
            cur.paused_at = Some(pos);
            cur.play_started = None;
            state.preview_main_resume.store(true, Ordering::Release);
        } else {
            state.preview_main_resume.store(false, Ordering::Release);
        }
    } else {
        state.preview_main_resume.store(false, Ordering::Release);
    }
}

/// Cancel any active preview and clear the resume marker. Called from every
/// command that brings the main sink back to life under its own steam
/// (`audio_play`, `audio_play_radio`, `audio_resume`) — without this the
/// preview would keep playing in parallel and the watchdog would later try
/// to resume a main sink that's already running, double-mixing the audio.
pub(crate) fn preview_clear_for_new_main_playback(state: &AudioEngine, app: &AppHandle) {
    // Order matters: clear the resume marker BEFORE bumping the generation
    // so the watchdog — if it wakes between our writes — sees no work to do
    // and bails without resuming main behind our back.
    state.preview_main_resume.store(false, Ordering::Release);
    state.preview_gen.fetch_add(1, Ordering::SeqCst);
    let sink = state.preview_sink.lock().unwrap().take();
    let id = state.preview_song_id.lock().unwrap().take();
    if let Some(s) = sink { s.stop(); }
    if let Some(id) = id {
        app.emit("audio:preview-end", PreviewEndPayload {
            id,
            reason: "interrupted",
        }).ok();
    }
}

/// Resume main sink iff `preview_pause_main` paused it. No-op if main was
/// already paused/empty before preview started.
pub(crate) fn preview_resume_main(state: &AudioEngine) {
    if !state.preview_main_resume.swap(false, Ordering::AcqRel) {
        return;
    }
    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = &cur.sink {
        if sink.is_paused() {
            let pos = cur.paused_at.unwrap_or(cur.seek_offset);
            sink.play();
            cur.seek_offset = pos;
            cur.play_started = Some(Instant::now());
            cur.paused_at = None;
        }
    }
}

/// `format=` query param on Subsonic stream URLs (transcode targets).
pub(crate) fn preview_format_hint_from_url(url: &str) -> Option<String> {
    url.split('?')
        .nth(1)?
        .split('&')
        .find_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            if k.eq_ignore_ascii_case("format") {
                Some(v.to_string())
            } else {
                None
            }
        })
}

/// Symphonia container hint for preview downloads — mirrors main playback:
/// Content-Type / Content-Disposition, URL tail, Subsonic suffix, magic-byte sniff.
pub(crate) fn resolve_preview_format_hint(
    url: &str,
    content_type: Option<&str>,
    content_disposition: Option<&str>,
    stream_suffix: Option<&str>,
    bytes: &[u8],
) -> Option<String> {
    let media_hint = content_type
        .and_then(content_type_to_hint)
        .or_else(|| {
            content_disposition.and_then(format_hint_from_content_disposition)
        });
    let url_hint = preview_format_hint_from_url(url).or_else(|| url_format_hint(url));
    resolve_playback_format_hint(
        url_hint.as_deref(),
        stream_suffix,
        media_hint.as_deref(),
        Some(bytes),
    )
}

fn preview_http_client(state: &AudioEngine) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .use_rustls_tls()
        .user_agent(psysonic_core::user_agent::subsonic_wire_user_agent())
        .build()
        .unwrap_or_else(|_| audio_http_client(state))
}

/// Open a preview decoder — ranged HTTP when the server supports it (starts
/// after ~384 KiB buffered), otherwise falls back to a full in-memory download.
async fn open_preview_decoder(
    url: &str,
    format_suffix: Option<&str>,
    gen: u64,
    state: &AudioEngine,
    app: &AppHandle,
) -> Result<Option<SizedDecoder>, String> {
    let http_headers = PlaybackHttpHeaders::from_app(app, None);
    let preview_http = preview_http_client(state);
    let response = http_headers
        .apply(url, preview_http.get(url))
        .send()
        .await
        .map_err(|e| format!("preview: connection failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("preview: HTTP {e}"))?;

    let mut stream_hint = content_type_to_hint(
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    )
    .or_else(|| {
        response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(format_hint_from_content_disposition)
    })
    .or_else(|| normalize_stream_suffix_for_hint(format_suffix))
    .or_else(|| preview_format_hint_from_url(url))
    .or_else(|| url_format_hint(url));

    let supports_range = response
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("bytes"));
    let total_size = response.content_length();

    if stream_hint.is_none() && supports_range {
        if let Some(total_u64) = total_size.filter(|&t| t > 0) {
            let last = total_u64
                .saturating_sub(1)
                .min((STREAM_FORMAT_SNIFF_PROBE_BYTES - 1) as u64);
            if let Ok(pr) = http_headers
                .apply(url, preview_http.get(url))
                .header(reqwest::header::RANGE, format!("bytes=0-{last}"))
                .send()
                .await
            {
                let stat = pr.status();
                let ok = stat == reqwest::StatusCode::PARTIAL_CONTENT
                    || stat == reqwest::StatusCode::OK;
                if ok {
                    if let Ok(bytes) = pr.bytes().await {
                        if !bytes.is_empty() {
                            stream_hint = sniff_stream_format_extension(&bytes).or(stream_hint);
                        }
                    }
                }
            }
        }
    }

    if let (true, Some(total), true) = (supports_range, total_size, stream_hint.is_some()) {
        if state.preview_gen.load(Ordering::SeqCst) != gen {
            return Ok(None);
        }
        let total_usize = total as usize;
        crate::app_deprintln!(
            "[preview] ranged open — total={} KB, hint={:?}",
            total_usize / 1024,
            stream_hint
        );
        let buf = Arc::new(Mutex::new(vec![0u8; total_usize]));
        let downloaded_to = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicBool::new(false));
        let playback_armed = Arc::new(AtomicBool::new(false));
        let tail_ready = Arc::new(AtomicBool::new(false));
        let tail_filled_from = Arc::new(AtomicU64::new(0));
        let tail_prefetch = mp4_needs_tail_prefetch(&[], stream_hint.as_deref());
        let mp4_probe_gate = tail_prefetch.then(|| RangedMp4ProbeGate {
            tail_ready: tail_ready.clone(),
            buf: buf.clone(),
            downloaded_to: downloaded_to.clone(),
            gen_arc: state.preview_gen.clone(),
            gen,
            format_hint: stream_hint.clone(),
        });
        tokio::spawn(ranged_download_task(
            gen,
            state.preview_gen.clone(),
            preview_http,
            app.clone(),
            0.0,
            url.to_string(),
            response,
            buf.clone(),
            downloaded_to.clone(),
            done.clone(),
            state.stream_completed_cache.clone(),
            state.stream_completed_spill.clone(),
            state.normalization_engine.clone(),
            state.normalization_target_lufs.clone(),
            state.loudness_pre_analysis_attenuation_db.clone(),
            None,
            None,
            http_headers.clone(),
            None,
            playback_armed,
            stream_hint.clone(),
            tail_ready.clone(),
            tail_filled_from.clone(),
        ));
        if let Some(ref gate) = mp4_probe_gate {
            wait_for_ranged_mp4_probe_ready(gate).await?;
            if state.preview_gen.load(Ordering::SeqCst) != gen {
                return Ok(None);
            }
        }
        let reader = RangedHttpSource {
            buf,
            downloaded_to,
            tail_ready,
            tail_filled_from,
            total_size: total,
            pos: 0,
            done,
            gen_arc: state.preview_gen.clone(),
            gen,
            // Preview plays a fixed short segment; no user seeking → no need for
            // the on-demand random-access fetcher.
            on_demand: None,
        };
        let hint = stream_hint.clone();
        let decoder = tokio::task::spawn_blocking(move || {
            SizedDecoder::new_streaming(Box::new(reader), hint.as_deref(), "preview-stream", false)
        })
        .await
        .map_err(|e| format!("preview: decoder thread: {e}"))??;
        return Ok(Some(decoder));
    }

    crate::app_deprintln!(
        "[preview] buffered download — accept-ranges={}, content-length={:?}, hint={:?}",
        supports_range,
        total_size,
        stream_hint
    );
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let content_disposition = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("preview: read body: {e}"))?
        .to_vec();
    if state.preview_gen.load(Ordering::SeqCst) != gen {
        return Ok(None);
    }
    let hint = resolve_preview_format_hint(
        url,
        content_type.as_deref(),
        content_disposition.as_deref(),
        format_suffix,
        &bytes,
    );
    let bytes_for_blocking = bytes;
    let hint_for_blocking = hint.clone();
    let decoder = tokio::task::spawn_blocking(move || {
        SizedDecoder::new(bytes_for_blocking, hint_for_blocking.as_deref(), false)
    })
    .await
    .map_err(|e| format!("preview: decoder thread: {e}"))??;
    Ok(Some(decoder))
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // Tauri IPC — args map 1:1 to the JS invoke payload.
pub async fn audio_preview_play(
    id: String,
    url: String,
    start_sec: f64,
    duration_sec: f64,
    volume: f32,
    format_suffix: Option<String>,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    let gen = state.preview_gen.fetch_add(1, Ordering::SeqCst) + 1;

    // Tear down any existing preview before pausing main (so a rapid preview
    // swap doesn't double-pause and double-resume the main sink).
    let prev_sink = state.preview_sink.lock().unwrap().take();
    let prev_id = state.preview_song_id.lock().unwrap().take();
    if let Some(s) = prev_sink { s.stop(); }
    if let Some(prev) = prev_id {
        app.emit("audio:preview-end", PreviewEndPayload {
            id: prev,
            reason: "interrupted",
        }).ok();
    }

    // Pause main if and only if we don't already hold a "main was playing"
    // marker from a superseded preview. swap_or-style: only pause if the flag
    // is currently false.
    if !state.preview_main_resume.load(Ordering::Acquire) {
        preview_pause_main(&state);
    }

    // ── Open decoder (ranged stream when possible) ───────────────────────────
    let decoder = match open_preview_decoder(
        &url,
        format_suffix.as_deref(),
        gen,
        &state,
        &app,
    )
    .await?
    {
        Some(d) => d,
        None => return Ok(()),
    };

    if state.preview_gen.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    // ── Build source pipeline ────────────────────────────────────────────────
    // Seek FIRST on the bare decoder, THEN cap with take_duration. Capping
    // before the seek made take_duration's wall-clock counter tick from
    // sink.append() while try_seek was still iterating the decoder to
    // mid-track — the preview window consumed itself before audio actually
    // arrived at the speaker (~25% of duration silent on FLAC/MP3 mid-track
    // starts). Symphonia FLAC without SEEKTABLE may fail try_seek; preview
    // then plays from 0, which is acceptable.
    // No EQ / no crossfade / no ReplayGain — preview stays simple.
    let mut source = decoder;
    if start_sec > 0.5 {
        let _ = source.try_seek(Duration::from_secs_f64(start_sec));
    }
    let dur = Duration::from_secs_f64(duration_sec.clamp(1.0, 120.0));
    let source = source.take_duration(dur);
    let source = PriorityBoostSource::new(source);

    // ── Build secondary sink on the existing OutputStream ────────────────────
    let stream = super::engine::ensure_output_stream_open(&state)?;
    let sink = Arc::new(Player::connect_new(stream.mixer()));
    sink.set_volume((volume.clamp(0.0, 1.0) * MASTER_HEADROOM).clamp(0.0, 1.0));
    sink.append(source);

    *state.preview_sink.lock().unwrap() = Some(sink.clone());
    *state.preview_song_id.lock().unwrap() = Some(id.clone());

    app.emit("audio:preview-start", id.clone()).ok();

    // ── Spawn watchdog: progress emits + auto-end ────────────────────────────
    let preview_gen_arc = state.preview_gen.clone();
    let preview_sink_arc = state.preview_sink.clone();
    let preview_song_arc = state.preview_song_id.clone();
    let preview_resume_arc = state.preview_main_resume.clone();
    let main_current = state.current.clone();
    let app_for_task = app.clone();
    let id_for_task = id.clone();
    tokio::spawn(async move {
        let started = Instant::now();
        let mut last_emit = Instant::now() - Duration::from_millis(300);
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            // Cancel: another preview started or audio_preview_stop bumped the gen.
            if preview_gen_arc.load(Ordering::SeqCst) != gen { return; }

            let elapsed = started.elapsed().as_secs_f64();
            let dur_secs = dur.as_secs_f64();

            if last_emit.elapsed() >= Duration::from_millis(250) {
                last_emit = Instant::now();
                app_for_task.emit("audio:preview-progress", PreviewProgressPayload {
                    id: id_for_task.clone(),
                    elapsed: elapsed.min(dur_secs),
                    duration: dur_secs,
                }).ok();
            }

            // Natural end: timer expired OR sink drained early (decode error,
            // short track, etc.).
            let drained = match preview_sink_arc.lock().unwrap().as_ref() {
                Some(s) => s.empty(),
                None => true,
            };
            if elapsed >= dur_secs || drained {
                // Re-check generation under the cleanup lock to avoid racing
                // a fresh preview that bumped the counter.
                if preview_gen_arc.load(Ordering::SeqCst) != gen { return; }
                if let Some(s) = preview_sink_arc.lock().unwrap().take() { s.stop(); }
                let cleared_id = preview_song_arc.lock().unwrap().take()
                    .unwrap_or_else(|| id_for_task.clone());

                // Resume main if we paused it.
                if preview_resume_arc.swap(false, Ordering::AcqRel) {
                    let mut cur = main_current.lock().unwrap();
                    if let Some(sink) = &cur.sink {
                        if sink.is_paused() {
                            let pos = cur.paused_at.unwrap_or(cur.seek_offset);
                            sink.play();
                            cur.seek_offset = pos;
                            cur.play_started = Some(Instant::now());
                            cur.paused_at = None;
                        }
                    }
                }

                app_for_task.emit("audio:preview-end", PreviewEndPayload {
                    id: cleared_id,
                    reason: "natural",
                }).ok();
                return;
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_preview_format_hint_sniffs_flac_from_bytes() {
        let hint = resolve_preview_format_hint(
            "https://host/rest/stream.view?id=1",
            None,
            None,
            None,
            b"fLaC\x00\x00\x00\x22",
        );
        assert_eq!(hint.as_deref(), Some("flac"));
    }

    #[test]
    fn resolve_preview_format_hint_prefers_content_type_over_sniff() {
        let hint = resolve_preview_format_hint(
            "https://host/rest/stream.view?id=1",
            Some("audio/mpeg"),
            None,
            None,
            b"fLaC\x00\x00\x00\x22",
        );
        assert_eq!(hint.as_deref(), Some("mp3"));
    }

    #[test]
    fn resolve_preview_format_hint_uses_subsonic_suffix() {
        let hint = resolve_preview_format_hint(
            "https://host/rest/stream.view?id=1",
            None,
            None,
            Some("flac"),
            &[0x00, 0x01, 0x02, 0x03],
        );
        assert_eq!(hint.as_deref(), Some("flac"));
    }

    #[test]
    fn preview_format_hint_from_url_reads_format_query_param() {
        assert_eq!(
            preview_format_hint_from_url("https://h/stream.view?format=opus&id=x"),
            Some("opus".into())
        );
    }
}

#[tauri::command]
#[specta::specta]
pub fn audio_preview_stop(app: AppHandle, state: State<'_, AudioEngine>) {
    preview_stop_inner(&app, &state, true);
}

/// Like `audio_preview_stop` but leaves the main sink paused even if it had
/// been paused by `preview_pause_main`. Used by the player-bar Stop button so
/// "stop everything" actually goes silent — without this the engine would
/// auto-resume main playback the moment the preview ends and the user perceives
/// the click as having no effect.
#[tauri::command]
#[specta::specta]
pub fn audio_preview_stop_silent(app: AppHandle, state: State<'_, AudioEngine>) {
    preview_stop_inner(&app, &state, false);
}

/// Update the preview sink volume while a preview is in flight. Mirrors
/// `audio_set_volume` for the main sink. The frontend already folds in any
/// LUFS pre-analysis attenuation before calling, just like it does at preview
/// start, so the engine just clamps and applies the master headroom. No-op
/// when no preview is active.
#[tauri::command]
#[specta::specta]
pub fn audio_preview_set_volume(volume: f32, state: State<'_, AudioEngine>) {
    if let Some(sink) = state.preview_sink.lock().unwrap().as_ref() {
        sink.set_volume((volume.clamp(0.0, 1.0) * MASTER_HEADROOM).clamp(0.0, 1.0));
    }
}

pub(crate) fn preview_stop_inner(app: &AppHandle, state: &AudioEngine, resume_main: bool) {
    state.preview_gen.fetch_add(1, Ordering::SeqCst);
    let sink = state.preview_sink.lock().unwrap().take();
    let id = state.preview_song_id.lock().unwrap().take();
    if let Some(s) = sink { s.stop(); }

    if resume_main {
        preview_resume_main(state);
    } else {
        state.preview_main_resume.store(false, Ordering::Release);
    }

    if let Some(id) = id {
        app.emit("audio:preview-end", PreviewEndPayload {
            id,
            reason: "user",
        }).ok();
    }
}
