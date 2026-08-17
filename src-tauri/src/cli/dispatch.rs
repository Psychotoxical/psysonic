use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};

use super::exchange::{
    print_benchmark_cli_stdout, print_library_cli_stdout, print_search_cli_stdout,
    print_server_list_cli_stdout, read_benchmark_cli_response_blocking,
    read_library_cli_response_blocking, read_search_cli_response_blocking,
    read_server_list_cli_response_blocking,
};
use super::parse::{cli_registry_entry_by_command, *};
use super::presenters::print_audio_devices_human;
use super::{
    cli_audio_device_response_path, cli_benchmark_response_path, cli_library_response_path,
    cli_search_response_path, cli_server_list_path, write_audio_device_cli_response,
    write_benchmark_cli_response,
};

/// Handle `--player` argv on the primary instance. Returns `true` if argv was a CLI action
/// (do not raise/focus the main window).
pub fn handle_cli_on_primary_instance<R: Runtime>(app: &AppHandle<R>, argv: &[String]) -> bool {
    use tauri::Manager;
    match parse_cli_command(argv) {
        Some(CliCommand::BenchmarkRun(request)) => {
            let _ = crate::benchmark::queue_request(app, &request);
            true
        }
        Some(CliCommand::BenchmarkLatest) => {
            let response = crate::benchmark::publish_latest_to_cli(app);
            if let Err(error) = response {
                let _ = write_benchmark_cli_response(
                    &serde_json::json!({ "ready": true, "error": error }),
                );
            }
            true
        }
        Some(CliCommand::Player(cmd)) => {
            emit_player_cli_cmd(app, cmd);
            true
        }
        Some(CliCommand::AudioDeviceList) => {
            if let Some(engine) = app.try_state::<crate::audio::AudioEngine>() {
                let _ = write_audio_device_cli_response(engine.inner());
            }
            true
        }
        Some(CliCommand::AudioDeviceSet(name)) => {
            let payload = name.unwrap_or_default();
            let _ = app.emit("cli:audio-device-set", payload);
            true
        }
        Some(CliCommand::Mix(mode)) => {
            let s = match mode {
                MixCliMode::Append => "append",
                MixCliMode::New => "new",
            };
            let _ = app.emit("cli:instant-mix", s);
            true
        }
        Some(CliCommand::LibraryList) => {
            let _ = app.emit("cli:library-list", ());
            true
        }
        Some(CliCommand::LibrarySet(folder)) => {
            let _ = app.emit("cli:library-set", folder.clone());
            true
        }
        Some(CliCommand::ServerList) => {
            let _ = app.emit("cli:server-list", ());
            true
        }
        Some(CliCommand::ServerSet(id)) => {
            let _ = app.emit("cli:server-set", id.clone());
            true
        }
        Some(CliCommand::Search { scope, query }) => {
            let scope_s = match scope {
                SearchCliScope::Track => "track",
                SearchCliScope::Album => "album",
                SearchCliScope::Artist => "artist",
            };
            let _ = app.emit(
                "cli:search",
                serde_json::json!({ "scope": scope_s, "query": query }),
            );
            true
        }
        None => false,
    }
}

/// Cold start: `--player …` argv handled after a short delay so the webview can attach listeners.
pub fn spawn_deferred_cli_argv_handler<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Manager;

    let argv: Vec<String> = std::env::args().collect();
    let Some(cmd) = parse_cli_command(&argv) else {
        return;
    };
    let quiet = wants_quiet(&argv);
    let json_out = wants_cli_json_output(&argv);
    let ok_line = describe_cli_command(&cmd);
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        match cmd {
            CliCommand::BenchmarkRun(request) => {
                let _ = std::fs::remove_file(cli_benchmark_response_path());
                let _ = crate::benchmark::queue_request(&handle, &request);
                let text = read_benchmark_cli_response_blocking(Duration::from_secs(60 * 30));
                print_benchmark_cli_stdout(&text, json_out);
                if !quiet {
                    println!("OK: {ok_line} (applied after startup)");
                }
                std::process::exit(0);
            }
            CliCommand::BenchmarkLatest => {
                let _ = std::fs::remove_file(cli_benchmark_response_path());
                if let Err(error) = crate::benchmark::publish_latest_to_cli(&handle) {
                    let _ = write_benchmark_cli_response(
                        &serde_json::json!({ "ready": true, "error": error }),
                    );
                }
                let text = read_benchmark_cli_response_blocking(Duration::from_secs(3));
                print_benchmark_cli_stdout(&text, json_out);
                if !quiet {
                    println!("OK: {ok_line} (applied after startup)");
                }
                std::process::exit(0);
            }
            CliCommand::Player(c) => {
                emit_player_cli_cmd(&handle, c);
            }
            CliCommand::AudioDeviceList => {
                if let Some(engine) = handle.try_state::<crate::audio::AudioEngine>() {
                    let _ = write_audio_device_cli_response(engine.inner());
                }
                let text = std::fs::read_to_string(cli_audio_device_response_path())
                    .unwrap_or_else(|_| "{}".into());
                if json_out {
                    println!("{}", text.trim());
                } else if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    print_audio_devices_human(&v);
                } else {
                    println!("{}", text.trim());
                }
            }
            CliCommand::AudioDeviceSet(name) => {
                let payload = name.unwrap_or_default();
                let _ = handle.emit("cli:audio-device-set", payload);
            }
            CliCommand::Mix(mode) => {
                let s = match mode {
                    MixCliMode::Append => "append",
                    MixCliMode::New => "new",
                };
                let _ = handle.emit("cli:instant-mix", s);
            }
            CliCommand::LibraryList => {
                let _ = std::fs::remove_file(cli_library_response_path());
                let _ = handle.emit("cli:library-list", ());
                let text = read_library_cli_response_blocking(Duration::from_secs(3));
                print_library_cli_stdout(&text, json_out);
            }
            CliCommand::LibrarySet(folder) => {
                let _ = handle.emit("cli:library-set", folder.clone());
            }
            CliCommand::ServerList => {
                let _ = std::fs::remove_file(cli_server_list_path());
                let _ = handle.emit("cli:server-list", ());
                let text = read_server_list_cli_response_blocking(Duration::from_secs(3));
                print_server_list_cli_stdout(&text, json_out);
            }
            CliCommand::ServerSet(id) => {
                let _ = handle.emit("cli:server-set", id.clone());
            }
            CliCommand::Search { scope, query } => {
                let _ = std::fs::remove_file(cli_search_response_path());
                let scope_s = match scope {
                    SearchCliScope::Track => "track",
                    SearchCliScope::Album => "album",
                    SearchCliScope::Artist => "artist",
                };
                let _ = handle.emit(
                    "cli:search",
                    serde_json::json!({ "scope": scope_s, "query": query }),
                );
                let text = read_search_cli_response_blocking(Duration::from_secs(12));
                print_search_cli_stdout(&text, json_out);
            }
        }
        if !quiet {
            println!("OK: {ok_line} (applied after startup)");
        }
    });
}

