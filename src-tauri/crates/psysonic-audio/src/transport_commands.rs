//! Transport-control Tauri commands: pause / resume / stop / seek.
//! These don't drive playback startup — they mutate state on an already-running
//! sink (or coordinate radio reconnect for cold-resume).

use std::sync::atomic::Ordering;
use std::sync::{Arc, TryLockError};
use std::time::{Duration, Instant};

use ringbuf::traits::Split;
use ringbuf::HeapRb;
use tauri::{AppHandle, State};

use super::engine::{audio_http_client, AudioEngine};
use super::playback_rate::{
    content_position_from_samples, raw_counter_samples_for_content_position,
};
use super::preview::preview_clear_for_new_main_playback;
use super::stream::{radio_download_task, RADIO_BUF_CAPACITY};

#[tauri::command]
#[specta::specta]
pub fn audio_pause(state: State<'_, AudioEngine>) {
    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = &cur.sink {
        if !sink.is_paused() {
            let pos = content_position_from_samples(
                state.samples_played.load(Ordering::Relaxed),
                state.current_sample_rate.load(Ordering::Relaxed),
                state.current_channels.load(Ordering::Relaxed),
                &state.playback_rate,
            )
            .min(cur.duration_secs.max(0.001));
            sink.pause();
            cur.paused_at = Some(pos);
            cur.play_started = None;
        }
    }
    // Notify the download task so it can start measuring the hard-pause stall timer.
    if let Some(rs) = state.radio_state.lock().unwrap().as_ref() {
        rs.flags.is_paused.store(true, Ordering::Release);
    }
}

