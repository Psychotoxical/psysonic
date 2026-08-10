//! `AudioEngine` / `AudioCurrent`, stream thread, and HTTP client refresh.
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use rodio::Player;
use tauri::Manager;

use super::state::{ChainedInfo, CurrentSourceDone, PreloadedTrack, StreamCompletedSpill};

/// Reply channel handed back to the audio-stream thread once an open finishes.
pub type StreamOpenResult = Result<(Arc<rodio::MixerDeviceSink>, u32), String>;
pub type StreamOpenReply = std::sync::mpsc::SyncSender<StreamOpenResult>;

/// Requests handled on the dedicated audio-stream thread (open / idle release).
pub enum StreamThreadMsg {
    Open {
        desired_rate: u32,
        is_hi_res: bool,
        device_name: Option<String>,
        require_named_device: bool,
        reply: StreamOpenReply,
    },
    Release {
        reply: std::sync::mpsc::SyncSender<()>,
    },
}

pub struct AudioEngine {
    pub stream_handle: Arc<std::sync::Mutex<Option<Arc<rodio::MixerDeviceSink>>>>,
    /// Serializes release/open/state-commit as one output-stream transaction.
    pub(crate) stream_open_lock: Arc<Mutex<()>>,
    /// Players connected to the mixer but not yet registered in engine state.
    pub(crate) stream_attach_pending: Arc<(Mutex<u32>, Condvar)>,
    /// Serializes playback generation changes with final sink registration.
    pub(crate) playback_commit_lock: Arc<Mutex<()>>,
    /// Actual mixer/device rate selected by the output backend.
    pub stream_sample_rate: Arc<AtomicU32>,
    /// Last rate requested by playback mode. Kept separate from the negotiated
    /// rate so ALSA coercion does not trigger another reopen on every track.
    pub stream_requested_rate: Arc<AtomicU32>,
    /// The rate the device was opened at on cold start — used to restore the
    /// stream when Hi-Res is toggled off while a hi-res rate is active.
    pub device_default_rate: u32,
    /// Open or release the CPAL output stream on the audio-stream thread.
    pub stream_thread_tx: std::sync::mpsc::SyncSender<StreamThreadMsg>,
    /// User-selected output device name (None = follow system default).
    pub selected_device: Arc<Mutex<Option<String>>>,
    pub current: Arc<Mutex<AudioCurrent>>,
    /// Monotonically incremented on each audio_play (non-chain) / audio_stop call.
    pub generation: Arc<AtomicU64>,
    /// Invalidates background byte/gapless preloads without superseding the
    /// currently playing source or stopping its progress task.
    pub(crate) preload_epoch: Arc<AtomicU64>,
    pub http_client: Arc<RwLock<reqwest::Client>>,
    pub eq_gains: Arc<[AtomicU32; 10]>,
    pub eq_enabled: Arc<AtomicBool>,
    pub eq_pre_gain: Arc<AtomicU32>,
    pub playback_rate: crate::playback_rate::PlaybackRateAtomics,
    pub(crate) preloaded: Arc<Mutex<Option<PreloadedTrack>>>,
    /// Last fully downloaded manual-stream track bytes (same playback identity),
    /// used to recover seek/replay without waiting for network again.
    pub(crate) stream_completed_cache: Arc<Mutex<Option<PreloadedTrack>>>,
    /// On-disk spill for completed ranged streams above `TRACK_STREAM_PROMOTE_MAX_BYTES`.
    pub(crate) stream_completed_spill: Arc<Mutex<Option<StreamCompletedSpill>>>,
    /// True when the currently playing source supports seeking (in-memory bytes
    /// or `RangedHttpSource`); false for the legacy non-seekable streaming
    /// fallback (`AudioStreamReader`). `audio_seek` rejects with a "not
    /// seekable" error when false so the frontend restart-fallback can engage.
    pub(crate) current_is_seekable: Arc<AtomicBool>,
    /// HTTP stream paths (`RangedHttpSource`, legacy `AudioStreamReader`): false
    /// until `TRACK_STREAM_PLAY_START_BYTES` are buffered (or download ends).
    /// Bytes / local file / radio keep true.
    pub(crate) stream_playback_armed: Arc<AtomicBool>,
    pub crossfade_enabled: Arc<AtomicBool>,
    pub crossfade_secs: Arc<AtomicU32>,
    /// AutoDJ: when true, the progress task does NOT fire its autonomous
    /// `crossfade_secs`-before-end `audio:ended` timer — the JS A-tail logic
    /// drives every advance (gated on the next track being playable). Prevents
    /// the engine from starting a still-buffering next track and fading over it
    /// (an audible "jump"); cold next-track degrades to a clean sequential start.
    pub(crate) autodj_suppress_autocrossfade: Arc<AtomicBool>,
    /// AutoDJ interrupt prep: `audio_begin_outgoing_fade` volume-ducked the
    /// outgoing sink; block normalization/volume ramps until the handoff swap.
    pub(crate) interrupt_outgoing_duck_active: Arc<AtomicBool>,
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
    /// Generation-qualified completion flag for the currently active source.
    /// Replaced when Hi-Res realignment rebuilds a source in-place.
    pub(crate) current_source_done: CurrentSourceDone,
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
    /// App server id (`playbackServerId ?? activeServerId`) of the current
    /// playback, pinned by `audio_play`. Scopes analysis-cache reads (loudness
    /// gain, replay-gain updates, device resume) to the right server so a switch
    /// can't surface another server's blob for the same bare `track_id`.
    pub(crate) current_playback_server_id: Arc<Mutex<Option<String>>>,
    /// While a `RangedHttpSource` download task is filling the buffer for this
    /// `(track_id, play_generation)`, skip `analysis_enqueue_seed_from_url` for the
    /// same id — otherwise a parallel full GET + Symphonia competes with playback
    /// decode (ALSA underruns). The stream task clears this on exit; `gen` avoids a
    /// late drop clearing a newer play of the same track.
    pub(crate) playback_analysis_seed_hold: Arc<Mutex<Option<(String, u64)>>>,
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
/// Linux resolves one target device, selects its exact/highest/default config,
/// then performs one ALSA negotiation probe. Other platforms retain Rodio's
/// broader fallback behavior.
///
/// Rodio prints a stderr line on every intentional stream drop. Keep that only
/// when runtime logging is in **debug** mode; normal/off silence the noise.
fn finalize_mixer_device_sink(mut handle: rodio::MixerDeviceSink) -> Arc<rodio::MixerDeviceSink> {
    if !crate::logging::should_log_debug() {
        handle.log_on_drop(false);
    }
    let handle = Arc::new(handle);
    #[cfg(target_os = "linux")]
    crate::linux_realtime::promote_audio_threads();
    handle
}

fn open_stream_with_verified_rate(
    device: &rodio::cpal::Device,
    config: &rodio::cpal::SupportedStreamConfig,
) -> StreamOpenResult {
    let requested_rate = config.sample_rate();
    #[cfg(target_os = "linux")]
    let actual_rate = crate::alsa_rate::negotiated_output_rate(device, config)?;
    #[cfg(not(target_os = "linux"))]
    let actual_rate = requested_rate;

    #[cfg(target_os = "linux")]
    if actual_rate != requested_rate {
        crate::app_eprintln!(
            "[psysonic] ALSA negotiated {actual_rate} Hz for requested {requested_rate} Hz; using the negotiated mixer rate"
        );
    }

    #[cfg(target_os = "linux")]
    let builder = rodio::DeviceSinkBuilder::default()
        .with_device(device.clone())
        .with_channels(
            std::num::NonZeroU16::new(config.channels())
                .ok_or_else(|| "audio output configuration has zero channels".to_string())?,
        )
        .with_sample_format(config.sample_format());
    #[cfg(not(target_os = "linux"))]
    let builder = rodio::DeviceSinkBuilder::from_device(device.clone())
        .map_err(|error| format!("failed to configure audio output device: {error}"))?;
    let handle = builder
        .with_sample_rate(
            std::num::NonZeroU32::new(actual_rate).unwrap_or(std::num::NonZeroU32::MIN),
        )
        .open_stream()
        .map_err(|error| format!("failed to open audio output stream: {error}"))?;
    Ok((finalize_mixer_device_sink(handle), actual_rate))
}

#[cfg(target_os = "linux")]
fn select_verified_stream_config(
    device: &rodio::cpal::Device,
    desired_rate: u32,
) -> Result<(rodio::cpal::SupportedStreamConfig, &'static str), String> {
    use rodio::cpal::traits::DeviceTrait;

    if desired_rate > 0 {
        let configs: Vec<_> = device
            .supported_output_configs()
            .map_err(|error| format!("failed to query audio output configurations: {error}"))?
            .collect();

        if let Some(config) = configs
            .iter()
            .filter(|config| {
                config.min_sample_rate() <= desired_rate
                    && desired_rate <= config.max_sample_rate()
            })
            .max_by(|a, b| a.cmp_default_heuristics(b))
        {
            return Ok(((*config).with_sample_rate(desired_rate), "requested"));
        }

        if let Some(config) = configs.iter().max_by(|a, b| {
            a.max_sample_rate()
                .cmp(&b.max_sample_rate())
                .then_with(|| a.cmp_default_heuristics(b))
        }) {
            return Ok(((*config).with_max_sample_rate(), "highest supported"));
        }
    }

    device
        .default_output_config()
        .map(|config| (config, "device default"))
        .map_err(|error| format!("failed to query default audio output configuration: {error}"))
}

/// Returns `(stream_handle, actual_sample_rate)`.
fn open_stream_for_device_and_rate(
    device_name: Option<&str>,
    desired_rate: u32,
    require_named_device: bool,
) -> StreamOpenResult {
    use rodio::cpal::traits::HostTrait;
    #[cfg(not(target_os = "linux"))]
    use rodio::cpal::traits::DeviceTrait;

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
    let find_by_key = |key: &str| super::dev_io::resolve_output_device(key);

    let named_device = device_name.and_then(find_by_key);
    if require_named_device && device_name.is_some() && named_device.is_none() {
        return Err(format!(
            "selected audio output device '{}' is unavailable",
            device_name.unwrap_or_default()
        ));
    }

    let device = named_device
        .or_else(|| {
            #[cfg(target_os = "linux")]
            { find_by_key("pipewire").or_else(|| find_by_key("pulse")) }
            #[cfg(not(target_os = "linux"))]
            { None }
        })
        .or_else(|| host.default_output_device());

    if let Some(device) = device {
        #[cfg(target_os = "linux")]
        {
            // Probe exactly one chosen configuration on exactly one device.
            // Failed snd_pcm_open() calls are not guaranteed to clean up on
            // every ALSA plugin, so broad probe sweeps can poison the backend.
            let (config, choice) = select_verified_stream_config(&device, desired_rate)?;
            let (handle, actual_rate) = open_stream_with_verified_rate(&device, &config)?;
            crate::app_eprintln!(
                "[psysonic] audio stream opened at {actual_rate} Hz ({choice}, wanted {desired_rate} Hz)"
            );
            return Ok((handle, actual_rate));
        }

        #[cfg(not(target_os = "linux"))]
        if desired_rate > 0 {
            if let Ok(supported) = device.supported_output_configs() {
                let configs: Vec<_> = supported.collect();

                // 1. Exact rate match, using CPAL's normal format/channel preference.
                let exact = configs.iter()
                    .filter(|c| {
                        c.min_sample_rate() <= desired_rate
                            && desired_rate <= c.max_sample_rate()
                    })
                    .max_by(|a, b| a.cmp_default_heuristics(b));

                if let Some(cfg) = exact {
                    let config = (*cfg).with_sample_rate(desired_rate);
                    if let Ok((handle, actual_rate)) =
                        open_stream_with_verified_rate(&device, &config)
                    {
                        crate::app_eprintln!(
                            "[psysonic] audio stream opened at {} Hz (wanted {} Hz)",
                            actual_rate,
                            desired_rate
                        );
                        return Ok((handle, actual_rate));
                    }
                }

                // 2. No exact match — use the highest supported rate.
                let best = configs.iter()
                    .max_by(|a, b| {
                        a.max_sample_rate()
                            .cmp(&b.max_sample_rate())
                            .then_with(|| a.cmp_default_heuristics(b))
                    });

                if let Some(cfg) = best {
                    let config = (*cfg).with_max_sample_rate();
                    if let Ok((handle, actual_rate)) =
                        open_stream_with_verified_rate(&device, &config)
                    {
                        crate::app_eprintln!(
                            "[psysonic] audio stream opened at {} Hz (highest, wanted {})",
                            actual_rate, desired_rate
                        );
                        return Ok((handle, actual_rate));
                    }
                }
            }
        }

        // 3. Device default.
        #[cfg(not(target_os = "linux"))]
        if let Ok(config) = device.default_output_config() {
            if let Ok((handle, rate)) = open_stream_with_verified_rate(&device, &config) {
                crate::app_eprintln!(
                    "[psysonic] audio stream opened at {} Hz (device default)",
                    rate
                );
                return Ok((handle, rate));
            }
        }
    }

    // Linux deliberately avoids probing every enumerated device. Apart from
    // leaking resources on broken ALSA plugins, that can leave all later opens
    // failing with EBUSY until the process exits.
    #[cfg(target_os = "linux")]
    return Err("no audio output device is available".to_string());

    #[cfg(not(target_os = "linux"))]
    {
        crate::app_eprintln!("[psysonic] audio stream falling back to system default");
        let handle = rodio::DeviceSinkBuilder::open_default_sink()
            .map_err(|error| format!("cannot open any audio output device: {error}"))?;
        let rate = host
            .default_output_device()
            .and_then(|device| device.default_output_config().ok())
            .map(|config| config.sample_rate())
            .unwrap_or(44_100);
        Ok((finalize_mixer_device_sink(handle), rate))
    }
}

fn probe_device_default_rate() -> u32 {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};

