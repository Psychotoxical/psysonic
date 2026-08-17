use super::*;

#[test]
fn generic_default_alias_detects_cpal_pipewire_placeholders() {
    assert!(is_generic_default_output_alias("Default Audio Device"));
    assert!(is_generic_default_output_alias("PipeWire Sound Server"));
    assert!(!is_generic_default_output_alias(
        "HDA NVidia, Gigabyte M32U"
    ));
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
    assert_eq!(parse_wpctl_status_psysonic_stream_ids(status), vec![84]);
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
    let listing =
        "56\talsa_output.pci-hdmi\taudio/sink\t\n58\talsa_output.pci-analog\taudio/sink\t*";
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
fn output_device_keys_equivalent_links_hdmi_comma_and_alsa_id() {
    assert!(output_device_keys_equivalent(
        "HDA NVidia, Gigabyte M32U",
        "hdmi:CARD=NVidia,DEV=3",
        &[],
    ));
}

#[test]
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
