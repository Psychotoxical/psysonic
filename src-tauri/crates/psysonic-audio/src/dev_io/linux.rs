use std::process::Command;

use super::{linux_alsa_sink_fingerprint, output_devices_logically_same};

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

pub(super) fn pick_listed_device_name(candidate: &str, list: &[String]) -> Option<String> {
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
    ea.iter().any(|x| {
        eb.iter()
            .any(|y| x == y || output_devices_logically_same(x, y))
    })
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
        if trimmed.contains('>') && (trimmed.contains("[active]") || trimmed.contains("[init]")) {
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

fn linux_wpctl_inspect_driver_id(node_id: u32) -> Option<u32> {
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
pub(crate) fn linux_psysonic_stream_routes_to_default_sink() -> bool {
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
    stream_ids
        .iter()
        .any(|&id| linux_wpctl_inspect_driver_id(id) == Some(default_id))
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

pub(super) fn linux_wpctl_default_sink_id() -> Option<u32> {
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

pub(super) fn linux_resolve_default_via_pipewire(list: &[String]) -> Option<String> {
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
