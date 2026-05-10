//! CLI surface for scripting / compositor bindings (e.g. Hyprland `exec`).

mod exchange;
#[cfg(target_os = "linux")]
mod linux_forward;
mod parse;
mod presenters;

pub use exchange::*;
#[cfg(target_os = "linux")]
pub use linux_forward::*;
pub use parse::*;
pub use presenters::print_audio_devices_human;
use exchange::{
    print_library_cli_stdout, print_search_cli_stdout, print_server_list_cli_stdout,
    read_library_cli_response_blocking, read_search_cli_response_blocking,
    read_server_list_cli_response_blocking,
};
use parse::{cli_action_registry_entries, cli_registry_entry_by_command};
use presenters::print_info_human;

// Bundled at compile time for `psysonic completions bash|zsh` (no extra files in packages).
const COMPLETIONS_BASH: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../completions/psysonic.bash"));
const COMPLETIONS_ZSH: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../completions/_psysonic"));

use std::time::Duration;
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};

pub fn print_version() {
    println!("{}", env!("CARGO_PKG_VERSION"));
}


/// `psysonic completions …` — returns exit code when this argv should not start the GUI.
pub fn try_completions_dispatch(args: &[String]) -> Option<i32> {
    if args.get(1).map(|s| s.as_str()) != Some("completions") {
        return None;
    }
    let program = args.first().map(|s| s.as_str()).unwrap_or("psysonic");
    match args.get(2).map(|s| s.as_str()) {
        None | Some("help") | Some("--help") | Some("-h") => {
            print_completions_install_help(program);
            Some(0)
        }
        Some("bash") => {
            print!("{COMPLETIONS_BASH}");
            Some(0)
        }
        Some("zsh") => {
            print!("{COMPLETIONS_ZSH}");
            Some(0)
        }
        Some(x) => {
            eprintln!("NOT OK: unknown completions subcommand {x:?} (expected: bash, zsh, help)");
            Some(2)
        }
    }
}

fn print_completions_install_help(program: &str) {
    eprintln!(
        "Psysonic embeds bash/zsh completion scripts in this binary.\n\
         \n\
         Bash — try once in this shell:\n\
           eval \"$({program} completions bash)\"\n\
         Or install:\n\
           mkdir -p ~/.local/share/psysonic\n\
           {program} completions bash > ~/.local/share/psysonic/psysonic.bash\n\
           echo '. ~/.local/share/psysonic/psysonic.bash' >> ~/.bashrc && source ~/.bashrc\n\
         \n\
         Zsh — install file then register (once in ~/.zshrc before compinit):\n\
           mkdir -p ~/.zsh/completions\n\
           {program} completions zsh > ~/.zsh/completions/_psysonic\n\
           fpath=(~/.zsh/completions $fpath)\n\
           autoload -Uz compinit && compinit\n\
         \n\
         Scripts only (stdout, for piping):\n\
           {program} completions bash\n\
           {program} completions zsh\n",
        program = program,
    );
}


pub fn print_help(program: &str) {
    let version = env!("CARGO_PKG_VERSION");
    eprintln!("Psysonic {version}\n");
    eprintln!("── Start ──");
    eprintln!("  {program}");
    eprintln!("  {program} --version | -V     Print version and exit.");
    eprintln!("  {program} --help | -h        Show this help.\n");
    eprintln!("── Shell completion (scripts are embedded in the binary) ──");
    eprintln!("  {program} completions          How to enable tab completion in bash / zsh.");
    eprintln!("  {program} completions bash   Print bash completion script (stdout).");
    eprintln!("  {program} completions zsh    Print zsh _psysonic script (stdout).\n");
    eprintln!("── Snapshot (saved play state / queue) ──");
    eprintln!("  Reads a JSON file written by the running app. Open the main window at least once.");
    eprintln!("  {program} --info             Human-readable summary.");
    eprintln!("  {program} --info --json      One JSON object on stdout.");
    eprintln!("  Linux: exits with an error if the primary instance is not on the session D-Bus.");
    eprintln!("  Windows / macOS: no D-Bus check; an empty or missing file means the UI has not");
    eprintln!("  published a snapshot yet.\n");
    eprintln!("── Logs channel (normal + debug) ──");
    eprintln!("  {program} --logs                      Print recent log lines and exit.");
    eprintln!("  {program} --logs --tail <lines>       Print the last <lines> entries.");
    eprintln!("  {program} --logs --tail <lines> -f    Keep streaming new lines.\n");
    eprintln!("── Remote commands (--player …) ──");
    eprintln!("  Require the main Psysonic process. Same flags on Linux, Windows, and macOS.");
    eprintln!("  Linux: a second CLI process can forward over D-Bus without opening another window.");
    eprintln!("  Windows / macOS: handled via single-instance (a helper process may run briefly).\n");
    eprintln!("  Global flags (place before --player when needed):");
    eprintln!("    --quiet | -q     Suppress \"OK: …\" lines (stderr errors are always shown).");
    eprintln!("    --json           With `audio-device list`, `library list`, `server list`, or `search`: JSON on stdout.");
    eprintln!("    Use  {program} -q --player seek -5  so the seek delta is not parsed as a flag.\n");
    eprintln!("  Playback");
    eprintln!("    {program} [--quiet|-q] --player <action>");
    for entry in cli_action_registry_entries() {
        eprintln!(
            "    {program} [--quiet|-q] --player {:<14} {}",
            entry.verb, entry.description
        );
    }
    eprintln!("    {program} [--quiet|-q] --player play <id>   Track, album, or artist id (artist → shuffled library).");
    eprintln!("    {program} [--quiet|-q] --player seek <seconds>      Integer delta, e.g. 15 or -10");
    eprintln!("    {program} [--quiet|-q] --player volume <0-100>     Absolute volume percent.");
    eprintln!("    {program} [--quiet|-q] --player repeat off|all|one");
    eprintln!("    {program} [--quiet|-q] --player rating <0-5>     Set song rating (0 clears).");
    eprintln!();
    eprintln!("  Audio output");
    eprintln!("    {program} [--json] --player audio-device list");
    eprintln!("    {program} --player audio-device set <device-id|default>\n");
    eprintln!("  Music library (Subsonic music folders for the active server)");
    eprintln!("    {program} [--json] --player library list");
    eprintln!("    {program} --player library set all | <folder-id>\n");
    eprintln!("  Servers (saved profiles — same as the in-app server switcher)");
    eprintln!("    {program} [--json] --player server list");
    eprintln!("    {program} --player server set <server-id>\n");
    eprintln!("  Search (active server; respects library folder filter)");
    eprintln!("    {program} [--json] --player search track <query…>");
    eprintln!("    {program} [--json] --player search album <query…>");
    eprintln!("    {program} [--json] --player search artist <query…>\n");
    eprintln!("  Instant mix (from the track that is currently loaded)");
    eprintln!("    {program} --player mix append");
    eprintln!("    {program} --player mix new\n");
    eprintln!("Exit: 0 on success. Errors print \"NOT OK: …\" on stderr with a non-zero status.");
}

