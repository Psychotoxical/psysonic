//! `AudioEngine` / `AudioCurrent`, stream thread, and HTTP client refresh.
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use rodio::Player;
use tauri::{AppHandle, Manager};

use super::state::{ChainedInfo, PreloadedTrack};

/// Reply channel handed back to the audio-stream thread once a re-open finishes.
pub type StreamReopenReply = std::sync::mpsc::SyncSender<Arc<rodio::MixerDeviceSink>>;
/// Stream-thread re-open request: `(desired_rate, is_hi_res, device_name, reply_tx)`.
pub type StreamReopenRequest = (u32, bool, Option<String>, StreamReopenReply);

pub struct AudioEngine {
    pub stream_handle: Arc<std::sync::Mutex<Arc<rodio::MixerDeviceSink>>>,
    /// Sample rate the output stream was last opened at (updated on every re-open).
    pub stream_sample_rate: Arc<AtomicU32>,
    /// The rate the device was opened at on cold start — used to restore the
    /// stream when Hi-Res is toggled off while a hi-res rate is active.
    pub device_default_rate: u32,
    /// Sends `(desired_rate, is_hi_res, device_name, reply_tx)` to the audio-stream
    /// thread to re-open the output device. `device_name = None` → system default.
    pub stream_reopen_tx: std::sync::mpsc::SyncSender<StreamReopenRequest>,
    /// User-selected output device name (None = follow system default).
    pub selected_device: Arc<Mutex<Option<String>>>,
    pub current: Arc<Mutex<AudioCurrent>>,
    /// Monotonically incremented on each audio_play (non-chain) / audio_stop call.
    pub generation: Arc<AtomicU64>,
    pub http_client: Arc<RwLock<reqwest::Client>>,
    pub eq_gains: Arc<[AtomicU32; 10]>,
    pub eq_enabled: Arc<AtomicBool>,
    pub eq_pre_gain: Arc<AtomicU32>,
    pub(crate) preloaded: Arc<Mutex<Option<PreloadedTrack>>>,
    /// Last fully downloaded manual-stream track bytes (same playback identity),
    /// used to recover seek/replay without waiting for network again.
    pub(crate) stream_completed_cache: Arc<Mutex<Option<PreloadedTrack>>>,
    /// True when the currently playing source supports seeking (in-memory bytes
    /// or `RangedHttpSource`); false for the legacy non-seekable streaming
    /// fallback (`AudioStreamReader`). `audio_seek` rejects with a "not
    /// seekable" error when false so the frontend restart-fallback can engage.
    pub(crate) current_is_seekable: Arc<AtomicBool>,
    pub crossfade_enabled: Arc<AtomicBool>,
    pub crossfade_secs: Arc<AtomicU32>,
    pub fading_out_sink: Arc<Mutex<Option<Arc<Player>>>>,
    /// When true, audio_play chains sources to the existing Sink instead of
    /// creating a new one, achieving sample-accurate gapless transitions.
    pub gapless_enabled: Arc<AtomicBool>,
    /// 0=off, 1=replaygain, 2=loudness (future runtime loudness engine).
    pub normalization_engine: Arc<AtomicU32>,
    /// Target loudness in LUFS for loudness engine (future use).
    pub normalization_target_lufs: Arc<AtomicU32>,
    /// Extra attenuation (dB) when no loudness DB row exists at decode bind; also seeds streaming heuristics (Settings).
    pub loudness_pre_analysis_attenuation_db: Arc<AtomicU32>,
    /// Info about the next-up chained track (gapless mode).
    /// The progress task reads this when `current_source_done` fires.
    pub(crate) chained_info: Arc<Mutex<Option<ChainedInfo>>>,
    /// Atomic sample counter — incremented by CountingSource in the audio thread.
    /// Progress task reads this for drift-free position tracking.
    pub samples_played: Arc<AtomicU64>,
    /// Sample rate of the currently playing source (for samples → seconds).
    pub current_sample_rate: Arc<AtomicU32>,
    /// Channel count of the currently playing source.
    pub current_channels: Arc<AtomicU32>,
    /// Instant (as nanos since UNIX epoch via Instant hack) of the last gapless
    /// auto-advance. Commands arriving within 500 ms are rejected as ghost commands.
    pub gapless_switch_at: Arc<AtomicU64>,
    /// Active radio session state.  None for regular (non-radio) tracks.
    /// Dropping the value aborts the HTTP download task via RadioLiveState::Drop.
    pub(crate) radio_state: Mutex<Option<crate::stream::RadioLiveState>>,
    /// URL last committed to `AudioCurrent` — used so `audio_update_replay_gain` can
    /// resolve LUFS / startup trim when the frontend passes `loudnessGainDb: null`
    /// (otherwise `compute_gain` would treat that as unity gain and playback "jumps").
    pub(crate) current_playback_url: Arc<Mutex<Option<String>>>,
    /// Subsonic song id last passed from JS with `audio_play` (trimmed). Used
    /// for loudness/waveform cache when the URL is `psysonic-local://…`.
    pub(crate) current_analysis_track_id: Arc<Mutex<Option<String>>>,
    /// While a `RangedHttpSource` download task is filling the buffer for this
    /// `(track_id, play_generation)`, skip `analysis_enqueue_seed_from_url` for the
    /// same id — otherwise a parallel full GET + Symphonia competes with playback
    /// decode (ALSA underruns). The ranged task clears this on exit; `gen` avoids a
    /// late drop clearing a newer play of the same track.
    pub(crate) ranged_loudness_seed_hold: Arc<Mutex<Option<(String, u64)>>>,
    /// Secondary sink dedicated to track previews. Runs on the same `OutputStream`
    /// as the main sink (rodio mixes both internally) so we don't open a second
    /// device handle — important on ALSA-exclusive hardware.
    pub(crate) preview_sink: Arc<Mutex<Option<Arc<Player>>>>,
    /// Cancel token for the active preview. Bumped on every `audio_preview_play`
    /// and `audio_preview_stop` so that orphan timer/progress tasks bail out.
    pub(crate) preview_gen: Arc<AtomicU64>,
    /// True when `audio_preview_play` paused the main sink and should resume it
    /// on preview end. False if the main sink was already paused (or empty).
    pub(crate) preview_main_resume: Arc<AtomicBool>,
    /// Subsonic song id of the currently playing preview. Echoed back in
    /// `audio:preview-end` so the frontend can clear UI state for that row.
    pub(crate) preview_song_id: Arc<Mutex<Option<String>>>,
}

