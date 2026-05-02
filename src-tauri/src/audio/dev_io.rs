//! Output device enumeration with suppressed ALSA stderr noise.
#[cfg(unix)]
use libc;
// `rodio::cpal` is referenced from the included body.

/// ALSA probes noisy plugins during device queries — suppress stderr on Unix.
#[cfg(unix)]
pub(crate) fn with_suppressed_alsa_stderr<R>(f: impl FnOnce() -> R) -> R {
    struct StderrGuard(i32);
    impl Drop for StderrGuard {
        fn drop(&mut self) {
            unsafe { libc::dup2(self.0, 2); libc::close(self.0); }
        }
    }
    let _guard = unsafe {
        let saved = libc::dup(2);
        let devnull = libc::open(b"/dev/null\0".as_ptr() as *const libc::c_char, libc::O_WRONLY);
        libc::dup2(devnull, 2);
        libc::close(devnull);
        StderrGuard(saved)
    };
    f()
}

#[cfg(not(unix))]
#[inline]
pub(crate) fn with_suppressed_alsa_stderr<R>(f: impl FnOnce() -> R) -> R {
    f()
}

pub(crate) fn enumerate_output_device_names() -> Vec<String> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    with_suppressed_alsa_stderr(|| {
        let host = rodio::cpal::default_host();
        host.output_devices()
            .map(|iter| iter.filter_map(|d| d.name().ok()).collect())
            .unwrap_or_default()
    })
}

/// Linux ALSA-style cpal names: same physical sink can appear with different suffixes;
/// busy devices are sometimes omitted from `output_devices()` while playback works.
#[cfg(target_os = "linux")]
pub(crate) fn linux_alsa_sink_fingerprint(name: &str) -> Option<(String, String, u32)> {
    const IFACES: &[&str] = &[
        "hdmi", "hw", "plughw", "sysdefault", "iec958", "front", "dmix", "surround40",
        "surround51", "surround71",
    ];
    let colon = name.find(':')?;
    let iface = name[..colon].to_ascii_lowercase();
    if !IFACES.iter().any(|&i| i == iface.as_str()) {
        return None;
    }
    let card = name.split("CARD=").nth(1)?.split(',').next()?.to_string();
    let dev = name
        .split("DEV=")
        .nth(1)
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Some((iface, card, dev))
}

#[cfg(not(target_os = "linux"))]
#[inline]
pub(crate) fn linux_alsa_sink_fingerprint(_name: &str) -> Option<(String, String, u32)> {
    None
}

pub(crate) fn output_devices_logically_same(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (
        linux_alsa_sink_fingerprint(a),
        linux_alsa_sink_fingerprint(b),
    ) {
        (Some(fa), Some(fb)) => fa == fb,
        _ => false,
    }
}

/// True if `pinned` is the same sink as some entry (exact or Linux ALSA logical match).
pub(crate) fn output_enumeration_includes_pinned(available: &[String], pinned: &str) -> bool {
    available
        .iter()
        .any(|d| output_devices_logically_same(d, pinned))
}