const CLI_TAIL_DEFAULT_LINES: usize = 200;

fn print_log_tail_once(path: &std::path::Path, lines: usize) -> Result<u64, String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut ring: VecDeque<String> = VecDeque::with_capacity(lines.max(1));
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if ring.len() >= lines.max(1) {
            ring.pop_front();
        }
        ring.push_back(line.trim_end_matches('\n').to_string());
    }
    for row in ring {
        println!("{row}");
    }
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    Ok(len)
}

fn follow_log_file(path: &std::path::Path, mut offset: u64) -> Result<(), String> {
    loop {
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if len < offset {
            offset = 0;
        }
        if len > offset {
            let mut f = std::fs::OpenOptions::new()
                .read(true)
                .open(path)
                .map_err(|e| format!("open {}: {e}", path.display()))?;
            f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            let mut chunk = String::new();
            f.read_to_string(&mut chunk).map_err(|e| e.to_string())?;
            if !chunk.is_empty() {
                print!("{chunk}");
            }
            offset = len;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Print from the shared normal/debug channel and exit.
pub fn run_tail_and_exit(args: &[String]) -> ! {
    let tail_lines = match logs_tail_lines(args) {
        Ok(Some(n)) => n,
        Ok(None) => CLI_TAIL_DEFAULT_LINES,
        Err(e) => {
            eprintln!("NOT OK: {e}");
            std::process::exit(2);
        }
    };
    let path = crate::logging::cli_log_channel_path();
    if !path.exists() {
        eprintln!("NOT OK: no log channel file yet at {}", path.display());
        std::process::exit(3);
    }
    let offset = match print_log_tail_once(&path, tail_lines) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("NOT OK: {e}");
            std::process::exit(1);
        }
    };
    if wants_follow(args) {
        if let Err(e) = follow_log_file(&path, offset) {
            eprintln!("NOT OK: {e}");
            std::process::exit(1);
        }
    }
    std::process::exit(0);
}

/// Print snapshot and `exit`. Used from `main` before `run()`.
pub fn run_info_and_exit(args: &[String]) -> ! {
    let json_out = wants_info_json(args);

    #[cfg(target_os = "linux")]
    {
        match linux_is_primary_instance_running() {
            Ok(true) => {}
            Ok(false) => {
                eprintln!("NOT OK: Psysonic is not running");
                std::process::exit(2);
            }
            Err(e) => {
                eprintln!("NOT OK: {e}");
                std::process::exit(1);
            }
        }
    }

    let path = cli_snapshot_path();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let empty = v.is_null() || v.as_object().map(|m| m.is_empty()).unwrap_or(true);
    if empty {
        eprintln!("NOT OK: no CLI snapshot yet — wait until the main window has loaded.");
        std::process::exit(3);
    }

    if json_out {
        match serde_json::to_string(&v) {
            Ok(line) => println!("{line}"),
            Err(e) => {
                eprintln!("NOT OK: {e}");
                std::process::exit(1);
            }
        }
    } else {
        print_info_human(&v);
    }
    std::process::exit(0);
}






/// Handle `--player` argv on the primary instance. Returns `true` if argv was a CLI action
/// (do not raise/focus the main window).
pub fn handle_cli_on_primary_instance<R: Runtime>(app: &AppHandle<R>, argv: &[String]) -> bool {
    use tauri::Manager;
    match parse_cli_command(argv) {
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