pub struct AudioCurrent {
    pub sink: Option<Arc<Player>>,
    pub duration_secs: f64,
    pub seek_offset: f64,
    pub play_started: Option<Instant>,
    pub paused_at: Option<f64>,
    pub replay_gain_linear: f32,
    pub base_volume: f32,
    /// Crossfade: trigger for sample-level fade-out of the current source.
    pub fadeout_trigger: Option<Arc<AtomicBool>>,
    /// Crossfade: total fade samples (set before triggering).
    pub fadeout_samples: Option<Arc<AtomicU64>>,
}

impl AudioCurrent {
    pub fn position(&self) -> f64 {
        if let Some(p) = self.paused_at {
            return p;
        }
        if let Some(t) = self.play_started {
            let elapsed = t.elapsed().as_secs_f64();
            (self.seek_offset + elapsed).min(self.duration_secs.max(0.001))
        } else {
            self.seek_offset
        }
    }
}

/// Open an output device at `desired_rate` Hz (0 = device default).
///
/// `device_name`: exact name from `audio_list_devices`. `None` → system default.
/// Falls back to the system default if the named device is not found.
///
/// Resolution order:
///   1. Exact rate match in the device's supported config ranges.
///   2. Highest available rate (for hardware that doesn't support the source rate).
///   3. Device default.
///   4. System default (last resort).
///
/// Returns `(stream_handle, actual_sample_rate)`.
fn open_stream_for_device_and_rate(device_name: Option<&str>, desired_rate: u32) -> (Arc<rodio::MixerDeviceSink>, u32) {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};

    // Suppress ALSA stderr noise while enumerating devices on Unix.
    #[cfg(unix)]
    let _guard = unsafe {
        struct StderrGuard(i32);
        impl Drop for StderrGuard {
            fn drop(&mut self) { unsafe { libc::dup2(self.0, 2); libc::close(self.0); } }
        }
        let saved = libc::dup(2);
        let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY);
        libc::dup2(devnull, 2);
        libc::close(devnull);
        StderrGuard(saved)
    };

    let host = rodio::cpal::default_host();

    // Resolve the target device: explicit name first, then (on Linux) prefer
    // a "pipewire" or "pulse" ALSA alias before falling back to cpal's system
    // default. On PipeWire-based distros the raw ALSA `default` alias can
    // route to a null sink at app-start (issue #234 on Debian 13): the stream
    // opens cleanly, progress ticks run, no audio reaches the user. The
    // named-alias path goes through pipewire-alsa's real sink and just works.
    // On systems where neither alias exists (pure ALSA, macOS, Windows),
    // `find_by_name` returns None and we drop through to `default_output_device`
    // unchanged — no regression.
    let find_by_name = |name: &str| -> Option<_> {
        host.output_devices().ok()?.find(|d| {
            d.description()
                .ok()
                .map(|desc| desc.name().to_string())
                .as_deref()
                == Some(name)
        })
    };

    let device = device_name
        .and_then(find_by_name)
        .or_else(|| {
            #[cfg(target_os = "linux")]
            { find_by_name("pipewire").or_else(|| find_by_name("pulse")) }
            #[cfg(not(target_os = "linux"))]
            { None }
        })
        .or_else(|| host.default_output_device());

    if let Some(device) = device {
        if desired_rate > 0 {
            if let Ok(supported) = device.supported_output_configs() {
                let configs: Vec<_> = supported.collect();

                // 1. Exact rate match — prefer more channels (stereo > mono).
                let exact = configs.iter()
                    .filter(|c| {
                        c.min_sample_rate() <= desired_rate
                            && desired_rate <= c.max_sample_rate()
                    })
                    .max_by_key(|c| c.channels());

                if exact.is_some() {
                    if let Ok(handle) = rodio::DeviceSinkBuilder::from_device(device.clone())
                        .and_then(|b| b.with_sample_rate(std::num::NonZeroU32::new(desired_rate).unwrap_or(std::num::NonZeroU32::MIN)).open_stream())
                    {
                        crate::app_eprintln!("[psysonic] audio stream opened at {} Hz (exact)", desired_rate);
                        return (Arc::new(handle), desired_rate);
                    }
                }

                // 2. No exact match — use the highest supported rate.
                let best = configs.iter()
                    .max_by_key(|c| c.max_sample_rate());

                if let Some(cfg) = best {
                    let rate = cfg.max_sample_rate();
                    if let Ok(handle) = rodio::DeviceSinkBuilder::from_device(device.clone())
                        .and_then(|b| b.with_sample_rate(std::num::NonZeroU32::new(rate).unwrap_or(std::num::NonZeroU32::MIN)).open_stream())
                    {
                        crate::app_eprintln!(
                            "[psysonic] audio stream opened at {} Hz (highest, wanted {})",
                            rate, desired_rate
                        );
                        return (Arc::new(handle), rate);
                    }
                }
            }
        }

        // 3. Device default.
        if let Ok(handle) = rodio::DeviceSinkBuilder::from_device(device.clone()).and_then(|b| b.open_stream()) {
            let rate = device
                .default_output_config()
                .map(|c| c.sample_rate())
                .unwrap_or(44100);
            crate::app_eprintln!("[psysonic] audio stream opened at {} Hz (device default)", rate);
            return (Arc::new(handle), rate);
        }
    }

    // 4. Last resort: system default.
    crate::app_eprintln!("[psysonic] audio stream falling back to system default");
    let handle = rodio::DeviceSinkBuilder::open_default_sink()
        .expect("cannot open any audio output device");
    let rate = rodio::cpal::default_host()
        .default_output_device()
        .and_then(|d| d.default_output_config().ok())
        .map(|c| c.sample_rate())
        .unwrap_or(44100);
    (Arc::new(handle), rate)
}