/// Resume playback.
///
/// **Warm resume** (`is_hard_paused = false`): download task is still running,
/// buffer has buffered audio.  `sink.play()` suffices.
///
/// **Cold resume** (`is_hard_paused = true`): TCP was dropped.  A fresh 4 MB
/// ring buffer is created, its consumer is sent to `AudioStreamReader` (which
/// swaps it in on the next `read()`), and a new download task is spawned.
#[tauri::command]
#[specta::specta]
pub async fn audio_resume(state: State<'_, AudioEngine>, app: AppHandle) -> Result<(), String> {
    // If a preview is running, cancel it first — otherwise sink.play() on the
    // main sink would mix on top of the preview sink.
    preview_clear_for_new_main_playback(&state, &app);

    // Detect radio hard-disconnect.
    let reconnect_info = {
        let guard = state.radio_state.lock().unwrap();
        guard
            .as_ref()
            .filter(|rs| rs.flags.is_hard_paused.load(Ordering::Acquire))
            .map(|rs| (rs.url.clone(), rs.gen, rs.flags.clone()))
    };

    if let Some((url, gen, flags)) = reconnect_info {
        let rb = HeapRb::<u8>::new(RADIO_BUF_CAPACITY);
        let (new_prod, new_cons) = rb.split();

        // Send new consumer to AudioStreamReader (non-blocking; unbounded channel).
        let ok = flags.new_cons_tx.lock().unwrap().send(new_cons).is_ok();

        if ok {
            let new_task = tokio::spawn(radio_download_task(
                gen,
                state.generation.clone(),
                None, // task performs its own fresh GET
                audio_http_client(&state),
                url,
                new_prod,
                flags.clone(),
                app,
            ));
            if let Some(rs) = state.radio_state.lock().unwrap().as_mut() {
                let old = std::mem::replace(&mut rs.task, new_task);
                old.abort(); // ensure any lingering old task is gone
                rs.flags.is_hard_paused.store(false, Ordering::Release);
                rs.flags.is_paused.store(false, Ordering::Release);
            }
        } else {
            crate::app_eprintln!("[radio] resume: AudioStreamReader gone — skipping reconnect");
        }
    }

    // Resume the rodio Sink (works for both warm and cold resume).
    {
        let mut cur = state.current.lock().unwrap();
        if let Some(sink) = &cur.sink {
            if sink.is_paused() {
                let pos = cur.paused_at.unwrap_or(cur.seek_offset);
                sink.play();
                cur.seek_offset  = pos;
                cur.play_started = Some(Instant::now());
                cur.paused_at    = None;
            }
        }
    }
    if let Some(rs) = state.radio_state.lock().unwrap().as_ref() {
        rs.flags.is_paused.store(false, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn audio_stop(state: State<'_, AudioEngine>, app: AppHandle) {
    preview_clear_for_new_main_playback(&state, &app);
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.current_playback_url.lock().unwrap() = None;
    *state.current_analysis_track_id.lock().unwrap() = None;
    *state.current_playback_server_id.lock().unwrap() = None;
    *state.chained_info.lock().unwrap() = None;
    // Keep `stream_completed_cache`: natural track end often calls `audio_stop` when the
    // queue is exhausted; clearing here dropped the full ranged buffer and forced a
    // re-download on replay. The slot is only consumed on `take`/overwrite for another URL.
    // Drop RadioLiveState → triggers Drop → task.abort() → TCP released.
    drop(state.radio_state.lock().unwrap().take());
    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = cur.sink.take() { sink.stop(); }
    cur.duration_secs = 0.0;
    cur.seek_offset   = 0.0;
    cur.play_started  = None;
    cur.paused_at     = None;
    drop(cur);
    let _ = super::stream_idle::release_output_stream_on_stop(state.inner(), &app);
}

#[tauri::command]
#[specta::specta]
pub fn audio_seek(seconds: f64, state: State<'_, AudioEngine>) -> Result<(), String> {
    let state = state.inner();
    const AUDIO_SEEK_TIMEOUT_MS: u64 = 700;
    const AUDIO_SEEK_LOCK_TIMEOUT_MS: u64 = 40;
    // Ghost-command guard: reject seeks within 500 ms of a gapless auto-advance.
    {
        let switch_ms = state.gapless_switch_at.load(Ordering::SeqCst);
        if switch_ms > 0 {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            if now_ms.saturating_sub(switch_ms) < 500 {
                return Ok(());
            }
        }
    }

    // Reject seek up-front for non-seekable streaming sources so the frontend's
    // restart-fallback engages instead of rolling the dice on the format reader
    // (which can consume the ring buffer to EOF for forward seeks → next song).
    if !state.current_is_seekable.load(Ordering::SeqCst) {
        crate::app_deprintln!("[seek] rejected → not-seekable source (legacy stream)");
        return Err("source is not seekable".into());
    }
    crate::app_deprintln!("[seek] target={:.2}s", seconds);

    let lock_current_with_timeout = |timeout_ms: u64| {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            match state.current.try_lock() {
                Ok(guard) => break Ok(guard),
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        break Err("audio seek busy".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(TryLockError::Poisoned(_)) => {
                    break Err("audio state lock poisoned".to_string());
                }
            }
        }
    };

    // Seeking back invalidates any pending gapless chain.
    let cur_pos = content_position_from_samples(
        state.samples_played.load(Ordering::Relaxed),
        state.current_sample_rate.load(Ordering::Relaxed),
        state.current_channels.load(Ordering::Relaxed),
        &state.playback_rate,
    );
    if seconds < cur_pos - 1.0 {
        *state.chained_info.lock().unwrap() = None;
    }

    let seek_seconds = seconds.max(0.0);
    let seek_duration = Duration::from_secs_f64(seek_seconds);
    let seek_generation = state.generation.load(Ordering::SeqCst);
    let sink = {
        let cur = lock_current_with_timeout(AUDIO_SEEK_LOCK_TIMEOUT_MS)?;
        match cur.sink.as_ref() {
            Some(sink) => Arc::clone(sink),
            None => return Ok(()),
        }
    };

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let result = sink.try_seek(seek_duration).map_err(|e| e.to_string());
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_millis(AUDIO_SEEK_TIMEOUT_MS)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            return Err("audio seek timeout".into());
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            return Err("audio seek worker disconnected".into());
        }
    }

    // If playback switched while seek was in flight, skip timestamp updates.
    if state.generation.load(Ordering::SeqCst) != seek_generation {
        return Ok(());
    }

    let mut cur = lock_current_with_timeout(AUDIO_SEEK_LOCK_TIMEOUT_MS)?;
    if cur.sink.is_none() { return Ok(()); }

    if cur.paused_at.is_some() {
        cur.paused_at = Some(seek_seconds);
    } else {
        cur.seek_offset = seek_seconds;
        cur.play_started = Some(Instant::now());
    }
    state.samples_played.store(
        raw_counter_samples_for_content_position(
            seek_seconds,
            state.current_sample_rate.load(Ordering::Relaxed),
            state.current_channels.load(Ordering::Relaxed),
            &state.playback_rate,
        ),
        Ordering::Relaxed,
    );
    Ok(())
}
