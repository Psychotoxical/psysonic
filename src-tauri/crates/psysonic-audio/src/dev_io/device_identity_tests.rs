use super::*;

#[test]
fn logically_same_returns_true_for_identical_names() {
    assert!(output_devices_logically_same(
        "Generic Audio",
        "Generic Audio"
    ));
}

#[test]
fn logically_same_returns_false_for_different_non_alsa_names() {
    assert!(!output_devices_logically_same(
        "Built-in Speakers",
        "External DAC"
    ));
}

#[test]
#[cfg(not(target_os = "linux"))]
fn includes_pinned_finds_exact_match() {
    let avail = vec!["A".to_string(), "B".to_string(), "C".to_string()];
    assert!(output_enumeration_includes_pinned(&avail, "B"));
}

#[test]
#[cfg(not(target_os = "linux"))]
fn includes_pinned_returns_false_when_absent() {
    let avail = vec!["A".to_string(), "B".to_string()];
    assert!(!output_enumeration_includes_pinned(&avail, "Z"));
}

#[test]
#[cfg(not(target_os = "linux"))]
fn includes_pinned_returns_false_for_empty_list() {
    let avail: Vec<String> = vec![];
    assert!(!output_enumeration_includes_pinned(&avail, "anything"));
}

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
    assert!(!output_devices_logically_same(
        "hw:CARD=X,DEV=0",
        "plughw:CARD=X,DEV=0"
    ));
    assert!(output_devices_logically_same(
        "hw:CARD=X,DEV=0",
        "hw:CARD=X,DEV=0"
    ));
}

#[test]
#[cfg(not(target_os = "linux"))]
fn alsa_fingerprint_is_none_on_non_linux_for_any_input() {
    assert!(linux_alsa_sink_fingerprint("hdmi:CARD=X,DEV=0").is_none());
    assert!(linux_alsa_sink_fingerprint("anything").is_none());
}
