use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use rodio::Player;

use super::{AudioEngine, StreamOpenResult, StreamThreadMsg};

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
                config.min_sample_rate() <= desired_rate && desired_rate <= config.max_sample_rate()
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
pub(super) fn open_stream_for_device_and_rate(
    device_name: Option<&str>,
    desired_rate: u32,
    require_named_device: bool,
) -> StreamOpenResult {
    #[cfg(not(target_os = "linux"))]
    use rodio::cpal::traits::DeviceTrait;
    use rodio::cpal::traits::HostTrait;

    #[cfg(unix)]
    let _guard = unsafe {
        struct StderrGuard(i32);
        impl Drop for StderrGuard {
            fn drop(&mut self) {
                unsafe {
                    libc::dup2(self.0, 2);
                    libc::close(self.0);
                }
            }
        }
        let saved = libc::dup(2);
        let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY);
        libc::dup2(devnull, 2);
        libc::close(devnull);
        StderrGuard(saved)
    };

    let host = rodio::cpal::default_host();
    let find_by_key = |key: &str| crate::dev_io::resolve_output_device(key);
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
            {
                find_by_key("pipewire").or_else(|| find_by_key("pulse"))
            }
            #[cfg(not(target_os = "linux"))]
            {
                None
            }
        })
        .or_else(|| host.default_output_device());

    if let Some(device) = device {
        #[cfg(target_os = "linux")]
        {
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
                let exact = configs
                    .iter()
                    .filter(|c| {
                        c.min_sample_rate() <= desired_rate && desired_rate <= c.max_sample_rate()
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
                let best = configs.iter().max_by(|a, b| {
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
                            actual_rate,
                            desired_rate
                        );
                        return Ok((handle, actual_rate));
                    }
                }
            }
        }

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

pub(super) fn probe_device_default_rate() -> u32 {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};

    rodio::cpal::default_host()
        .default_output_device()
        .and_then(|d| d.default_output_config().ok())
        .map(|c| c.sample_rate())
        .unwrap_or(44_100)
}

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