    rodio::cpal::default_host()
        .default_output_device()
        .and_then(|d| d.default_output_config().ok())
        .map(|c| c.sample_rate())
        .unwrap_or(44_100)
}

/// Open the output stream (blocking). Updates requested and negotiated rates.
pub(crate) fn open_output_stream_blocking_locked(
    engine: &AudioEngine,
    desired_rate: u32,
    is_hi_res: bool,
    device_name: Option<String>,
    require_named_device: bool,
) -> Result<(), String> {
    wait_for_stream_attachments_locked(engine);
    let rate = if desired_rate > 0 {
        desired_rate
    } else {
        engine.device_default_rate
    };
    // The stream thread owns one Arc and the engine slot owns the other. Drop
    // the slot before the thread drops its copy so exclusive ALSA devices are
    // actually released before the verification/open sequence starts.
    drop(engine.stream_handle.lock().unwrap().take());
    engine
        .stream_sample_rate
        .store(0, std::sync::atomic::Ordering::Relaxed);
    let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(0);
    engine
        .stream_thread_tx
        .try_send(StreamThreadMsg::Open {
            desired_rate: rate,
            is_hi_res,
            device_name,
            require_named_device,
            reply: reply_tx,
        })
        .map_err(|error| match error {
            std::sync::mpsc::TrySendError::Full(_) => {
                "audio stream thread request queue is full".to_string()
            }
            std::sync::mpsc::TrySendError::Disconnected(_) => {
                "audio stream thread is unavailable".to_string()
            }
        })?;
    let (handle, actual_rate) = match reply_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => result?,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            return Err("audio stream open timed out".to_string());
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            return Err("audio stream thread stopped before opening the device".to_string());
        }
    };
    engine
        .stream_sample_rate
        .store(actual_rate, std::sync::atomic::Ordering::Relaxed);
    engine
        .stream_requested_rate
        .store(rate, std::sync::atomic::Ordering::Relaxed);
    *engine.stream_handle.lock().unwrap() = Some(handle);
    Ok(())
}

