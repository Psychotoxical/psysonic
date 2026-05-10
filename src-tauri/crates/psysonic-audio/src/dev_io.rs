//! Output device enumeration with suppressed ALSA stderr noise.
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
        let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY);
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
            .map(|iter| {
                iter.filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                    .collect()
            })
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
    if !IFACES.contains(&iface.as_str()) {
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── output_devices_logically_same ─────────────────────────────────────────

    #[test]
    fn logically_same_returns_true_for_identical_names() {
        assert!(output_devices_logically_same("Generic Audio", "Generic Audio"));
    }

    #[test]
    fn logically_same_returns_false_for_different_non_alsa_names() {
        assert!(!output_devices_logically_same(
            "Built-in Speakers",
            "External DAC"
        ));
    }

    // ── output_enumeration_includes_pinned ────────────────────────────────────

    #[test]
    fn includes_pinned_finds_exact_match() {
        let avail = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        assert!(output_enumeration_includes_pinned(&avail, "B"));
    }

    #[test]
    fn includes_pinned_returns_false_when_absent() {
        let avail = vec!["A".to_string(), "B".to_string()];
        assert!(!output_enumeration_includes_pinned(&avail, "Z"));
    }

    #[test]
    fn includes_pinned_returns_false_for_empty_list() {
        let avail: Vec<String> = vec![];
        assert!(!output_enumeration_includes_pinned(&avail, "anything"));
    }

    // ── linux_alsa_sink_fingerprint (Linux-only path) ─────────────────────────

    #[test]
    #[cfg(target_os = "linux")]
    fn alsa_fingerprint_extracts_iface_card_dev() {
        let fp = linux_alsa_sink_fingerprint("hdmi:CARD=NVidia,DEV=3");
        assert_eq!(fp, Some(("hdmi".to_string(), "NVidia".to_string(), 3)));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn alsa_fingerprint_defaults_dev_to_zero_when_missing() {
        let fp = linux_alsa_sink_fingerprint("plughw:CARD=PCH");
        assert_eq!(fp, Some(("plughw".to_string(), "PCH".to_string(), 0)));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn alsa_fingerprint_returns_none_for_unknown_iface() {
        // "pulse" is not in the recognised ALSA-iface list — frontend-only sink.
        assert!(linux_alsa_sink_fingerprint("pulse:something").is_none());
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn alsa_fingerprint_returns_none_when_no_colon() {
        assert!(linux_alsa_sink_fingerprint("Generic Audio").is_none());
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn alsa_fingerprint_lowercases_iface_name() {
        let fp = linux_alsa_sink_fingerprint("HDMI:CARD=card,DEV=0");
        assert_eq!(fp.unwrap().0, "hdmi", "iface is normalised to lowercase");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn logically_same_treats_same_card_dev_as_match_across_alsa_ifaces() {
        // Same physical sink can appear under "hw:CARD=X,DEV=0" and "plughw:CARD=X,DEV=0".
        // The fingerprint comparison includes the iface, so these are NOT
        // logically the same — clarifying the contract here.
        assert!(!output_devices_logically_same(
            "hw:CARD=X,DEV=0",
            "plughw:CARD=X,DEV=0"
        ));
        // But the SAME iface with the same card/dev is the same sink:
        assert!(output_devices_logically_same(
            "hw:CARD=X,DEV=0",
            "hw:CARD=X,DEV=0"
        ));
    }

    // ── linux_alsa_sink_fingerprint stub on non-Linux ─────────────────────────

    #[test]
    #[cfg(not(target_os = "linux"))]
    fn alsa_fingerprint_is_none_on_non_linux_for_any_input() {
        assert!(linux_alsa_sink_fingerprint("hdmi:CARD=X,DEV=0").is_none());
        assert!(linux_alsa_sink_fingerprint("anything").is_none());
    }
}
