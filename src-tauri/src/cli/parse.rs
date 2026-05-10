use std::sync::OnceLock;

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
    NoArgCommand(String),
    PlayOpaqueId(String),
    Seek { delta_secs: i32 },
    Volume { percent: u8 },
    Repeat(RepeatCliMode),
    Rating { stars: u8 },
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct CliActionRegistryEntry {
    pub(super) command: String,
    pub(super) verb: String,
    pub(super) description: String,
}

fn shortcut_actions_registry_source() -> &'static str {
    include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/config/shortcutActions.ts"
    ))
}

fn extract_quoted_field(line: &str, key: &str) -> Option<String> {
    let needle = format!("{key}: '");
    let start = line.find(&needle)? + needle.len();
    let tail = &line[start..];
    let end = tail.find('\'')?;
    Some(tail[..end].to_string())
}

fn parse_registry_action_id(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if !trimmed.ends_with('{') {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix('\'') {
        let end = rest.find('\'')?;
        let id = &rest[..end];
        let tail = rest[end + 1..].trim_start();
        if !tail.starts_with(':') {
            return None;
        }
        return Some(id.to_string());
    }
    let brace_idx = trimmed.find(':')?;
    let candidate = trimmed[..brace_idx].trim();
    if candidate.is_empty() || !trimmed[brace_idx + 1..].trim_start().starts_with('{') {
        return None;
    }
    if !candidate
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return None;
    }
    Some(candidate.to_string())
}

fn parse_cli_action_registry_entries() -> Vec<CliActionRegistryEntry> {
    let mut entries = Vec::new();
    let mut current_action_id: Option<String> = None;

    for line in shortcut_actions_registry_source().lines() {
        if let Some(id) = parse_registry_action_id(line) {
            current_action_id = Some(id);
            continue;
        }
        let trimmed = line.trim();
        if !trimmed.starts_with("cli: {") {
            continue;
        }
        let Some(action_id) = current_action_id.clone() else {
            continue;
        };
        let Some(verb) = extract_quoted_field(trimmed, "verb") else {
            continue;
        };
        let Some(description) = extract_quoted_field(trimmed, "description") else {
            continue;
        };
        let command = extract_quoted_field(trimmed, "command").unwrap_or_else(|| action_id.clone());
        entries.push(CliActionRegistryEntry {
            command,
            verb,
            description,
        });
    }

    entries
}

pub(super) fn cli_action_registry_entries() -> &'static Vec<CliActionRegistryEntry> {
    static ENTRIES: OnceLock<Vec<CliActionRegistryEntry>> = OnceLock::new();
    ENTRIES.get_or_init(parse_cli_action_registry_entries)
}

pub(super) fn cli_registry_entry_by_verb(verb: &str) -> Option<&'static CliActionRegistryEntry> {
    cli_action_registry_entries().iter().find(|entry| entry.verb == verb)
}

pub(super) fn cli_registry_entry_by_command(command: &str) -> Option<&'static CliActionRegistryEntry> {
    cli_action_registry_entries()
        .iter()
        .find(|entry| entry.command == command)
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
    if let Some(entry) = cli_registry_entry_by_verb(verb).filter(|entry| entry.command == "play") {
        return match args.get(pos + 2).map(|s| s.as_str()) {
            None => Some(PlayerCliCmd::NoArgCommand(entry.command.clone())),
            Some(flag) if flag.starts_with('-') => None,
            Some(extra) => {
                if extra.is_empty() {
                    return None;
                }
                Some(PlayerCliCmd::PlayOpaqueId(extra.to_string()))
            }
        };
    }
    match verb {
        "repeat" => {
            let m = parse_repeat_mode(args.get(pos + 2)?.as_str())?;
            Some(PlayerCliCmd::Repeat(m))
        }
        "rating" => {
            let raw = args.get(pos + 2)?;
            let n: u8 = raw.parse().ok()?;
            if n > 5 {
                return None;
            }
            Some(PlayerCliCmd::Rating { stars: n })
        }
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
        _ => cli_registry_entry_by_verb(verb)
            .map(|entry| PlayerCliCmd::NoArgCommand(entry.command.clone())),
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