pub(crate) fn open_output_stream_blocking(
    engine: &AudioEngine,
    desired_rate: u32,
    is_hi_res: bool,
    device_name: Option<String>,
) -> Result<(), String> {
    let _open_guard = engine.stream_open_lock.lock().unwrap();
    open_output_stream_blocking_locked(engine, desired_rate, is_hi_res, device_name, false)
}

fn ensure_output_stream_open_locked(
    engine: &AudioEngine,
) -> Result<Arc<rodio::MixerDeviceSink>, String> {
    if let Some(handle) = engine.stream_handle.lock().unwrap().clone() {
        return Ok(handle);
    }
    let rate = engine
        .stream_requested_rate
        .load(std::sync::atomic::Ordering::Relaxed);
    let open_rate = if rate > 0 {
        rate
    } else {
        engine.device_default_rate
    };
    let device = engine.selected_device.lock().unwrap().clone();
    open_output_stream_blocking_locked(engine, open_rate, false, device, false)?;
    engine
        .stream_handle
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "audio output stream opened without a handle".to_string())
}

pub(crate) struct StreamAttachGuard {
    pending: Arc<(Mutex<u32>, Condvar)>,
}

impl Drop for StreamAttachGuard {
    fn drop(&mut self) {
        let (pending, ready) = &*self.pending;
        let mut count = pending.lock().unwrap();
        *count = count.saturating_sub(1);
        ready.notify_all();
    }
}

