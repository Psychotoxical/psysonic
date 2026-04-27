//! CLI surface for scripting / compositor bindings (e.g. Hyprland `exec`).

// Bundled at compile time for `psysonic completions bash|zsh` (no extra files in packages).
const COMPLETIONS_BASH: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../completions/psysonic.bash"));
const COMPLETIONS_ZSH: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../completions/_psysonic"));

use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RepeatCliMode {
    Off,
    All,
    One,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchCliScope {
    Track,
    Album,
    Artist,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlayerCliCmd {
    Next,
    Prev,
    Play,
    PlayOpaqueId(String),
    Pause,
    Stop,
    Seek { delta_secs: i32 },
    Volume { percent: u8 },
    ShuffleQueue,
    Repeat(RepeatCliMode),
    Mute,
    Unmute,
    StarCurrent,
    UnstarCurrent,
    Rating { stars: u8 },
    ReloadPlayer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MixCliMode {
    Append,
    New,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CliCommand {
    Player(PlayerCliCmd),
    AudioDeviceList,
    /// `None` → follow host default output (same as Settings “system default”).
    AudioDeviceSet(Option<String>),
    LibraryList,
    /// `"all"` or a music-folder id from `library list`.
    LibrarySet(String),
    Mix(MixCliMode),
    ServerList,
    ServerSet(String),
    Search {
        scope: SearchCliScope,
        query: String,
    },
}

pub fn wants_version(args: &[String]) -> bool {
    args.iter()
        .skip(1)
        .any(|a| a == "--version" || a == "-V")
}

pub fn wants_help(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "--help" || a == "-h")
}

pub fn wants_info(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "--info")
}

pub fn wants_info_json(args: &[String]) -> bool {
    wants_info(args) && args.iter().skip(1).any(|a| a == "--json")
}

pub fn wants_tail(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "--tail")
}

pub fn wants_logs(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "--logs")
}

pub fn wants_follow(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "-f" || a == "--follow")
}

pub fn logs_tail_lines(args: &[String]) -> Result<Option<usize>, String> {
    let mut i = 1usize;
    while i < args.len() {
        if args[i] == "--tail" {
            let Some(raw) = args.get(i + 1) else {
                return Err("--tail requires a numeric value".to_string());
            };
            if raw.starts_with('-') {
                return Err("--tail requires a positive integer value".to_string());
            }
            let n: usize = raw
                .parse()
                .map_err(|_| "--tail requires a positive integer value".to_string())?;
            if n == 0 {
                return Err("--tail must be greater than 0".to_string());
            }
            return Ok(Some(n));
        }
        i += 1;
    }
    Ok(None)
}

pub fn wants_quiet(args: &[String]) -> bool {
    args.iter()
        .skip(1)
        .any(|a| a == "--quiet" || a == "-q")
}

/// Machine-readable output for `--json` with list/search commands (`audio-device`, `library`, `server`, `search`).
pub fn wants_cli_json_output(args: &[String]) -> bool {
    args.iter().skip(1).any(|a| a == "--json")
}

pub fn print_version() {
    println!("{}", env!("CARGO_PKG_VERSION"));
}

/// JSON snapshot path (written by the GUI process, read by `psysonic --info`).
pub fn cli_snapshot_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-snapshot.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-snapshot.json")
}

pub fn cli_audio_device_response_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-audio-devices.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-audio-devices.json")
}

pub fn cli_library_response_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-library.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-library.json")
}

pub fn cli_server_list_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-servers.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-servers.json")
}

pub fn cli_search_response_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-search.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-search.json")
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

