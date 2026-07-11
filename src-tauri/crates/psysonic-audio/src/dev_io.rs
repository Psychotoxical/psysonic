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
    list.iter()
        .find(|d| d.as_str() == candidate || output_devices_logically_same(d, candidate))
        .cloned()
}

fn equivalent_list_entries(name: &str, list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = list
        .iter()
        .filter(|d| d.as_str() == name || output_devices_logically_same(d, name))
        .cloned()
        .collect();
    if let Some(picked) = pick_listed_device_name(name, list) {
        if !out.iter().any(|d| d == &picked) {
            out.push(picked);
        }
    }
    if out.is_empty() && !name.is_empty() {
        out.push(name.to_string());
    }
    out
}

/// True when two device keys refer to the same sink (exact, ALSA logical, or via list canon).
pub(crate) fn output_device_keys_equivalent(a: &str, b: &str, list: &[String]) -> bool {
    if a == b || output_devices_logically_same(a, b) {
        return true;
    }
    if comma_and_alsa_device_equivalent(a, b) {
        return true;
    }
    let ea = equivalent_list_entries(a, list);
    let eb = equivalent_list_entries(b, list);
    ea.iter()
        .any(|x| eb.iter().any(|y| x == y || output_devices_logically_same(x, y)))
}

/// Match wpctl/cpal `"CARD, PCM"` labels to ALSA `iface:CARD=…` picker ids.
fn comma_and_alsa_device_equivalent(a: &str, b: &str) -> bool {
    let (comma, alsa) = if linux_alsa_sink_fingerprint(a).is_some() {
        (b, a)
    } else if linux_alsa_sink_fingerprint(b).is_some() {
        (a, b)
    } else {
        return false;
    };
    if comma.contains(':') {
        return false;
    }
    let mut parts = comma.splitn(2, ',');
    let Some(comma_card) = parts.next() else {
        return false;
    };
    let comma_card = comma_card.trim();
    let comma_pcm = parts.next().map(|s| s.trim()).unwrap_or("");
    if comma_pcm.is_empty() {
        return false;
    }
    let Some((_, alsa_card, _)) = linux_alsa_sink_fingerprint(alsa) else {
        return false;
    };
    let pcm = comma_pcm.to_ascii_lowercase();
    let alsa_lower = alsa.to_ascii_lowercase();
    let cc = comma_card.to_ascii_lowercase();
    let ac = alsa_card.to_ascii_lowercase();
    let card_ok = cc.contains(&ac) || ac.contains(&cc);
    if !card_ok {
        return false;
    }
    if alsa_lower.starts_with("hdmi:") {
        return !pcm.contains("analog");
    }
    if pcm.contains("analog") {
        return alsa_lower.starts_with("hw:") || alsa_lower.starts_with("plughw:");
    }
    alsa_lower.contains(&pcm) || pcm.contains(&alsa_lower)
}

/// Build the cpal-style `"CARD, PCM name"` label PipeWire exposes for ALSA sinks.
pub(crate) fn cpal_name_from_pipewire_alsa(card: &str, alsa_name: &str) -> String {
    format!("{card}, {alsa_name}")
}

/// Read `node.driver-id` from `wpctl inspect` output (PipeWire stream → sink link).
pub(crate) fn parse_wpctl_inspect_driver_id(inspect: &str) -> Option<u32> {
    for line in inspect.lines() {
        let line = line.trim().trim_start_matches('*').trim();
        if let Some(v) = line.strip_prefix("node.driver-id = ") {
            return v.trim_matches('"').parse().ok();
        }
    }
    None
}