pub(crate) fn wait_for_stream_attachments_locked(engine: &AudioEngine) {
    let (pending, ready) = &*engine.stream_attach_pending;
    let mut count = pending.lock().unwrap();
    while *count > 0 {
        count = ready.wait(count).unwrap();
    }
}

pub(crate) fn wait_for_stream_attachments_timeout_locked(
    engine: &AudioEngine,
    timeout: Duration,
) -> bool {
    let (pending, ready) = &*engine.stream_attach_pending;
    let count = pending.lock().unwrap();
    let (count, _) = ready
        .wait_timeout_while(count, timeout, |count| *count > 0)
        .unwrap();
    *count == 0
}

pub(crate) fn stream_attachment_is_pending(engine: &AudioEngine) -> bool {
    *engine.stream_attach_pending.0.lock().unwrap() > 0
}

/// Connect a player and mark the stream as needed until the caller registers
/// that player in `AudioCurrent`, `preview_sink`, or `fading_out_sink`.
pub(crate) fn connect_new_player(
    engine: &AudioEngine,
) -> Result<(Arc<Player>, StreamAttachGuard), String> {
    let _open_guard = engine.stream_open_lock.lock().unwrap();
    let stream = ensure_output_stream_open_locked(engine)?;
    *engine.stream_attach_pending.0.lock().unwrap() += 1;
    let attach_guard = StreamAttachGuard {
        pending: engine.stream_attach_pending.clone(),
    };
    let player = Arc::new(Player::connect_new(stream.mixer()));
    drop(stream);
    Ok((player, attach_guard))
}

