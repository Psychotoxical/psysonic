//! Linux-only single-instance D-Bus IPC: detect a running primary Psysonic
//! and forward `--player ...` argv to it instead of starting a second app.

use std::sync::OnceLock;
use std::time::Duration;

use serde_json::Value;

use super::describe_cli_command;
use super::exchange::{
    cli_audio_device_response_path, cli_benchmark_response_path, cli_library_response_path,
    cli_search_response_path, cli_server_list_path, print_benchmark_cli_stdout,
    print_library_cli_stdout, print_search_cli_stdout, print_server_list_cli_stdout,
    read_benchmark_cli_response_blocking, read_library_cli_response_blocking,
    read_search_cli_response_blocking, read_server_list_cli_response_blocking,
};
use super::parse::{parse_cli_command, wants_cli_json_output, wants_quiet, CliCommand};
use super::presenters::print_audio_devices_human;

fn tauri_identifier() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let raw = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"));
        let v: serde_json::Value =
            serde_json::from_str(raw).expect("parse embedded tauri.conf.json");
        v["identifier"]
            .as_str()
            .expect("tauri.conf.json identifier")
            .to_string()
    })
    .as_str()
}

fn single_instance_dbus_id_for(identifier: &str, debug: bool) -> String {
    if debug {
        format!("{identifier}.Debug")
    } else {
        identifier.to_string()
    }
}

pub fn linux_single_instance_dbus_id() -> String {
    single_instance_dbus_id_for(tauri_identifier(), cfg!(debug_assertions))
}

fn single_instance_bus_name() -> String {
    format!("{}.SingleInstance", linux_single_instance_dbus_id())
}

fn single_instance_object_path(dbus_name: &str) -> String {
    let mut dbus_path = dbus_name.replace('.', "/").replace('-', "_");
    if !dbus_path.starts_with('/') {
        dbus_path = format!("/{dbus_path}");
    }
    dbus_path
}

fn linux_bus_name_has_owner(
    conn: &zbus::blocking::Connection,
    bus_name: &str,
) -> Result<bool, String> {
    let reply = conn
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "NameHasOwner",
            &(bus_name,),
        )
        .map_err(|e| format!("NameHasOwner: {e}"))?;
    reply
        .body()
        .deserialize::<bool>()
        .map_err(|e| format!("NameHasOwner reply: {e}"))
}

/// Whether the main Psysonic instance holds the single-instance D-Bus name (Linux only).
pub fn linux_is_primary_instance_running() -> Result<bool, String> {
    use zbus::blocking::Connection;
    let conn = Connection::session().map_err(|e| format!("D-Bus session: {e}"))?;
    let well_known = single_instance_bus_name();
    linux_bus_name_has_owner(&conn, &well_known)
}

/// Linux: if a primary instance owns the single-instance bus name, forward argv and
/// signal the caller process should exit successfully. Otherwise continue normal startup.
pub enum LinuxPlayerForwardResult {
    Forwarded,
    ContinueStartup,
}

pub fn linux_try_forward_player_cli_secondary(args: &[String]) -> Result<LinuxPlayerForwardResult, String> {
    use zbus::blocking::Connection;

    let well_known = single_instance_bus_name();
    let conn = Connection::session().map_err(|e| format!("D-Bus session: {e}"))?;

    if !linux_bus_name_has_owner(&conn, well_known.as_str())? {
        return Ok(LinuxPlayerForwardResult::ContinueStartup);
    }

    let cwd = std::env::current_dir().unwrap_or_default();
    let cwd_s = cwd.to_str().unwrap_or("").to_string();
    let argv = args.to_vec();
    let path = single_instance_object_path(&well_known);

    match parse_cli_command(args) {
        Some(CliCommand::AudioDeviceList) => {
            let _ = std::fs::remove_file(cli_audio_device_response_path());
        }
        Some(CliCommand::LibraryList) => {
            let _ = std::fs::remove_file(cli_library_response_path());
        }
        Some(CliCommand::ServerList) => {
            let _ = std::fs::remove_file(cli_server_list_path());
        }
        Some(CliCommand::Search { .. }) => {
            let _ = std::fs::remove_file(cli_search_response_path());
        }
        Some(CliCommand::BenchmarkRun(_)) | Some(CliCommand::BenchmarkLatest) => {
            let _ = std::fs::remove_file(cli_benchmark_response_path());
        }
        _ => {}
    }

    conn.call_method(
        Some(well_known.as_str()),
        path.as_str(),
        Some("org.SingleInstance.DBus"),
        "ExecuteCallback",
        &(argv, cwd_s),
    )
    .map_err(|e| format!("forward to running instance: {e}"))?;

    if let Some(CliCommand::AudioDeviceList) = parse_cli_command(args) {
        let resp_path = cli_audio_device_response_path();
        let text = std::fs::read_to_string(&resp_path).unwrap_or_else(|_| "{}".into());
        if wants_cli_json_output(args) {
            println!("{}", text.trim());
        } else if let Ok(v) = serde_json::from_str::<Value>(&text) {
            print_audio_devices_human(&v);
        } else {
            println!("{}", text.trim());
        }
        if !wants_quiet(args) {
            println!("OK: audio-device list");
        }
    } else if let Some(CliCommand::LibraryList) = parse_cli_command(args) {
        let json_out = wants_cli_json_output(args);
        let text = read_library_cli_response_blocking(Duration::from_secs(3));
        print_library_cli_stdout(&text, json_out);
        if !wants_quiet(args) {
            println!("OK: library list");
        }
    } else if let Some(CliCommand::ServerList) = parse_cli_command(args) {
        let json_out = wants_cli_json_output(args);
        let text = read_server_list_cli_response_blocking(Duration::from_secs(3));
        print_server_list_cli_stdout(&text, json_out);
        if !wants_quiet(args) {
            println!("OK: server list");
        }
    } else if let Some(CliCommand::Search { .. }) = parse_cli_command(args) {
        let json_out = wants_cli_json_output(args);
        let text = read_search_cli_response_blocking(Duration::from_secs(12));
        print_search_cli_stdout(&text, json_out);
        if !wants_quiet(args) {
            if let Some(cmd) = parse_cli_command(args) {
                println!("OK: {}", describe_cli_command(&cmd));
            }
        }
    } else if matches!(parse_cli_command(args), Some(CliCommand::BenchmarkRun(_)) | Some(CliCommand::BenchmarkLatest)) {
        let text = read_benchmark_cli_response_blocking(Duration::from_secs(60 * 30));
        print_benchmark_cli_stdout(&text, wants_cli_json_output(args));
        if !wants_quiet(args) {
            println!("OK: {}", parse_cli_command(args).as_ref().map(describe_cli_command).unwrap_or_default());
        }
    } else if !wants_quiet(args) {
        if let Some(cmd) = parse_cli_command(args) {
            println!("OK: {}", describe_cli_command(&cmd));
        } else {
            println!("OK");
        }
    }

    Ok(LinuxPlayerForwardResult::Forwarded)
}

#[cfg(test)]
mod tests {
    use super::single_instance_dbus_id_for;

    #[test]
    fn debug_and_release_use_separate_dbus_namespaces() {
        assert_eq!(
            single_instance_dbus_id_for("dev.psysonic.player", false),
            "dev.psysonic.player"
        );
        assert_eq!(
            single_instance_dbus_id_for("dev.psysonic.player", true),
            "dev.psysonic.player.Debug"
        );
    }
}