pub fn describe_cli_command(cmd: &CliCommand) -> String {
    match cmd {
        CliCommand::BenchmarkRun(request) => format!(
            "benchmark run scenario={} runs={} profile={}",
            request.scenario, request.runs, request.profile,
        ),
        CliCommand::BenchmarkLatest => "benchmark latest".into(),
        CliCommand::Player(c) => describe_player_cli_cmd(c),
        CliCommand::AudioDeviceList => "audio-device list".into(),
        CliCommand::AudioDeviceSet(None) => "audio-device set default".into(),
        CliCommand::AudioDeviceSet(Some(s)) => format!("audio-device set {s}"),
        CliCommand::Mix(MixCliMode::Append) => "mix append".into(),
        CliCommand::Mix(MixCliMode::New) => "mix new".into(),
        CliCommand::LibraryList => "library list".into(),
        CliCommand::LibrarySet(s) if s == "all" => "library set all".into(),
        CliCommand::LibrarySet(s) => format!("library set {s}"),
        CliCommand::ServerList => "server list".into(),
        CliCommand::ServerSet(s) => format!("server set {s}"),
        CliCommand::Search { scope, query } => {
            let sc = match scope {
                SearchCliScope::Track => "track",
                SearchCliScope::Album => "album",
                SearchCliScope::Artist => "artist",
            };
            format!("search {sc} {query}")
        }
    }
}

pub fn describe_player_cli_cmd(cmd: &PlayerCliCmd) -> String {
    if let PlayerCliCmd::NoArgCommand(command) = cmd {
        if let Some(entry) = cli_registry_entry_by_command(command) {
            return entry.verb.clone();
        }
        return command.clone();
    }
    match cmd {
        PlayerCliCmd::PlayOpaqueId(id) => format!("play {id}"),
        PlayerCliCmd::Seek { delta_secs } => format!("seek {delta_secs:+} s"),
        PlayerCliCmd::Volume { percent } => format!("volume {percent}%"),
        PlayerCliCmd::VolumeRelative { delta_percent } => format!("volume {delta_percent:+}%"),
        PlayerCliCmd::Repeat(m) => match m {
            RepeatCliMode::Off => "repeat off".into(),
            RepeatCliMode::All => "repeat all".into(),
            RepeatCliMode::One => "repeat one".into(),
        },
        PlayerCliCmd::Rating { stars } => format!("rating {stars}"),
        PlayerCliCmd::NoArgCommand(command) => command.clone(),
    }
}

fn emit_cli_player_command<R: Runtime>(app: &AppHandle<R>, payload: serde_json::Value) {
    let _ = app.emit("cli:player-command", payload);
}

pub fn emit_player_cli_cmd<R: Runtime>(app: &AppHandle<R>, cmd: PlayerCliCmd) {
    if let PlayerCliCmd::NoArgCommand(command) = &cmd {
        emit_cli_player_command(
            app,
            serde_json::json!({
                "command": command
            }),
        );
        return;
    }

    match cmd {
        PlayerCliCmd::PlayOpaqueId(id) => {
            emit_cli_player_command(
                app,
                serde_json::json!({
                    "command": "play-id",
                    "id": id
                }),
            );
        }
        PlayerCliCmd::Seek { delta_secs } => {
            emit_cli_player_command(
                app,
                serde_json::json!({
                    "command": "seek-relative",
                    "deltaSecs": delta_secs
                }),
            );
        }
        PlayerCliCmd::Volume { percent } => {
            emit_cli_player_command(
                app,
                serde_json::json!({
                    "command": "set-volume",
                    "percent": percent
                }),
            );
        }
        PlayerCliCmd::VolumeRelative { delta_percent } => {
            emit_cli_player_command(
                app,
                serde_json::json!({
                    "command": "volume-relative",
                    "deltaPercent": delta_percent
                }),
            );
        }
        PlayerCliCmd::Repeat(mode) => {
            let s = match mode {
                RepeatCliMode::Off => "off",
                RepeatCliMode::All => "all",
                RepeatCliMode::One => "one",
            };
            emit_cli_player_command(
                app,
                serde_json::json!({
                    "command": "set-repeat",
                    "mode": s
                }),
            );
        }
        PlayerCliCmd::Rating { stars } => {
            emit_cli_player_command(
                app,
                serde_json::json!({
                    "command": "set-rating-current",
                    "stars": stars
                }),
            );
        }
        PlayerCliCmd::NoArgCommand(_) => {}
    }
}