pub fn create_engine() -> (AudioEngine, std::thread::JoinHandle<()>) {
    // macOS: request a smaller CoreAudio buffer to reduce output latency.
    #[cfg(target_os = "macos")]
    {
        if std::env::var("COREAUDIO_BUFFER_SIZE").is_err() {
            std::env::set_var("COREAUDIO_BUFFER_SIZE", "512");
        }
    }

    // Channels: main thread ←→ audio-stream thread.
    //   init_tx/rx : (Arc<rodio::MixerDeviceSink>, actual_rate) sent once at startup.
    //   reopen_tx/rx: (desired_rate, reply_tx) — triggers a stream re-open.
    let (init_tx, init_rx) =
        std::sync::mpsc::sync_channel::<(Arc<rodio::MixerDeviceSink>, u32)>(0);
    let (reopen_tx, reopen_rx) =
        std::sync::mpsc::sync_channel::<(u32, bool, Option<String>, std::sync::mpsc::SyncSender<Arc<rodio::MixerDeviceSink>>)>(4);

    let thread = std::thread::Builder::new()
        .name("psysonic-audio-stream".into())
        .spawn(move || {
            // Set PipeWire / PulseAudio latency hints before the first open.
            #[cfg(target_os = "linux")]
            {
                // Match cpal ALSA ~200 ms headroom: larger quantum reduces underruns when
                // the decoder thread catches up after seek or competes with other work.
                if std::env::var("PIPEWIRE_LATENCY").is_err() {
                    std::env::set_var("PIPEWIRE_LATENCY", "8192/48000");
                }
                if std::env::var("PULSE_LATENCY_MSEC").is_err() {
                    std::env::set_var("PULSE_LATENCY_MSEC", "170");
                }
            }

            // Thread priority is kept at default during standard-mode playback.
            // It is escalated to Max only when a Hi-Res stream reopen is requested,
            // to prevent PipeWire underruns at high quantum sizes (8192 frames).
            let (mut _stream, rate) = open_stream_for_device_and_rate(None, 0);
            let handle = _stream.clone();
            init_tx.send((handle, rate)).ok();

            // Keep the stream alive and handle sample-rate / device-switch requests.
            while let Ok((desired_rate, is_hi_res, device_name, reply_tx)) = reopen_rx.recv() {
                // Escalate to Max for Hi-Res reopens (large PipeWire quanta need
                // real-time scheduling to avoid underruns). No escalation for
                // standard mode — the thread blocks on recv() between reopens so
                // elevated priority would only waste scheduler budget.
                if is_hi_res {
                    thread_priority::set_current_thread_priority(
                        thread_priority::ThreadPriority::Max
                    ).ok();
                }

                drop(_stream); // close old stream before opening new one

                // Scale the PipeWire quantum with the sample rate so wall-clock
                // latency stays roughly constant (≈93 ms) at all rates.
                // 8192 frames at 88200 Hz ≈ 92.9 ms (same as 4096 at 48000 Hz).
                #[cfg(target_os = "linux")]
                {
                    let frames: u32 = if desired_rate > 48_000 { 8192 } else { 4096 };
                    std::env::set_var("PIPEWIRE_LATENCY", format!("{frames}/{desired_rate}"));
                    // Keep PULSE_LATENCY_MSEC in sync so PulseAudio-based setups
                    // get the same wall-clock quantum as PipeWire.
                    let latency_ms = (frames as f64 / desired_rate as f64 * 1000.0).round() as u64;
                    std::env::set_var("PULSE_LATENCY_MSEC", latency_ms.to_string());
                }

                let (new_stream, _actual) = open_stream_for_device_and_rate(device_name.as_deref(), desired_rate);
                let new_handle = new_stream.clone();
                _stream = new_stream;
                reply_tx.send(new_handle).ok();
            }
        })
        .expect("spawn audio stream thread");

    let (initial_handle, initial_rate) = init_rx.recv().expect("audio stream handle");

    let engine = AudioEngine {
        stream_handle: Arc::new(std::sync::Mutex::new(initial_handle)),
        stream_sample_rate: Arc::new(AtomicU32::new(initial_rate)),
        device_default_rate: initial_rate,
        stream_reopen_tx: reopen_tx,
        selected_device: Arc::new(Mutex::new(None)),
        current: Arc::new(Mutex::new(AudioCurrent {
            sink: None,
            duration_secs: 0.0,
            seek_offset: 0.0,
            play_started: None,
            paused_at: None,
            replay_gain_linear: 1.0,
            base_volume: 0.8,
            fadeout_trigger: None,
            fadeout_samples: None,
        })),
        generation: Arc::new(AtomicU64::new(0)),
        http_client: Arc::new(RwLock::new(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .use_rustls_tls()
                .user_agent(psysonic_core::user_agent::subsonic_wire_user_agent())
                .build()
                .unwrap_or_default(),
        )),
        eq_gains: Arc::new(std::array::from_fn(|_| AtomicU32::new(0f32.to_bits()))),
        eq_enabled: Arc::new(AtomicBool::new(false)),
        eq_pre_gain: Arc::new(AtomicU32::new(0f32.to_bits())),
        preloaded: Arc::new(Mutex::new(None)),
        stream_completed_cache: Arc::new(Mutex::new(None)),
        current_is_seekable: Arc::new(AtomicBool::new(true)),
        crossfade_enabled: Arc::new(AtomicBool::new(false)),
        crossfade_secs: Arc::new(AtomicU32::new(3.0f32.to_bits())),
        fading_out_sink: Arc::new(Mutex::new(None)),
        gapless_enabled: Arc::new(AtomicBool::new(false)),
        normalization_engine: Arc::new(AtomicU32::new(0)),
        normalization_target_lufs: Arc::new(AtomicU32::new((-16.0f32).to_bits())),
        loudness_pre_analysis_attenuation_db: Arc::new(AtomicU32::new((-4.5f32).to_bits())),
        chained_info: Arc::new(Mutex::new(None)),
        samples_played: Arc::new(AtomicU64::new(0)),
        current_sample_rate: Arc::new(AtomicU32::new(0)),
        current_channels: Arc::new(AtomicU32::new(2)),
        gapless_switch_at: Arc::new(AtomicU64::new(0)),
        radio_state: Mutex::new(None),
        current_playback_url: Arc::new(Mutex::new(None)),
        current_analysis_track_id: Arc::new(Mutex::new(None)),
        ranged_loudness_seed_hold: Arc::new(Mutex::new(None)),
        preview_sink: Arc::new(Mutex::new(None)),
        preview_gen: Arc::new(AtomicU64::new(0)),
        preview_main_resume: Arc::new(AtomicBool::new(false)),
        preview_song_id: Arc::new(Mutex::new(None)),
    };

    (engine, thread)
}
/// `analysis_enqueue_seed_from_url` should bail while this track's ranged HTTP buffer
/// is still filling — playback will seed on completion with the same bytes.
pub fn ranged_loudness_backfill_should_defer(engine: &AudioEngine, track_id: &str) -> bool {
    let tid = track_id.trim();
    if tid.is_empty() {
        return false;
    }
    let Ok(g) = engine.ranged_loudness_seed_hold.lock() else {
        return false;
    };
    matches!(&*g, Some((t, _)) if t.as_str() == tid)
}