/// Collect PipeWire ALSA `[psysonic]` stream node ids that have at least one
/// active playback link in `wpctl status` (ignores stale / idle nodes).
pub(crate) fn parse_wpctl_status_psysonic_stream_ids(status: &str) -> Vec<u32> {
    let mut in_audio_streams = false;
    let mut ids = Vec::new();
    let mut current_id: Option<u32> = None;
    for line in status.lines() {
        if line.contains("Streams:") && line.contains('─') {
            in_audio_streams = true;
            continue;
        }
        if !in_audio_streams {
            continue;
        }
        let trimmed = line.trim();
        if trimmed.starts_with("Video") || trimmed.starts_with("Settings") {
            break;
        }
        if trimmed.contains("PipeWire ALSA [psysonic]") && !trimmed.contains("(deleted)") {
            current_id = trimmed
                .split('.')
                .next()
                .and_then(|s| s.trim().parse().ok());
            continue;
        }
        if trimmed.contains('>')
            && (trimmed.contains("[active]") || trimmed.contains("[init]"))
        {
            if let Some(id) = current_id {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        } else if trimmed.contains('.') {
            let prefix = trimmed.split('.').next().unwrap_or("").trim();
            if prefix.chars().all(|c| c.is_ascii_digit()) && !trimmed.contains('>') {
                current_id = None;
            }
        }
    }
    ids
}

#[cfg(target_os = "linux")]
fn linux_wpctl_inspect_driver_id(node_id: u32) -> Option<u32> {
    use std::process::Command;
    let inspect = Command::new("wpctl")
        .args(["inspect", &node_id.to_string()])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())?;
    parse_wpctl_inspect_driver_id(&inspect)
}

