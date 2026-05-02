//! Short preview playback on a secondary sink (same output stream).
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rodio::{Sink, Source};
use tauri::{AppHandle, Emitter, State};

use super::decode::SizedDecoder;
use super::engine::{audio_http_client, AudioEngine};
use super::helpers::MASTER_HEADROOM;
use super::sources::PriorityBoostSource;

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

/// Format hint inferred from a Subsonic stream URL. The frontend always passes
/// a `format=flac` query param for `.opus` files (server transcodes); for
/// everything else we guess from the URL's `format=` value or fall back to None.
pub(crate) fn preview_format_hint_from_url(url: &str) -> Option<String> {
    url.split('?')
        .nth(1)?
        .split('&')
        .find_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            if k.eq_ignore_ascii_case("format") { Some(v.to_string()) } else { None }
        })
}

#[tauri::command]
pub async fn audio_preview_play(
    id: String,
    url: String,
    start_sec: f64,
    duration_sec: f64,
    volume: f32,
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

    // ── Download ─────────────────────────────────────────────────────────────
    // Dedicated client with a generous timeout. The shared `audio_http_client`
    // caps at 30 s, which aborts mid-download on multi-hundred-megabyte
    // uncompressed files (e.g. 18-min Hi-Res WAV ~600 MB) — those need
    // ~60–120 s on a typical home LAN. The watchdog (30 s wall-clock) still
    // bounds how long the preview plays once the bytes are in memory, so a
    // long download just means a longer "loading" spinner before audio starts.
    let preview_http = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .use_rustls_tls()
        .user_agent(crate::subsonic_wire_user_agent())
        .build()
        .unwrap_or_else(|_| audio_http_client(&state));
    let bytes = preview_http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("preview: connection failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("preview: HTTP {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("preview: read body: {e}"))?
        .to_vec();

    if state.preview_gen.load(Ordering::SeqCst) != gen {
        // A newer preview started while we were downloading — bail.
        return Ok(());
    }

    // ── Decode ───────────────────────────────────────────────────────────────
    let hint = preview_format_hint_from_url(&url);
    let bytes_for_blocking = bytes;
    let hint_for_blocking = hint.clone();
    let decoder = tokio::task::spawn_blocking(move || {
        SizedDecoder::new(bytes_for_blocking, hint_for_blocking.as_deref(), false)
    })
    .await
    .map_err(|e| format!("preview: decoder thread: {e}"))??;

    if state.preview_gen.load(Ordering::SeqCst) != gen { return Ok(()); }

    // ── Build source pipeline ────────────────────────────────────────────────
    // Seek FIRST on the bare decoder, THEN cap with take_duration. Capping
    // before the seek made take_duration's wall-clock counter tick from
    // sink.append() while try_seek was still iterating the decoder to
    // mid-track — the preview window consumed itself before audio actually
    // arrived at the speaker (~25% of duration silent on FLAC/MP3 mid-track
    // starts). Symphonia FLAC without SEEKTABLE may fail try_seek; preview
    // then plays from 0, which is acceptable.
    // No EQ / no crossfade / no ReplayGain — preview stays simple.
    let mut source = decoder.convert_samples::<f32>();
    if start_sec > 0.5 {
        let _ = source.try_seek(Duration::from_secs_f64(start_sec));
    }
    let dur = Duration::from_secs_f64(duration_sec.max(1.0).min(120.0));
    let source = source.take_duration(dur);
    let source = PriorityBoostSource::new(source);

    // ── Build secondary sink on the existing OutputStream ────────────────────
    let sink = Arc::new(
        Sink::try_new(&*state.stream_handle.lock().unwrap())
            .map_err(|e| format!("preview: sink new: {e}"))?,
    );
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

#[tauri::command]
pub fn audio_preview_stop(app: AppHandle, state: State<'_, AudioEngine>) {
    preview_stop_inner(&app, &state, true);
}

/// Like `audio_preview_stop` but leaves the main sink paused even if it had
/// been paused by `preview_pause_main`. Used by the player-bar Stop button so
/// "stop everything" actually goes silent — without this the engine would
/// auto-resume main playback the moment the preview ends and the user perceives
/// the click as having no effect.
#[tauri::command]
pub fn audio_preview_stop_silent(app: AppHandle, state: State<'_, AudioEngine>) {
    preview_stop_inner(&app, &state, false);
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