/// Stops the Rust audio engine cleanly (mirrors the logic in `audio_stop`).
/// Called before process exit on macOS to ensure audio stops immediately.
pub fn stop_audio_engine(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    let engine = app.state::<AudioEngine>();
    engine.generation.fetch_add(1, Ordering::SeqCst);
    *engine.chained_info.lock().unwrap() = None;
    drop(engine.radio_state.lock().unwrap().take());
    let mut cur = engine.current.lock().unwrap();
    if let Some(sink) = cur.sink.take() { sink.stop(); }
}

/// Subsonic id pinned for the playing source (`audio_play`). Used to prioritize
/// HTTP loudness backfill for the track the user is listening to.
pub fn analysis_track_id_is_current_playback(engine: &AudioEngine, track_id: &str) -> bool {
    let needle = track_id.trim();
    if needle.is_empty() {
        return false;
    }
    let Ok(guard) = engine.current_analysis_track_id.lock() else {
        return false;
    };
    let Some(cur) = guard.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    cur == needle
}

pub(crate) fn audio_http_client(state: &AudioEngine) -> reqwest::Client {
    state
        .http_client
        .read()
        .map(|c| c.clone())
        .unwrap_or_default()
}

pub fn refresh_http_user_agent(state: &AudioEngine, ua: &str) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .use_rustls_tls()
        .user_agent(ua)
        .build()
        .unwrap_or_default();
    if let Ok(mut slot) = state.http_client.write() {
        *slot = client;
    }
}
pub(crate) fn analysis_seed_high_priority_for_track(app: &AppHandle, track_id: &str) -> bool {
    app.try_state::<AudioEngine>()
        .is_some_and(|e| analysis_track_id_is_current_playback(&e, track_id))
}