/// True when a live psysonic PipeWire stream is already routed to the default sink.
/// Hyprpanel / WirePlumber often migrate streams on `set-default` before our poll
/// sees the change — reopening CPAL in that case only causes an audible glitch.
#[cfg(target_os = "linux")]
pub(crate) fn linux_psysonic_stream_routes_to_default_sink() -> bool {
    use std::process::Command;
    let Some(default_id) = linux_wpctl_default_sink_id() else {
        return false;
    };
    let Some(status) = Command::new("wpctl")
        .args(["status"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    else {
        return false;
    };
    let stream_ids = parse_wpctl_status_psysonic_stream_ids(&status);
    stream_ids.iter().any(|&id| linux_wpctl_inspect_driver_id(id) == Some(default_id))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn linux_psysonic_stream_routes_to_default_sink() -> bool {
    false
}

/// Parse `wpctl list audio sinks` and return the id of the default sink (trailing `*`).
pub(crate) fn parse_wpctl_list_default_sink_id(listing: &str) -> Option<u32> {
    for line in listing.lines() {
        let line = line.trim_end();
        if !line.ends_with('*') {
            continue;
        }
        let id_str = line.split('\t').next()?.trim();
        return id_str.parse().ok();
    }
    None
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
fn linux_wpctl_default_sink_id() -> Option<u32> {
    use std::process::Command;
    let listing = Command::new("wpctl")
        .args(["list", "audio", "sinks"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    if let Some(ref text) = listing {
        if let Some(id) = parse_wpctl_list_default_sink_id(text) {
            return Some(id);
        }
    }
    let status = Command::new("wpctl")
        .args(["status"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())?;
    parse_wpctl_default_sink_id(&status)
}

/// Read `node.description` from `wpctl inspect` (Bluetooth and other non-ALSA sinks).
pub(crate) fn parse_wpctl_inspect_node_description(inspect: &str) -> Option<String> {
    for line in inspect.lines() {
        let line = line.trim().trim_start_matches('*').trim();
        if let Some(v) = line.strip_prefix("node.description = ") {
            let desc = v.trim_matches('"').to_string();
            if !desc.is_empty() {
                return Some(desc);
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn linux_resolve_default_via_pipewire(list: &[String]) -> Option<String> {
    use std::process::Command;
    let sink_id = linux_wpctl_default_sink_id()?;
    let inspect = Command::new("wpctl")
        .args(["inspect", &sink_id.to_string()])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())?;
    let candidate = if let Some((card, pcm)) = parse_wpctl_inspect_alsa_names(&inspect) {
        cpal_name_from_pipewire_alsa(&card, &pcm)
    } else {
        parse_wpctl_inspect_node_description(&inspect)?
    };
    pick_listed_device_name(&candidate, list).or(Some(candidate))
}

/// Resolve the active default output to a device key that matches `audio_list_devices`
/// when possible. On Linux/PipeWire, cpal's default is often a generic alias or a
/// stale card name that does not track WirePlumber default changes (Hyprpanel,
/// pavucontrol, `wpctl set-default`, etc.) — prefer `wpctl` when available.
pub fn effective_default_output_device_name() -> Option<String> {
    resolve_effective_default_output_device_name(true)
}

/// Same as [`effective_default_output_device_name`] but skips the full
/// `output_devices()` scan — for the device-watcher poll path (#996).
pub(crate) fn effective_default_output_device_name_for_poll() -> Option<String> {
    resolve_effective_default_output_device_name(false)
}

fn resolve_effective_default_output_device_name(enumerate_devices: bool) -> Option<String> {
    let list = if enumerate_devices {
        enumerate_output_device_names()
    } else {
        Vec::new()
    };
    #[cfg(target_os = "linux")]
    if let Some(resolved) = linux_resolve_default_via_pipewire(&list) {
        return Some(resolved);
    }
    #[cfg(target_os = "linux")]
    if !enumerate_devices {
        // wpctl unavailable — last-resort cpal (skip generic/stale placeholder names).
        if linux_wpctl_default_sink_id().is_none() {
            if let Some(raw) = raw_cpal_default_output_device_name() {
                if !is_generic_default_output_alias(&raw) {
                    return Some(raw);
                }
            }
        }
        return None;
    }
    let raw = raw_cpal_default_output_device_name();
    if let Some(ref name) = raw {
        if !is_generic_default_output_alias(name) {
            if enumerate_devices {
                return pick_listed_device_name(name, &list).or_else(|| Some(name.clone()));
            }
            return Some(name.clone());
        }
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
    fn parse_wpctl_status_psysonic_stream_ids_accepts_init_links_when_paused() {
        let status = r#"
Audio
 └─ Streams:
        84. PipeWire ALSA [psysonic]
             90. output_FL       > ALC897 Analog:playback_FL	[init]
"#;
        assert_eq!(parse_wpctl_status_psysonic_stream_ids(status), vec![84]);
    }

    #[test]
    fn parse_wpctl_status_psysonic_stream_ids_ignores_streams_without_links() {
        let status = r#"
Audio
 └─ Streams:
        84. PipeWire ALSA [psysonic]
        87. PipeWire ALSA [psysonic]
            106. output_FL       > HDMI:playback_FL	[active]
"#;
        assert_eq!(parse_wpctl_status_psysonic_stream_ids(status), vec![87]);
    }

    #[test]
    fn parse_wpctl_status_psysonic_stream_ids_finds_active_streams() {
        let status = r#"
Audio
 └─ Streams:
        84. PipeWire ALSA [psysonic]
             90. output_FL       > ALC897 Analog:playback_FL	[active]
       119. PipeWire ALSA [psysonic (deleted)]
Video
"#;
        assert_eq!(
            parse_wpctl_status_psysonic_stream_ids(status),
            vec![84]
        );
    }

    #[test]
    fn parse_wpctl_inspect_driver_id_reads_node_driver() {
        let inspect = r#"
  * node.driver-id = "58"
    node.name = "alsa_playback.psysonic"
"#;
        assert_eq!(parse_wpctl_inspect_driver_id(inspect), Some(58));
    }

    #[test]
    fn parse_wpctl_list_default_sink_id_finds_starred_sink() {
        let listing = "56\talsa_output.pci-hdmi\taudio/sink\t\n58\talsa_output.pci-analog\taudio/sink\t*";
        assert_eq!(parse_wpctl_list_default_sink_id(listing), Some(58));
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
    fn parse_wpctl_inspect_node_description_reads_bluetooth_sink() {
        let inspect = r#"
  * node.description = "BlueZ Audio Device"
    node.name = "bluez_output.xxx"
"#;
        assert_eq!(
            parse_wpctl_inspect_node_description(inspect),
            Some("BlueZ Audio Device".into())
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn output_device_keys_equivalent_links_hdmi_comma_and_alsa_id() {
        assert!(output_device_keys_equivalent(
            "HDA NVidia, Gigabyte M32U",
            "hdmi:CARD=NVidia,DEV=3",
            &[],
        ));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn output_device_keys_equivalent_distinguishes_analog_and_hdmi() {
        assert!(!output_device_keys_equivalent(
            "HD-Audio Generic, ALC897 Analog",
            "hdmi:CARD=HD-Audio Generic,DEV=3",
            &[],
        ));
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

    #[test]
    fn pick_listed_device_name_matches_linux_alsa_logical_alias() {
        let list = vec!["hdmi:CARD=NVidia,DEV=3".to_string()];
        assert_eq!(
            pick_listed_device_name("hw:CARD=NVidia,DEV=3", &list),
            None,
            "different ALSA ifaces are not logically the same"
        );
        assert_eq!(
            pick_listed_device_name("hdmi:CARD=NVidia,DEV=3", &list),
            Some("hdmi:CARD=NVidia,DEV=3".to_string())
        );
    }
}