pub(crate) fn request_stream_release_after_attachments_locked(
    engine: &AudioEngine,
) -> Result<(), String> {
    drop(engine.stream_handle.lock().unwrap().take());
    engine
        .stream_sample_rate
        .store(0, std::sync::atomic::Ordering::Relaxed);
    let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel(0);
    engine
        .stream_thread_tx
        .try_send(StreamThreadMsg::Release { reply: reply_tx })
        .map_err(|error| match error {
            std::sync::mpsc::TrySendError::Full(_) => {
                "audio stream thread request queue is full".to_string()
            }
            std::sync::mpsc::TrySendError::Disconnected(_) => {
                "audio stream thread is unavailable".to_string()
            }
        })?;
    reply_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "audio stream release timed out".to_string())?;
    Ok(())
}

pub(crate) fn request_stream_release_locked(engine: &AudioEngine) -> Result<(), String> {
    wait_for_stream_attachments_locked(engine);
    request_stream_release_after_attachments_locked(engine)
}

pub fn create_engine() -> (AudioEngine, std::thread::JoinHandle<()>) {
    // macOS: request a smaller CoreAudio buffer to reduce output latency.
    #[cfg(target_os = "macos")]
    {
        if std::env::var("COREAUDIO_BUFFER_SIZE").is_err() {
            std::env::set_var("COREAUDIO_BUFFER_SIZE", "512");
        }
    }

    // Channel: main thread ←→ audio-stream thread (lazy open + idle release).
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<()>(0);
    let (stream_thread_tx, stream_thread_rx) =
        std::sync::mpsc::sync_channel::<StreamThreadMsg>(4);

    let device_default_rate = probe_device_default_rate();

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
            let mut _stream: Option<Arc<rodio::MixerDeviceSink>> = None;
            ready_tx.send(()).ok();

            while let Ok(msg) = stream_thread_rx.recv() {
                match msg {
                    StreamThreadMsg::Release { reply } => {
                        _stream = None;
                        let _ = reply.send(());
                    }
                    StreamThreadMsg::Open {
                        desired_rate,
                        is_hi_res,
                        device_name,
                        require_named_device,
                        reply,
                    } => {
                        // Escalate to Max for Hi-Res reopens (large PipeWire quanta need
                        // real-time scheduling to avoid underruns). No escalation for
                        // standard mode — the thread blocks on recv() between reopens so
                        // elevated priority would only waste scheduler budget.
                        if is_hi_res {
                            thread_priority::set_current_thread_priority(
                                thread_priority::ThreadPriority::Max,
                            )
                            .ok();
                        }

                        _stream = None;

                        // Scale the PipeWire quantum with the sample rate so wall-clock
                        // latency stays roughly constant (≈93 ms) at all rates.
                        #[cfg(target_os = "linux")]
                        if desired_rate > 0 {
                            let frames: u32 = if desired_rate > 48_000 { 8192 } else { 4096 };
                            std::env::set_var("PIPEWIRE_LATENCY", format!("{frames}/{desired_rate}"));
                            let latency_ms =
                                (frames as f64 / desired_rate as f64 * 1000.0).round() as u64;
                            std::env::set_var("PULSE_LATENCY_MSEC", latency_ms.to_string());
                        }

                        match open_stream_for_device_and_rate(
                            device_name.as_deref(),
                            desired_rate,
                            require_named_device,
                        ) {
                            Ok((new_stream, actual_rate)) => {
                                let new_handle = new_stream.clone();
                                // If the caller already timed out, do not retain
                                // an untracked stream that can hold an exclusive
                                // device while the engine slot remains empty.
                                if reply.send(Ok((new_handle, actual_rate))).is_ok() {
                                    _stream = Some(new_stream);
                                }
                            }
                            Err(error) => {
                                crate::app_eprintln!(
                                    "[psysonic] audio stream open failed: {error}"
                                );
                                let _ = reply.send(Err(error));
                            }
                        }
                    }
                }
            }
        })
        .expect("spawn audio stream thread");

    ready_rx.recv().expect("audio stream thread ready");

    let engine = AudioEngine {
        stream_handle: Arc::new(std::sync::Mutex::new(None)),
        stream_open_lock: Arc::new(Mutex::new(())),
        stream_attach_pending: Arc::new((Mutex::new(0), Condvar::new())),
        playback_commit_lock: Arc::new(Mutex::new(())),
        stream_sample_rate: Arc::new(AtomicU32::new(0)),
        stream_requested_rate: Arc::new(AtomicU32::new(0)),
        device_default_rate,
        stream_thread_tx,
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
        preload_epoch: Arc::new(AtomicU64::new(0)),
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
        playback_rate: crate::playback_rate::PlaybackRateAtomics::new(),
        preloaded: Arc::new(Mutex::new(None)),
        stream_completed_cache: Arc::new(Mutex::new(None)),
        stream_completed_spill: Arc::new(Mutex::new(None)),
        current_is_seekable: Arc::new(AtomicBool::new(true)),
        stream_playback_armed: Arc::new(AtomicBool::new(true)),
        crossfade_enabled: Arc::new(AtomicBool::new(false)),
        crossfade_secs: Arc::new(AtomicU32::new(3.0f32.to_bits())),
        autodj_suppress_autocrossfade: Arc::new(AtomicBool::new(false)),
        interrupt_outgoing_duck_active: Arc::new(AtomicBool::new(false)),
        fading_out_sink: Arc::new(Mutex::new(None)),
        gapless_enabled: Arc::new(AtomicBool::new(false)),
        normalization_engine: Arc::new(AtomicU32::new(0)),
        normalization_target_lufs: Arc::new(AtomicU32::new((-16.0f32).to_bits())),
        loudness_pre_analysis_attenuation_db: Arc::new(AtomicU32::new((-4.5f32).to_bits())),
        chained_info: Arc::new(Mutex::new(None)),
        current_source_done: Arc::new(Mutex::new(None)),
        samples_played: Arc::new(AtomicU64::new(0)),
        current_sample_rate: Arc::new(AtomicU32::new(0)),
        current_channels: Arc::new(AtomicU32::new(2)),
        gapless_switch_at: Arc::new(AtomicU64::new(0)),
        radio_state: Mutex::new(None),
        current_playback_url: Arc::new(Mutex::new(None)),
        current_analysis_track_id: Arc::new(Mutex::new(None)),
        current_playback_server_id: Arc::new(Mutex::new(None)),
        playback_analysis_seed_hold: Arc::new(Mutex::new(None)),
        preview_sink: Arc::new(Mutex::new(None)),
        preview_gen: Arc::new(AtomicU64::new(0)),
        preview_main_resume: Arc::new(AtomicBool::new(false)),
        preview_song_id: Arc::new(Mutex::new(None)),
    };

    (engine, thread)
}

