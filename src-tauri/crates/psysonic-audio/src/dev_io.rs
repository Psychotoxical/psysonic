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

/// cpal/rodio aliases for "follow the OS default" — not a stable per-device key.
pub(crate) fn is_generic_default_output_alias(name: &str) -> bool {
    matches!(
        name,
        "default"
            | "Default Audio Device"
            | "PipeWire Sound Server"
            | "Default ALSA Output (currently PipeWire Media Server)"
    )
}

fn raw_cpal_default_output_device_name() -> Option<String> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    with_suppressed_alsa_stderr(|| {
        let host = rodio::cpal::default_host();
        host.default_output_device()
            .and_then(|d| d.description().ok().map(|desc| desc.name().to_string()))
    })
}

fn pick_listed_device_name(candidate: &str, list: &[String]) -> Option<String> {
    list.iter().find(|d| d.as_str() == candidate).cloned()
}

/// Build the cpal-style `"CARD, PCM name"` label PipeWire exposes for ALSA sinks.
pub(crate) fn cpal_name_from_pipewire_alsa(card: &str, alsa_name: &str) -> String {
    format!("{card}, {alsa_name}")
}

/// Parse `wpctl status` and return the id of the default sink (line marked with `*`).
pub(crate) fn parse_wpctl_default_sink_id(status: &str) -> Option<u32> {
    let mut in_sinks = false;
    for line in status.lines() {
        if line.contains("Sinks:") {
            in_sinks = true;
            continue;
        }
        if !in_sinks {
            continue;
        }
        if line.contains("Sources:") {
            break;
        }
        if !line.contains('*') {
            continue;
        }
        let after_star = line.split('*').nth(1)?.trim();
        let id_str = after_star.split('.').next()?.trim();
        return id_str.parse().ok();
    }
    None
}

/// Read `api.alsa.card.name` + `alsa.name` from `wpctl inspect` output.
pub(crate) fn parse_wpctl_inspect_alsa_names(inspect: &str) -> Option<(String, String)> {
    let mut card: Option<String> = None;
    let mut pcm: Option<String> = None;
    for line in inspect.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("api.alsa.card.name = ") {
            card = Some(v.trim_matches('"').to_string());
        } else if card.is_none() {
            if let Some(v) = line.strip_prefix("alsa.card_name = ") {
                card = Some(v.trim_matches('"').to_string());
            }
        }
        if let Some(v) = line.strip_prefix("alsa.name = ") {
            pcm = Some(v.trim_matches('"').to_string());
        }
    }
    match (card, pcm) {
        (Some(c), Some(n)) if !c.is_empty() && !n.is_empty() => Some((c, n)),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn linux_resolve_default_via_pipewire(list: &[String]) -> Option<String> {
    use std::process::Command;
    let status = Command::new("wpctl")
        .args(["status"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())?;
    let sink_id = parse_wpctl_default_sink_id(&status)?;
    let inspect = Command::new("wpctl")
        .args(["inspect", &sink_id.to_string()])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())?;
    let (card, pcm) = parse_wpctl_inspect_alsa_names(&inspect)?;
    let candidate = cpal_name_from_pipewire_alsa(&card, &pcm);
    pick_listed_device_name(&candidate, list).or(Some(candidate))
}

/// Resolve the active default output to a device key that matches `audio_list_devices`
/// when possible. On Linux/PipeWire, cpal's default is often the generic alias
/// `"Default Audio Device"`, which never changes when the user switches sinks.
pub fn effective_default_output_device_name() -> Option<String> {
    let list = enumerate_output_device_names();
    let raw = raw_cpal_default_output_device_name();
    if let Some(ref name) = raw {
        if !is_generic_default_output_alias(name) {
            return pick_listed_device_name(name, &list).or_else(|| Some(name.clone()));
        }
    }
    #[cfg(target_os = "linux")]
    if let Some(resolved) = linux_resolve_default_via_pipewire(&list) {
        return Some(resolved);
    }
    raw
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

    // ── generic default alias / PipeWire wpctl parsing ────────────────────────

    #[test]
    fn generic_default_alias_detects_cpal_pipewire_placeholders() {
        assert!(is_generic_default_output_alias("Default Audio Device"));
        assert!(is_generic_default_output_alias("PipeWire Sound Server"));
        assert!(!is_generic_default_output_alias("HDA NVidia, Gigabyte M32U"));
    }

    #[test]
    fn parse_wpctl_default_sink_id_finds_starred_sink() {
        let status = r#"
Audio
 ├─ Devices:
 ├─ Sinks:
 │      56. HDMI out
 │  *   58. Analog out
 ├─ Sources:
"#;
        assert_eq!(parse_wpctl_default_sink_id(status), Some(58));
    }

    #[test]
    fn parse_wpctl_inspect_alsa_names_reads_card_and_pcm() {
        let inspect = r#"
    api.alsa.card.name = "HD-Audio Generic"
    alsa.name = "ALC897 Analog"
"#;
        assert_eq!(
            parse_wpctl_inspect_alsa_names(inspect),
            Some(("HD-Audio Generic".into(), "ALC897 Analog".into()))
        );
        assert_eq!(
            cpal_name_from_pipewire_alsa("HD-Audio Generic", "ALC897 Analog"),
            "HD-Audio Generic, ALC897 Analog"
        );
    }

    #[test]
    fn pick_listed_device_name_prefers_enumerated_entry() {
        let list = vec![
            "Default Audio Device".to_string(),
            "HDA NVidia, Gigabyte M32U".to_string(),
        ];
        assert_eq!(
            pick_listed_device_name("HDA NVidia, Gigabyte M32U", &list),
            Some("HDA NVidia, Gigabyte M32U".to_string())
        );
    }
}
