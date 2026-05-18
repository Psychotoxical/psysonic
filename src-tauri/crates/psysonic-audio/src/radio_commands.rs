//! Live internet-radio playback. Distinct from main track playback: no
//! gapless chain, no seek, no replay-gain, no preload.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ringbuf::traits::Split;
use ringbuf::{HeapCons, HeapRb};
use rodio::{Player, Source};
use tauri::{AppHandle, Emitter, State};

use super::decode::SizedDecoder;
use super::engine::{audio_http_client, AudioEngine};
use super::helpers::{content_type_to_hint, MASTER_HEADROOM};
use super::progress_task::spawn_progress_task;
use super::preview::preview_clear_for_new_main_playback;
use super::sources::{
    CountingSource, DynSource, EqSource, EqualPowerFadeIn, NotifyingSource,
    PriorityBoostSource, TriggeredFadeOut,
};
use super::stream::{
    radio_download_task, AudioStreamReader, RadioLiveState, RadioSharedFlags,
    RADIO_BUF_CAPACITY, RADIO_READ_TIMEOUT_SECS,
};

/// Play a live internet radio stream.
///
/// Sends `Icy-MetaData: 1` to request inline ICY metadata.
/// Emits `audio:playing` with `duration = 0.0` (sentinel for live stream)
/// and `radio:metadata` whenever the StreamTitle changes.
#[tauri::command]
pub async fn audio_play_radio(
    url: String,
    volume: f32,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Cancel any active preview so it doesn't keep playing alongside radio.
    preview_clear_for_new_main_playback(&state, &app);

    // Abort any previous radio task before stopping the sink.
    drop(state.radio_state.lock().unwrap().take());

    *state.chained_info.lock().unwrap() = None;
    {
        let mut cur = state.current.lock().unwrap();
        if let Some(old) = cur.sink.take() { old.stop(); }
    }
    if let Some(old) = state.fading_out_sink.lock().unwrap().take() { old.stop(); }

    // ── Open initial HTTP connection ──────────────────────────────────────────
    let response = audio_http_client(&state)
        .get(&url)
        .header("Icy-MetaData", "1")
        .send()
        .await
        .map_err(|e| {
            let m = format!("radio: connection failed: {e}");
            app.emit("audio:error", &m).ok();
            m
        })?;

    if !response.status().is_success() {
        let m = format!("radio: HTTP {}", response.status());
        app.emit("audio:error", &m).ok();
        return Err(m);
    }

    let fmt_hint = content_type_to_hint(
        response.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    );

    // ── Build 4 MB lock-free SPSC ring buffer ─────────────────────────────────
    let rb = HeapRb::<u8>::new(RADIO_BUF_CAPACITY);
    let (prod, cons) = rb.split();

    let (new_cons_tx, new_cons_rx) = std::sync::mpsc::channel::<HeapCons<u8>>();
    let flags = Arc::new(RadioSharedFlags {
        is_paused:      AtomicBool::new(false),
        is_hard_paused: AtomicBool::new(false),
        new_cons_tx:    Mutex::new(new_cons_tx),
    });

    // ── Spawn download task ───────────────────────────────────────────────────
    let task = tokio::spawn(radio_download_task(
        gen,
        state.generation.clone(),
        Some(response),
        audio_http_client(&state),
        url.clone(),
        prod,
        flags.clone(),
        app.clone(),
    ));

    *state.radio_state.lock().unwrap() = Some(RadioLiveState {
        url:  url.clone(),
        gen,
        task,
        flags: flags.clone(),
    });

    // ── Build Symphonia decoder in a blocking thread ──────────────────────────
    let reader = AudioStreamReader {
        read_timeout_secs: RADIO_READ_TIMEOUT_SECS,
        cons: Mutex::new(cons),
        new_cons_rx: Mutex::new(new_cons_rx),
        deadline: std::time::Instant::now() + Duration::from_secs(RADIO_READ_TIMEOUT_SECS),
        gen_arc:  state.generation.clone(),
        gen,
        source_tag: "radio",
        eof_when_empty: None,
        pos: 0,
    };

    if state.generation.load(Ordering::SeqCst) != gen { return Ok(()); }

    let hint_clone = fmt_hint.clone();
    let decoder = tokio::task::spawn_blocking(move || {
        SizedDecoder::new_streaming(Box::new(reader), hint_clone.as_deref(), "radio")
    })
    .await
    .map_err(|e| e.to_string())??;

    if state.generation.load(Ordering::SeqCst) != gen { return Ok(()); }

    let sample_rate     = decoder.sample_rate();
    let channels        = decoder.channels();
    let done_flag       = Arc::new(AtomicBool::new(false));
    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));
    state.samples_played.store(0, Ordering::Relaxed);

    // Radio: no gapless trim, no ReplayGain, 5 ms fade-in to suppress click.
    let dyn_src   = DynSource::new(decoder);
    let eq_src    = EqSource::new(dyn_src, state.eq_gains.clone(),
                                  state.eq_enabled.clone(), state.eq_pre_gain.clone());
    let fade_in   = EqualPowerFadeIn::new(eq_src, Duration::from_millis(5));
    let fade_out  = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    let notifying = NotifyingSource::new(fade_out, done_flag.clone());
    let counting  = CountingSource::new(notifying, state.samples_played.clone());
    let boosted   = PriorityBoostSource::new(counting);

    if state.generation.load(Ordering::SeqCst) != gen { return Ok(()); }

    let sink = Arc::new(Player::connect_new(state.stream_handle.lock().unwrap().mixer()));
    sink.set_volume((volume.clamp(0.0, 1.0) * MASTER_HEADROOM).clamp(0.0, 1.0));
    sink.append(boosted);

    {
        let mut cur = state.current.lock().unwrap();
        if let Some(old) = cur.sink.take() { old.stop(); }
        cur.sink              = Some(sink);
        cur.duration_secs     = 0.0; // sentinel: live stream
        cur.seek_offset       = 0.0;
        cur.play_started      = Some(Instant::now());
        cur.paused_at         = None;
        cur.replay_gain_linear = 1.0;
        cur.base_volume       = volume.clamp(0.0, 1.0);
        cur.fadeout_trigger   = Some(fadeout_trigger);
        cur.fadeout_samples   = Some(fadeout_samples);
    }

    *state.current_playback_url.lock().unwrap() = Some(url.clone());

    state.current_sample_rate.store(sample_rate.get(), Ordering::Relaxed);
    state.current_channels.store(channels.get() as u32, Ordering::Relaxed);

    app.emit("audio:playing", 0.0f64).ok();

    state.stream_playback_armed.store(true, Ordering::SeqCst);
    spawn_progress_task(
        gen,
        state.generation.clone(),
        state.current.clone(),
        state.chained_info.clone(),
        state.crossfade_enabled.clone(),
        state.crossfade_secs.clone(),
        done_flag,
        app,
        state.samples_played.clone(),
        state.current_sample_rate.clone(),
        state.current_channels.clone(),
        state.gapless_switch_at.clone(),
        state.current_playback_url.clone(),
        state.stream_playback_armed.clone(),
    );

    Ok(())
}
