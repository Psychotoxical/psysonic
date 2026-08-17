//! `AudioEngine` / `AudioCurrent`, stream thread, and HTTP client refresh.
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use rodio::Player;

use super::state::{ChainedInfo, CurrentSourceDone, PreloadedTrack, StreamCompletedSpill};

mod http;
mod output_stream;

pub use http::refresh_http_user_agent;
#[allow(unused_imports)]
pub(crate) use http::{
    apply_playback_request_headers, audio_http_client, playback_scoped_get, scoped_http_get,
    PlaybackHttpHeaders,
};
#[allow(unused_imports)]
pub(crate) use output_stream::{
    connect_new_player, open_output_stream_blocking, open_output_stream_blocking_locked,
    request_stream_release_after_attachments_locked, request_stream_release_locked,
    stream_attachment_is_pending, wait_for_stream_attachments_locked,
    wait_for_stream_attachments_timeout_locked, StreamAttachGuard,
};
use output_stream::{open_stream_for_device_and_rate, probe_device_default_rate};

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
    let (stream_thread_tx, stream_thread_rx) = std::sync::mpsc::sync_channel::<StreamThreadMsg>(4);

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
                            std::env::set_var(
                                "PIPEWIRE_LATENCY",
                                format!("{frames}/{desired_rate}"),
                            );
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

/// Channels the output device takes, or 0 if that cannot be determined.
///
/// Two sources, in order of authority:
///
/// 1. the open sink's own config — read from the sink rather than kept in a
///    second atomic, so it cannot drift from the device that is playing. The
///    lock is taken and released immediately: the stream-open transaction holds
///    `stream_open_lock` around this same handle, and holding it across source
///    construction would put a second waiter in that path;
/// 2. the device's default config, when no stream is open.
///
/// The fallback is not optional. Sources are built *before* the stream is opened
/// (`audio_play` builds, then calls `connect_new_player`), and the stream is
/// released on stop and when idle — so the first track after launch, after a
/// stop, and after an idle release would all see "no device" and skip the
/// multichannel downmix entirely, which is exactly the case issue #1408 reports.
///
/// The fallback is a prediction: rodio may open the device with a different
/// count than its default config advertises. Once a stream exists, its value
/// wins.
pub(crate) fn output_device_channels(engine: &AudioEngine) -> u16 {
    if let Ok(guard) = engine.stream_handle.lock() {
        if let Some(sink) = guard.as_ref() {
            return sink.config().channel_count().get();
        }
    } else {
        // A poisoned lock would otherwise silently mean "no downmix".
        crate::app_eprintln!(
            "[psysonic] stream handle lock poisoned; falling back to the device default for channels"
        );
    }
    probe_output_device_channels(engine)
}

/// Channel count from the selected device's default config, or 0 when no device
/// answers. Mirrors `probe_device_default_rate` for channels.
///
/// Runs on the per-track build path while no stream is open, and querying a
/// device opens the PCM — on ALSA that prints plugin chatter to stderr, which
/// lands in the app log. Suppressed the same way every other device query in
/// this crate is.
fn probe_output_device_channels(engine: &AudioEngine) -> u16 {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};

    let selected = engine
        .selected_device
        .lock()
        .ok()
        .and_then(|name| name.clone());
    crate::dev_io::with_suppressed_alsa_stderr(|| {
        let device = selected
            .and_then(|name| crate::dev_io::resolve_output_device(&name))
            .or_else(|| rodio::cpal::default_host().default_output_device());

        device
            .and_then(|device| device.default_output_config().ok())
            .map(|config| config.channels())
            .unwrap_or(0)
    })
}

pub(crate) fn stream_rate_needs_switch(target_rate: u32, current_requested_rate: u32) -> bool {
    target_rate > 0 && target_rate != current_requested_rate
}

#[cfg(test)]
mod stream_rate_tests;

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
    if let Some(sink) = cur.sink.take() {
        sink.stop();
    }
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