pub(crate) fn stream_rate_needs_switch(target_rate: u32, current_requested_rate: u32) -> bool {
    target_rate > 0 && target_rate != current_requested_rate
}

#[cfg(test)]
mod stream_rate_tests {
    use super::stream_rate_needs_switch;

    #[test]
    fn negotiated_rate_difference_does_not_reopen_same_request() {
        // ALSA may negotiate 48 kHz for a 44.1 kHz request. Reopen decisions
        // compare the next target with the prior request, not with that 48 kHz
        // actual rate, so the same mode stays on the existing stream.
        assert!(!stream_rate_needs_switch(44_100, 44_100));
        assert!(stream_rate_needs_switch(96_000, 44_100));
        assert!(!stream_rate_needs_switch(0, 44_100));
    }
}

/// `analysis_enqueue_seed_from_url` should bail while this track's HTTP playback
/// buffer is still filling — playback will seed on completion with the same bytes.
pub fn playback_analysis_backfill_should_defer(engine: &AudioEngine, track_id: &str) -> bool {
    let tid = track_id.trim();
    if tid.is_empty() {
        return false;
    }
    let Ok(g) = engine.playback_analysis_seed_hold.lock() else {
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
    let _commit_guard = engine.playback_commit_lock.lock().unwrap();
    engine.generation.fetch_add(1, Ordering::SeqCst);
    *engine.chained_info.lock().unwrap() = None;
    *engine.current_source_done.lock().unwrap() = None;
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

pub(crate) fn apply_playback_request_headers(
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_id: Option<&str>,
    url: &str,
    req: reqwest::RequestBuilder,
) -> reqwest::RequestBuilder {
    psysonic_core::server_http::apply_optional_registry_headers(registry, server_id, url, req)
}

/// Custom HTTP headers for reverse-proxy gates — cloned into background download tasks.
#[derive(Clone, Default)]
pub(crate) struct PlaybackHttpHeaders {
    registry: Option<Arc<psysonic_core::server_http::ServerHttpRegistry>>,
    server_id: Option<String>,
}

impl PlaybackHttpHeaders {
    pub fn from_app(app: &tauri::AppHandle, server_id: Option<&str>) -> Self {
        Self {
            registry: app
                .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
                .map(|s| Arc::clone(&*s)),
            server_id: server_id.filter(|s| !s.is_empty()).map(str::to_string),
        }
    }

    pub fn apply(&self, url: &str, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        apply_playback_request_headers(
            self.registry.as_deref(),
            self.server_id.as_deref(),
            url,
            req,
        )
    }
}

pub(crate) fn scoped_http_get(
    state: &AudioEngine,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_id: Option<&str>,
    url: &str,
) -> reqwest::RequestBuilder {
    apply_playback_request_headers(
        registry,
        server_id,
        url,
        audio_http_client(state).get(url),
    )
}

/// Resolve registry + server id for playback/preload HTTP GETs.
pub(crate) fn playback_scoped_get(
    state: &AudioEngine,
    app: &tauri::AppHandle,
    url: &str,
    server_id: Option<&str>,
) -> reqwest::RequestBuilder {
    let registry = app
        .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));
    let sid = server_id
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| state.current_playback_server_id.lock().unwrap().clone());
    scoped_http_get(
        state,
        registry.as_deref(),
        sid.as_deref(),
        url,
    )
}