pub fn write_cli_snapshot(payload: &Value) -> Result<(), String> {
    let path = cli_snapshot_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
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
    eprintln!("    {program} [--quiet|-q] --player next | prev | play | pause | stop");
    eprintln!("    {program} [--quiet|-q] --player play <id>   Track, album, or artist id (artist → shuffled library).");
    eprintln!("    {program} [--quiet|-q] --player seek <seconds>      Integer delta, e.g. 15 or -10");
    eprintln!("    {program} [--quiet|-q] --player volume <0-100>     Absolute volume percent.");
    eprintln!("    {program} [--quiet|-q] --player shuffle         Shuffle the current queue.");
    eprintln!("    {program} [--quiet|-q] --player repeat off|all|one");
    eprintln!("    {program} [--quiet|-q] --player mute | unmute");
    eprintln!("    {program} [--quiet|-q] --player star | unstar     Current track (Subsonic star).");
    eprintln!("    {program} [--quiet|-q] --player rating <0-5>     Set song rating (0 clears).");
    eprintln!("    {program} [--quiet|-q] --player reload          Restart audio for the current track or reload server queue.\n");
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

/// Wait for the webview to write `psysonic-cli-library.json` after `cli:library-list`.
fn read_library_cli_response_blocking(max_wait: Duration) -> String {
    let path = cli_library_response_path();
    let deadline = Instant::now() + max_wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let trimmed = text.trim();
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                if v.get("folders").and_then(|x| x.as_array()).is_some() {
                    return text;
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into())
}

pub fn print_library_cli_stdout(text: &str, json_out: bool) {
    if json_out {
        println!("{}", text.trim());
        return;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        print_library_human(&v);
    } else {
        println!("{}", text.trim());
    }
}

fn print_library_human(v: &Value) {
    if let Some(sid) = v.get("active_server_id").and_then(|x| x.as_str()) {
        println!("active_server_id: {sid}");
    } else {
        println!("active_server_id: (none)");
    }
    match v.get("selected").and_then(|x| x.as_str()) {
        Some(s) => println!("selected: {s}"),
        None => println!("selected: (unknown)"),
    }
    println!("folders:");
    if let Some(Value::Array(rows)) = v.get("folders") {
        if rows.is_empty() {
            println!("  (none)");
            return;
        }
        for row in rows {
            let id = row.get("id").and_then(|x| x.as_str()).unwrap_or("?");
            let name = row.get("name").and_then(|x| x.as_str()).unwrap_or("?");
            println!("  - {id}\t{name}");
        }
    } else {
        println!("  (invalid JSON: missing folders array)");
    }
}

pub fn write_library_cli_response(payload: &Value) -> Result<(), String> {
    let path = cli_library_response_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn write_server_list_cli_response(payload: &Value) -> Result<(), String> {
    let path = cli_server_list_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn write_search_cli_response(payload: &Value) -> Result<(), String> {
    let path = cli_search_response_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Wait for `psysonic-cli-servers.json` after `cli:server-list`.
fn read_server_list_cli_response_blocking(max_wait: Duration) -> String {
    let path = cli_server_list_path();
    let deadline = Instant::now() + max_wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let trimmed = text.trim();
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                if v.get("servers").and_then(|x| x.as_array()).is_some() {
                    return text;
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into())
}

pub fn print_server_list_cli_stdout(text: &str, json_out: bool) {
    if json_out {
        println!("{}", text.trim());
        return;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        print_server_list_human(&v);
    } else {
        println!("{}", text.trim());
    }
}

fn print_server_list_human(v: &Value) {
    if let Some(sid) = v.get("active_server_id").and_then(|x| x.as_str()) {
        println!("active_server_id: {sid}");
    } else {
        println!("active_server_id: (none)");
    }
    println!("servers:");
    if let Some(Value::Array(rows)) = v.get("servers") {
        if rows.is_empty() {
            println!("  (none)");
            return;
        }
        for row in rows {
            let id = row.get("id").and_then(|x| x.as_str()).unwrap_or("?");
            let name = row.get("name").and_then(|x| x.as_str()).unwrap_or("?");
            println!("  - {id}\t{name}");
        }
    } else {
        println!("  (invalid JSON: missing servers array)");
    }
}

/// Wait for `psysonic-cli-search.json` after `cli:search`.
fn read_search_cli_response_blocking(max_wait: Duration) -> String {
    let path = cli_search_response_path();
    let deadline = Instant::now() + max_wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let trimmed = text.trim();
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                let ready = v.get("ready").and_then(|x| x.as_bool()) == Some(true);
                let has_err = v.get("error").and_then(|x| x.as_str()).is_some_and(|s| !s.is_empty());
                if ready || has_err {
                    return text;
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into())
}

pub fn print_search_cli_stdout(text: &str, json_out: bool) {
    if json_out {
        println!("{}", text.trim());
        return;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        print_search_human(&v);
    } else {
        println!("{}", text.trim());
    }
}

fn print_search_human(v: &Value) {
    if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
        if !err.is_empty() {
            println!("error: {err}");
            return;
        }
    }
    let scope = v.get("scope").and_then(|x| x.as_str()).unwrap_or("?");
    let query = v.get("query").and_then(|x| x.as_str()).unwrap_or("");
    println!("scope: {scope}");
    println!("query: {query}");
    match scope {
        "track" => {
            println!("songs:");
            if let Some(Value::Array(rows)) = v.get("songs") {
                if rows.is_empty() {
                    println!("  (none)");
                    return;
                }
                for row in rows {
                    let id = row.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                    let title = row.get("title").and_then(|x| x.as_str()).unwrap_or("?");
                    let artist = row.get("artist").and_then(|x| x.as_str()).unwrap_or("?");
                    println!("  - {id}\t{artist} — {title}");
                }
            } else {
                println!("  (missing songs array)");
            }
        }
        "album" => {
            println!("albums:");
            if let Some(Value::Array(rows)) = v.get("albums") {
                if rows.is_empty() {
                    println!("  (none)");
                    return;
                }
                for row in rows {
                    let id = row.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                    let name = row.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                    let artist = row.get("artist").and_then(|x| x.as_str()).unwrap_or("?");
                    println!("  - {id}\t{artist} — {name}");
                }
            } else {
                println!("  (missing albums array)");
            }
        }
        "artist" => {
            println!("artists:");
            if let Some(Value::Array(rows)) = v.get("artists") {
                if rows.is_empty() {
                    println!("  (none)");
                    return;
                }
                for row in rows {
                    let id = row.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                    let name = row.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                    println!("  - {id}\t{name}");
                }
            } else {
                println!("  (missing artists array)");
            }
        }
        _ => println!("(unknown scope)"),
    }
}

#[cfg(target_os = "linux")]
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

#[cfg(target_os = "linux")]
fn single_instance_bus_name() -> String {
    format!("{}.SingleInstance", tauri_identifier())
}

#[cfg(target_os = "linux")]
fn single_instance_object_path(dbus_name: &str) -> String {
    let mut dbus_path = dbus_name.replace('.', "/").replace('-', "_");
    if !dbus_path.starts_with('/') {
        dbus_path = format!("/{dbus_path}");
    }
    dbus_path
}

#[cfg(target_os = "linux")]
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
#[cfg(target_os = "linux")]
pub fn linux_is_primary_instance_running() -> Result<bool, String> {
    use zbus::blocking::Connection;
    let conn = Connection::session().map_err(|e| format!("D-Bus session: {e}"))?;
    let well_known = single_instance_bus_name();
    linux_bus_name_has_owner(&conn, &well_known)
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

fn print_info_human(v: &Value) {
    let o = v.as_object();
    let o = match o {
        Some(m) => m,
        None => {
            println!("(snapshot is not a JSON object)");
            return;
        }
    };

    let track = o.get("current_track").and_then(|x| x.as_object());
    println!("=== current_track ===");
    match track {
        None => println!("(none)"),
        Some(t) if t.is_empty() => println!("(none)"),
        Some(t) => {
            for (k, val) in sorted_kv(t) {
                println!("  {k}: {}", value_inline(val));
            }
        }
    }

    println!("=== current_radio ===");
    match o.get("current_radio") {
        None | Some(Value::Null) => println!("(none)"),
        Some(Value::Object(m)) if m.is_empty() => println!("(none)"),
        Some(Value::Object(m)) => {
            for (k, val) in sorted_kv(m) {
                println!("  {k}: {}", value_inline(val));
            }
        }
        Some(x) => println!("  {}", value_inline(x)),
    }

    println!("=== music_library ===");
    match o.get("music_library").and_then(|x| x.as_object()) {
        None => println!("(none)"),
        Some(m) if m.is_empty() => println!("(none)"),
        Some(m) => {
            if let Some(v) = m.get("selected") {
                println!("  selected: {}", value_inline(v));
            }
            if let Some(v) = m.get("active_server_id") {
                println!("  active_server_id: {}", value_inline(v));
            }
            println!("  folders:");
            match m.get("folders").and_then(|x| x.as_array()) {
                None => println!("    (none loaded)"),
                Some(a) if a.is_empty() => println!("    (none loaded)"),
                Some(rows) => {
                    for row in rows {
                        let id = row.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                        let name = row.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                        println!("    - {id}\t{name}");
                    }
                }
            }
        }
    }

    println!("=== playback ===");
    for key in [
        "is_playing",
        "current_time",
        "volume",
        "queue_index",
        "queue_length",
        "repeat_mode",
        "current_track_user_rating",
        "current_track_starred",
    ] {
        if let Some(val) = o.get(key) {
            println!("  {key}: {}", value_inline(val));
        }
    }

    println!("=== servers (saved) ===");
    match o.get("servers").and_then(|x| x.as_array()) {
        None => println!("(none)"),
        Some(rows) if rows.is_empty() => println!("(none)"),
        Some(rows) => {
            for row in rows {
                let id = row.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                let name = row.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                println!("  - {id}\t{name}");
            }
        }
    }

    println!("=== queue ({} items) ===", o.get("queue_length").and_then(|x| x.as_u64()).unwrap_or(0));
    if let Some(Value::Array(items)) = o.get("queue") {
        for (i, item) in items.iter().enumerate() {
            let line = match item {
                Value::Object(m) => {
                    let title = m.get("title").and_then(|x| x.as_str()).unwrap_or("?");
                    let artist = m.get("artist").and_then(|x| x.as_str()).unwrap_or("?");
                    let id = m.get("id").and_then(|x| x.as_str()).unwrap_or("?");
                    format!("[{i}] {artist} — {title} ({id})")
                }
                _ => format!("[{i}] {}", value_inline(item)),
            };
            println!("{line}");
        }
    } else {
        println!("(no queue array in snapshot)");
    }
}

fn sorted_kv(m: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut v: Vec<_> = m.iter().collect();
    v.sort_by(|a, b| a.0.cmp(b.0));
    v
}

fn value_inline(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "(null)".into(),
        Value::Array(a) => format!("[{} elements]", a.len()),
        Value::Object(m) => format!("{{{} keys}}", m.len()),
    }
}

fn parse_repeat_mode(arg: &str) -> Option<RepeatCliMode> {
    match arg {
        "off" => Some(RepeatCliMode::Off),
        "all" => Some(RepeatCliMode::All),
        "one" => Some(RepeatCliMode::One),
        _ => None,
    }
}

fn parse_player_cli_at(args: &[String], pos: usize) -> Option<PlayerCliCmd> {
    let verb = args.get(pos + 1)?.as_str();
    match verb {
        "next" => Some(PlayerCliCmd::Next),
        "prev" => Some(PlayerCliCmd::Prev),
        "play" => match args.get(pos + 2).map(|s| s.as_str()) {
            None => Some(PlayerCliCmd::Play),
            Some(flag) if flag.starts_with('-') => None,
            Some(extra) => {
                if extra.is_empty() {
                    return None;
                }
                Some(PlayerCliCmd::PlayOpaqueId(extra.to_string()))
            }
        },
        "pause" => Some(PlayerCliCmd::Pause),
        "stop" => Some(PlayerCliCmd::Stop),
        "shuffle" => Some(PlayerCliCmd::ShuffleQueue),
        "repeat" => {
            let m = parse_repeat_mode(args.get(pos + 2)?.as_str())?;
            Some(PlayerCliCmd::Repeat(m))
        }
        "mute" => Some(PlayerCliCmd::Mute),
        "unmute" => Some(PlayerCliCmd::Unmute),
        "star" => Some(PlayerCliCmd::StarCurrent),
        "unstar" => Some(PlayerCliCmd::UnstarCurrent),
        "rating" => {
            let raw = args.get(pos + 2)?;
            let n: u8 = raw.parse().ok()?;
            if n > 5 {
                return None;
            }
            Some(PlayerCliCmd::Rating { stars: n })
        }
        "reload" => Some(PlayerCliCmd::ReloadPlayer),
        "seek" => {
            let raw = args.get(pos + 2)?;
            let delta_secs: i32 = raw.parse().ok()?;
            Some(PlayerCliCmd::Seek { delta_secs })
        }
        "volume" => {
            let raw = args.get(pos + 2)?;
            let v: i64 = raw.parse().ok()?;
            if !(0..=100).contains(&v) {
                return None;
            }
            Some(PlayerCliCmd::Volume {
                percent: v as u8,
            })
        }
        _ => None,
    }
}

/// Parse transport / playback / device / mix `psysonic --player …` argv.
pub fn parse_cli_command(args: &[String]) -> Option<CliCommand> {
    let pos = args.iter().position(|a| a == "--player")?;
    let verb = args.get(pos + 1)?.as_str();
    match verb {
        "audio-device" => {
            let sub = args.get(pos + 2)?.as_str();
            match sub {
                "list" => Some(CliCommand::AudioDeviceList),
                "set" => {
                    let arg = args.get(pos + 3)?;
                    let name = if arg == "default" {
                        None
                    } else {
                        Some(arg.clone())
                    };
                    Some(CliCommand::AudioDeviceSet(name))
                }
                _ => None,
            }
        }
        "mix" => {
            let sub = args.get(pos + 2)?.as_str();
            match sub {
                "append" => Some(CliCommand::Mix(MixCliMode::Append)),
                "new" => Some(CliCommand::Mix(MixCliMode::New)),
                _ => None,
            }
        }
        "library" => {
            let sub = args.get(pos + 2)?.as_str();
            match sub {
                "list" => Some(CliCommand::LibraryList),
                "set" => {
                    let arg = args.get(pos + 3)?;
                    Some(CliCommand::LibrarySet(arg.clone()))
                }
                _ => None,
            }
        }
        "server" => {
            let sub = args.get(pos + 2)?.as_str();
            match sub {
                "list" => Some(CliCommand::ServerList),
                "set" => {
                    let id = args.get(pos + 3)?;
                    if id.is_empty() {
                        return None;
                    }
                    Some(CliCommand::ServerSet(id.clone()))
                }
                _ => None,
            }
        }
        "search" => {
            let scope_raw = args.get(pos + 2)?.as_str();
            let scope = match scope_raw {
                "track" => SearchCliScope::Track,
                "album" => SearchCliScope::Album,
                "artist" => SearchCliScope::Artist,
                _ => return None,
            };
            let tail = args.get(pos + 3..)?;
            let query = tail.join(" ").trim().to_string();
            if query.is_empty() {
                return None;
            }
            Some(CliCommand::Search { scope, query })
        }
        _ => parse_player_cli_at(args, pos).map(CliCommand::Player),
    }
}

pub fn write_audio_device_cli_response(engine: &crate::audio::AudioEngine) -> Result<(), String> {
    let devices = crate::audio::audio_list_devices_for_engine(engine);
    let default_device = crate::audio::audio_default_output_device_name();
    let selected = engine.selected_device.lock().unwrap().clone();
    let v = serde_json::json!({
        "devices": devices,
        "default": default_device,
        "selected": selected,
    });
    let path = cli_audio_device_response_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn print_audio_devices_human(v: &Value) {
    if let Some(def) = v.get("default").and_then(|x| x.as_str()) {
        println!("default_output: {def}");
    } else {
        println!("default_output: (unknown)");
    }
    if let Some(sel) = v.get("selected").and_then(|x| x.as_str()) {
        println!("selected: {sel}");
    } else {
        println!("selected: (host default)");
    }
    println!("devices:");
    if let Some(Value::Array(devs)) = v.get("devices") {
        for d in devs {
            if let Some(s) = d.as_str() {
                println!("  - {s}");
            }
        }
    } else {
        println!("  (none)");
    }
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
                let _ = write_audio_device_cli_response(&*engine);
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
                    let _ = write_audio_device_cli_response(&*engine);
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
    match cmd {
        PlayerCliCmd::Next => "next track".into(),
        PlayerCliCmd::Prev => "previous track".into(),
        PlayerCliCmd::Play => "play".into(),
        PlayerCliCmd::PlayOpaqueId(id) => format!("play {id}"),
        PlayerCliCmd::Pause => "pause".into(),
        PlayerCliCmd::Stop => "stop".into(),
        PlayerCliCmd::Seek { delta_secs } => format!("seek {delta_secs:+} s"),
        PlayerCliCmd::Volume { percent } => format!("volume {percent}%"),
        PlayerCliCmd::ShuffleQueue => "shuffle".into(),
        PlayerCliCmd::Repeat(m) => match m {
            RepeatCliMode::Off => "repeat off".into(),
            RepeatCliMode::All => "repeat all".into(),
            RepeatCliMode::One => "repeat one".into(),
        },
        PlayerCliCmd::Mute => "mute".into(),
        PlayerCliCmd::Unmute => "unmute".into(),
        PlayerCliCmd::StarCurrent => "star".into(),
        PlayerCliCmd::UnstarCurrent => "unstar".into(),
        PlayerCliCmd::Rating { stars } => format!("rating {stars}"),
        PlayerCliCmd::ReloadPlayer => "reload".into(),
    }
}

pub fn emit_player_cli_cmd<R: Runtime>(app: &AppHandle<R>, cmd: PlayerCliCmd) {
    match cmd {
        PlayerCliCmd::Next => {
            let _ = app.emit("media:next", ());
        }
        PlayerCliCmd::Prev => {
            let _ = app.emit("media:prev", ());
        }
        PlayerCliCmd::Play => {
            let _ = app.emit("media:play", ());
        }
        PlayerCliCmd::PlayOpaqueId(id) => {
            let _ = app.emit("cli:play-id", id);
        }
        PlayerCliCmd::Pause => {
            let _ = app.emit("media:pause", ());
        }
        PlayerCliCmd::Stop => {
            let _ = app.emit("media:stop", ());
        }
        PlayerCliCmd::Seek { delta_secs } => {
            let _ = app.emit("media:seek-relative", delta_secs);
        }
        PlayerCliCmd::Volume { percent } => {
            let _ = app.emit("media:set-volume", percent);
        }
        PlayerCliCmd::ShuffleQueue => {
            let _ = app.emit("cli:shuffle-queue", ());
        }
        PlayerCliCmd::Repeat(mode) => {
            let s = match mode {
                RepeatCliMode::Off => "off",
                RepeatCliMode::All => "all",
                RepeatCliMode::One => "one",
            };
            let _ = app.emit("cli:set-repeat", s);
        }
        PlayerCliCmd::Mute => {
            let _ = app.emit("cli:mute", ());
        }
        PlayerCliCmd::Unmute => {
            let _ = app.emit("cli:unmute", ());
        }
        PlayerCliCmd::StarCurrent => {
            let _ = app.emit("cli:star-current", true);
        }
        PlayerCliCmd::UnstarCurrent => {
            let _ = app.emit("cli:star-current", false);
        }
        PlayerCliCmd::Rating { stars } => {
            let _ = app.emit("cli:set-rating-current", stars);
        }
        PlayerCliCmd::ReloadPlayer => {
            let _ = app.emit("cli:reload-player", ());
        }
    }
}

/// Linux: if a primary instance owns the single-instance bus name, forward argv and
/// signal the caller process should exit successfully. Otherwise continue normal startup.
#[cfg(target_os = "linux")]
pub enum LinuxPlayerForwardResult {
    Forwarded,
    ContinueStartup,
}

#[cfg(target_os = "linux")]
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
    } else if !wants_quiet(args) {
        if let Some(cmd) = parse_cli_command(args) {
            println!("OK: {}", describe_cli_command(&cmd));
        } else {
            println!("OK");
        }
    }

    Ok(LinuxPlayerForwardResult::Forwarded)
}
