//! Output device enumeration with suppressed ALSA stderr noise.
// `rodio::cpal` is referenced from the included body.

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
#[allow(unused_imports)]
pub(crate) use linux::{
    cpal_name_from_pipewire_alsa, is_generic_default_output_alias,
    linux_psysonic_stream_routes_to_default_sink, output_device_keys_equivalent,
    parse_wpctl_default_sink_id, parse_wpctl_inspect_alsa_names, parse_wpctl_inspect_driver_id,
    parse_wpctl_inspect_node_description, parse_wpctl_list_default_sink_id,
    parse_wpctl_status_psysonic_stream_ids,
};
#[cfg(target_os = "linux")]
use linux::{
    linux_resolve_default_via_pipewire, linux_wpctl_default_sink_id, pick_listed_device_name,
};

/// ALSA probes noisy plugins during device queries — suppress stderr on Unix.
#[cfg(unix)]
pub(crate) fn with_suppressed_alsa_stderr<R>(f: impl FnOnce() -> R) -> R {
    struct StderrGuard(i32);
    impl Drop for StderrGuard {
        fn drop(&mut self) {
            unsafe {
                libc::dup2(self.0, 2);
                libc::close(self.0);
            }
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
    enumerate_output_device_entries()
        .into_iter()
        .map(|e| e.key)
        .collect()
}

/// Stable key + human label for the settings dropdown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OutputDeviceEntry {
    pub key: String,
    pub label: String,
}

pub(crate) fn enumerate_output_device_entries() -> Vec<OutputDeviceEntry> {
    use rodio::cpal::traits::HostTrait;
    let mut out = with_suppressed_alsa_stderr(|| {
        let host = rodio::cpal::default_host();
        host.output_devices()
            .map(|iter| {
                iter.filter_map(|d| {
                    let key = output_device_stable_key(&d);
                    if key.is_empty() {
                        return None;
                    }
                    Some(OutputDeviceEntry {
                        label: output_device_display_label(&d),
                        key,
                    })
                })
                .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    dedupe_output_device_entries(&mut out);
    out
}

fn dedupe_output_device_entries(entries: &mut Vec<OutputDeviceEntry>) {
    let mut seen = std::collections::HashSet::new();
    entries.retain(|e| seen.insert(e.key.clone()));
}

/// Stable per-device key for Settings / EQ maps. Linux keeps ALSA-style description
/// names; Windows/macOS use cpal [`DeviceId`] so same-named endpoints stay distinct
/// and default-device changes are observable by the watcher.
pub(crate) fn output_device_stable_key(device: &impl rodio::cpal::traits::DeviceTrait) -> String {
    #[cfg(not(target_os = "linux"))]
    {
        if let Ok(id) = device.id() {
            return id.to_string();
        }
    }
    device
        .description()
        .ok()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|| device.id().map(|i| i.to_string()).unwrap_or_default())
}

/// Human-readable label for the settings dropdown (not the stored key).
pub(crate) fn output_device_display_label(
    device: &impl rodio::cpal::traits::DeviceTrait,
) -> String {
    match device.description() {
        Ok(desc) => format_output_device_label(&desc),
        Err(_) => output_device_stable_key(device),
    }
}

pub(crate) fn format_output_device_label(desc: &rodio::cpal::DeviceDescription) -> String {
    use rodio::cpal::{DeviceType, InterfaceType};
    let name = desc.name();
    let mut parts: Vec<String> = vec![name.to_string()];
    if let Some(mfr) = desc.manufacturer() {
        if mfr != name && !name.contains(mfr) {
            parts.push(mfr.to_string());
        }
    }
    if let Some(driver) = desc.driver() {
        if driver != name && !parts.iter().any(|p| p.contains(driver)) {
            parts.push(driver.to_string());
        }
    }
    if parts.len() == 1 {
        let iface = desc.interface_type();
        if iface != InterfaceType::Unknown && iface != InterfaceType::BuiltIn {
            parts.push(iface.to_string());
        } else {
            let dtype = desc.device_type();
            if dtype != DeviceType::Unknown && dtype != DeviceType::Speaker {
                parts.push(dtype.to_string());
            }
        }
    }
    parts.join(" · ")
}

/// Best-effort label when a legacy plain-name pin is kept off the current list.
pub(crate) fn legacy_output_device_display_label(key: &str) -> String {
    #[cfg(not(target_os = "linux"))]
    {
        use rodio::cpal::traits::HostTrait;
        if let Ok(id) = key.parse::<rodio::cpal::DeviceId>() {
            if let Some(device) = rodio::cpal::default_host().device_by_id(&id) {
                return output_device_display_label(&device);
            }
        }
    }
    key.to_string()
}

/// Upgrade a pre–DeviceId persisted pin to the current stable key when unambiguous.
pub(crate) fn resolve_legacy_pinned_key(
    pinned: &str,
    entries: &[OutputDeviceEntry],
) -> Option<String> {
    if entries.iter().any(|e| e.key == pinned) {
        return Some(pinned.to_string());
    }
    let logic_matches: Vec<_> = entries
        .iter()
        .filter(|e| output_devices_logically_same(&e.key, pinned))
        .collect();
    if logic_matches.len() == 1 {
        return Some(logic_matches[0].key.clone());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let label_matches: Vec<_> = entries
            .iter()
            .filter(|e| e.label == pinned || e.label.starts_with(&format!("{pinned} · ")))
            .collect();
        if label_matches.len() == 1 {
            return Some(label_matches[0].key.clone());
        }
    }
    None
}

/// Resolve a stored device key to a cpal device (DeviceId on Windows/macOS, name on Linux).
pub(crate) fn resolve_output_device(device_key: &str) -> Option<rodio::cpal::Device> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    use std::str::FromStr;
    let host = rodio::cpal::default_host();
    if let Ok(id) = rodio::cpal::DeviceId::from_str(device_key) {
        if let Some(device) = host.device_by_id(&id) {
            return Some(device);
        }
    }
    host.output_devices().ok()?.find(|d| {
        output_device_stable_key(d) == device_key
            || d.description()
                .ok()
                .map(|desc| desc.name().to_string())
                .as_deref()
                == Some(device_key)
    })
}

fn raw_cpal_default_output_device_key() -> Option<String> {
    use rodio::cpal::traits::HostTrait;
    with_suppressed_alsa_stderr(|| {
        rodio::cpal::default_host()
            .default_output_device()
            .map(|d| output_device_stable_key(&d))
    })
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

// The early `return` is what separates the two cfg branches below. On a
// non-Linux build the second branch is stripped, leaving a lone block that
// clippy then reads as a needless return — so the lint is an artefact of the
// expansion, not of the code as written.
#[allow(clippy::needless_return)]
fn resolve_effective_default_output_device_name(enumerate_devices: bool) -> Option<String> {
    // Windows/macOS: single cpal default query (pre-#1274). Full `output_devices()`
    // enumeration contends with WASAPI/CoreAudio and is only needed for Linux/PipeWire
    // default resolution + ALSA logical key matching.
    #[cfg(not(target_os = "linux"))]
    {
        let _ = enumerate_devices;
        return raw_cpal_default_output_device_key();
    }

    #[cfg(target_os = "linux")]
    {
        let list = if enumerate_devices {
            enumerate_output_device_names()
        } else {
            Vec::new()
        };
        if let Some(resolved) = linux_resolve_default_via_pipewire(&list) {
            return Some(resolved);
        }
        if !enumerate_devices {
            // wpctl unavailable — last-resort cpal (skip generic/stale placeholder names).
            if linux_wpctl_default_sink_id().is_none() {
                if let Some(raw) = raw_cpal_default_output_device_key() {
                    if !is_generic_default_output_alias(&raw) {
                        return Some(raw);
                    }
                }
            }
            return None;
        }
        let raw = raw_cpal_default_output_device_key();
        if let Some(ref name) = raw {
            if !is_generic_default_output_alias(name) {
                return pick_listed_device_name(name, &list).or_else(|| Some(name.clone()));
            }
        }
        raw
    }
}

/// Linux ALSA-style cpal names: same physical sink can appear with different suffixes;
/// busy devices are sometimes omitted from `output_devices()` while playback works.
#[cfg(target_os = "linux")]
pub(crate) fn linux_alsa_sink_fingerprint(name: &str) -> Option<(String, String, u32)> {
    const IFACES: &[&str] = &[
        "hdmi",
        "hw",
        "plughw",
        "sysdefault",
        "iec958",
        "front",
        "dmix",
        "surround40",
        "surround51",
        "surround71",
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
    #[cfg(not(target_os = "linux"))]
    {
        if let (Ok(ida), Ok(idb)) = (
            a.parse::<rodio::cpal::DeviceId>(),
            b.parse::<rodio::cpal::DeviceId>(),
        ) {
            return ida.1 == idb.1;
        }
        if legacy_description_key_matches_device_id(a, b)
            || legacy_description_key_matches_device_id(b, a)
        {
            return true;
        }
    }
    match (
        linux_alsa_sink_fingerprint(a),
        linux_alsa_sink_fingerprint(b),
    ) {
        (Some(fa), Some(fb)) => fa == fb,
        _ => false,
    }
}

/// Pre–DeviceId persisted pins (description names) vs cpal `DeviceId` enumeration keys.
#[cfg(not(target_os = "linux"))]
fn legacy_description_key_matches_device_id(legacy: &str, device_id_key: &str) -> bool {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    use std::str::FromStr;
    if legacy.parse::<rodio::cpal::DeviceId>().is_ok() {
        return false;
    }
    let Ok(id) = rodio::cpal::DeviceId::from_str(device_id_key) else {
        return legacy == device_id_key;
    };
    let Some(device) = rodio::cpal::default_host().device_by_id(&id) else {
        return false;
    };
    let Ok(desc) = device.description() else {
        return false;
    };
    if desc.name() == legacy {
        return true;
    }
    let label = output_device_display_label(&device);
    label == legacy || label.starts_with(&format!("{legacy} · "))
}

/// True if `pinned` is the same sink as some entry (exact or Linux ALSA logical match).
#[cfg(not(target_os = "linux"))]
pub(crate) fn output_enumeration_includes_pinned(available: &[String], pinned: &str) -> bool {
    available
        .iter()
        .any(|d| output_devices_logically_same(d, pinned))
}

#[cfg(test)]
mod device_identity_tests;

#[cfg(all(test, target_os = "linux"))]
mod pipewire_tests;
