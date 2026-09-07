//! Desktop palette bridge — lets the app follow the colours the user's desktop
//! is already themed with, instead of asking them to keep two themes in sync.
//!
//! Many Linux desktop setups publish their active palette as a small flat file
//! (Omarchy's `colors.toml`, and anything a `pywal`/`matugen`/base16 hook can
//! write). This module reads that file, hands the frontend the raw key → colour
//! map, and re-emits it when the file changes, so switching the desktop theme
//! re-themes the app live. The mapping onto the app's theme tokens is the
//! frontend's job (`src/lib/themes/desktopPalette.ts`) — Rust stays a reader.
//!
//! The file is untrusted input from outside the app, so parsing is deliberately
//! narrow: a flat `key = value` grammar (no tables, no arrays, no includes),
//! size- and entry-capped, and every value kept must be a `#rrggbb`-style hex
//! colour. Anything else is skipped rather than surfaced.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::Emitter;

/// Palette files are a few hundred bytes; this only exists so a wrong path
/// (a log, a disk image) can't be pulled into memory.
const MAX_PALETTE_BYTES: u64 = 64 * 1024;
/// A generous ceiling on named colours — stock palettes define ~25.
const MAX_ENTRIES: usize = 128;
/// Longest accepted theme name, in bytes.
const MAX_NAME_BYTES: usize = 64;
/// How often the watcher stats the palette file. Only a `stat` at this cadence;
/// the file is re-read and re-parsed solely when mtime or size moved.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Emitted with a [`DesktopPalette`] payload whenever the file's contents change.
const PALETTE_CHANGED_EVENT: &str = "desktop-palette:changed";

/// The desktop's active palette, as read off disk.
#[derive(Serialize, specta::Type, Clone, PartialEq, Eq, Debug)]
pub struct DesktopPalette {
    /// Absolute path the palette was read from — shown in settings so the user
    /// can see which file is driving the theme.
    pub source: String,
    /// Human-readable name of the desktop theme, when the source publishes one.
    pub name: Option<String>,
    /// `"dark"` or `"light"` when the source declares it; `None` otherwise.
    pub mode: Option<String>,
    /// Colour name → `#rrggbb`. Keys are lowercased verbatim from the file, so
    /// the frontend can map whatever vocabulary a given desktop uses.
    pub colors: BTreeMap<String, String>,
}

/// Where to look for the palette.
///
/// `PSYSONIC_PALETTE_FILE` is the portable escape hatch — point it at any file
/// in the supported grammar and the app follows it. With it unset, the default
/// is Omarchy's staged theme, which is the setup this shipped for. A missing
/// file is not an error anywhere: the feature is simply inactive.
fn palette_path() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("PSYSONIC_PALETTE_FILE") {
        let path = PathBuf::from(raw);
        return (!path.as_os_str().is_empty()).then_some(path);
    }
    // No HOME (Windows) means no default location — the env var still works.
    let state = match std::env::var_os("XDG_STATE_HOME").map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => dir,
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".local/state"),
    };
    Some(state.join("omarchy/current/theme/colors.toml"))
}

/// One `key = value` pair per line. Blank lines, `#` comments and `[table]`
/// headers are skipped; so is any line this grammar doesn't recognise.
fn parse_entries(text: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    for line in text.lines() {
        if entries.len() >= MAX_ENTRIES {
            break;
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            continue;
        }
        let Some(value) = parse_value(value.trim()) else {
            continue;
        };
        entries.push((key.to_ascii_lowercase(), value));
    }
    entries
}

/// A quoted string, or a bare token up to the first whitespace. Note that a
/// trailing comment needs the space: `#rrggbb` is itself a value, so `#` can
/// only start a comment at the beginning of a line.
fn parse_value(raw: &str) -> Option<String> {
    let quote = raw.chars().next()?;
    if quote == '"' || quote == '\'' {
        let rest = raw.get(1..)?;
        let end = rest.find(quote)?;
        return Some(rest[..end].to_string());
    }
    let end = raw.find(char::is_whitespace).unwrap_or(raw.len());
    let token = &raw[..end];
    (!token.is_empty()).then(|| token.to_string())
}

/// `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, lowercased. Anything else is not
/// a colour and is dropped — this is what keeps arbitrary file contents from
/// reaching the CSS the frontend builds.
fn normalize_color(value: &str) -> Option<String> {
    let hex = value.strip_prefix('#')?;
    if !matches!(hex.len(), 3 | 4 | 6 | 8) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", hex.to_ascii_lowercase()))
}

/// Omarchy stages the palette at `…/current/theme/colors.toml` and writes the
/// theme's display name beside that directory. A palette that carries its own
/// `name = "…"` key takes precedence and never reaches this.
fn read_theme_name(palette: &Path) -> Option<String> {
    let sibling = palette.parent()?.parent()?.join("theme.name");
    let raw = std::fs::read_to_string(sibling).ok()?;
    let name = raw.trim();
    (!name.is_empty() && name.len() <= MAX_NAME_BYTES).then(|| name.to_string())
}

/// Read and parse one palette file. `Ok(None)` means "nothing usable here"
/// (absent, not a file, or no colours in it) — the common case on a machine
/// with no such desktop integration, and not something to report as an error.
pub fn read_palette_at(path: &Path) -> Result<Option<DesktopPalette>, String> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(None);
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_PALETTE_BYTES {
        return Err(format!(
            "palette file is too large (> {} KB)",
            MAX_PALETTE_BYTES / 1024
        ));
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read palette: {e}"))?;

    let mut colors = BTreeMap::new();
    let mut mode = None;
    let mut name = None;
    for (key, value) in parse_entries(&text) {
        match key.as_str() {
            "mode" => {
                let value = value.to_ascii_lowercase();
                if value == "dark" || value == "light" {
                    mode = Some(value);
                }
            }
            "name" if value.len() <= MAX_NAME_BYTES => name = Some(value),
            _ => {
                if let Some(color) = normalize_color(&value) {
                    colors.insert(key, color);
                }
            }
        }
    }
    if colors.is_empty() {
        return Ok(None);
    }

    Ok(Some(DesktopPalette {
        source: path.to_string_lossy().into_owned(),
        name: name.or_else(|| read_theme_name(path)),
        mode,
        colors,
    }))
}

/// Current desktop palette, or `None` when this machine publishes none.
#[tauri::command]
#[specta::specta]
pub fn read_desktop_palette() -> Result<Option<DesktopPalette>, String> {
    match palette_path() {
        Some(path) => read_palette_at(&path),
        None => Ok(None),
    }
}

/// Watch the palette file and emit [`PALETTE_CHANGED_EVENT`] when its colours
/// change, so switching the desktop theme re-themes a running app.
///
/// No-op unless a palette file already exists at startup, so the overwhelming
/// majority of installs never spawn the thread. Polls rather than taking a
/// filesystem-notification dependency: the desktop theme changes at human
/// speed, and a `stat` every few seconds is cheaper than the crate would be.
/// Consistent with the existing `startup::theme_watch` poller.
pub(crate) fn setup(app: &tauri::App) {
    let Some(path) = palette_path() else { return };
    if !path.is_file() {
        return;
    }
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        type Stamp = Option<(Option<SystemTime>, u64)>;
        let stamp = |path: &Path| -> Stamp {
            std::fs::metadata(path)
                .ok()
                .map(|m| (m.modified().ok(), m.len()))
        };
        let mut last_stamp = stamp(&path);
        let mut last = read_palette_at(&path).ok().flatten();
        loop {
            std::thread::sleep(POLL_INTERVAL);
            let current_stamp = stamp(&path);
            if current_stamp == last_stamp {
                continue;
            }
            last_stamp = current_stamp;
            // A theme switch rewrites the file; a read landing mid-write just
            // parses to something else and settles on the next tick.
            let Ok(current) = read_palette_at(&path) else {
                continue;
            };
            if current == last {
                continue;
            }
            if let Some(palette) = &current {
                let _ = handle.emit(PALETTE_CHANGED_EVENT, palette);
            }
            last = current;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A palette in the shape this reads: a comment, `mode`, then flat colours.
    // `r##` rather than `r#`: the values contain `"#`, which would close a
    // single-hash raw string mid-colour.
    const SAMPLE: &str = r##"
# A desktop theme generator wrote this file.
mode = "dark"

accent = "#4c6ef5"
background = "#101014"
foreground = "#e6e6ec"
BRIGHT_RED = "#ff6b6b"
"##;

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("psysonic-palette-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_a_flat_palette_file() {
        let dir = tmpdir("flat");
        let path = write(&dir, "colors.toml", SAMPLE);
        let palette = read_palette_at(&path).unwrap().expect("palette");

        assert_eq!(palette.mode.as_deref(), Some("dark"));
        assert_eq!(palette.colors["accent"], "#4c6ef5");
        assert_eq!(palette.colors["background"], "#101014");
        // Keys are lowercased so the frontend can look them up by one spelling.
        assert_eq!(palette.colors["bright_red"], "#ff6b6b");
        // The comment line and the `mode` string never become colours.
        assert!(!palette.colors.contains_key("mode"));
        assert_eq!(palette.colors.len(), 4);
    }

    #[test]
    fn takes_the_theme_name_from_the_parent_directory() {
        let root = tmpdir("named");
        let theme = root.join("theme");
        std::fs::create_dir_all(&theme).unwrap();
        std::fs::write(root.join("theme.name"), "Example Theme\n").unwrap();
        let path = write(&theme, "colors.toml", SAMPLE);

        assert_eq!(
            read_palette_at(&path).unwrap().unwrap().name.as_deref(),
            Some("Example Theme")
        );
    }

    #[test]
    fn an_inline_name_key_wins_over_the_sibling_file() {
        let root = tmpdir("inline-name");
        let theme = root.join("theme");
        std::fs::create_dir_all(&theme).unwrap();
        std::fs::write(root.join("theme.name"), "Ignored").unwrap();
        let path = write(
            &theme,
            "colors.toml",
            "name = \"Solarized\"\naccent = \"#268bd2\"\n",
        );

        assert_eq!(
            read_palette_at(&path).unwrap().unwrap().name.as_deref(),
            Some("Solarized")
        );
    }

    #[test]
    fn keeps_only_hex_colours() {
        let dir = tmpdir("hostile");
        let path = write(
            &dir,
            "colors.toml",
            concat!(
                "accent = \"#abc\"\n",
                // Everything below is not a colour and must not reach the frontend,
                // where these values are interpolated into CSS.
                "font = \"Comic Sans\"\n",
                "evil = \"red; } :root { display: none\"\n",
                "url = \"url(https://example.com/x.png)\"\n",
                "notquite = \"#12345\"\n",
                "nothex = \"#gggggg\"\n",
                "[table]\n",
                "bare_line_without_equals\n",
            ),
        );
        let palette = read_palette_at(&path).unwrap().unwrap();

        assert_eq!(palette.colors.len(), 1);
        assert_eq!(palette.colors["accent"], "#abc");
    }

    #[test]
    fn accepts_bare_and_single_quoted_values() {
        let dir = tmpdir("quoting");
        let path = write(
            &dir,
            "colors.toml",
            "accent = #FF0000\nbackground = '#00ff00'\nmuted = #0000ff  # trailing note\n",
        );
        let palette = read_palette_at(&path).unwrap().unwrap();

        // Hex is normalised to lowercase so equal colours compare equal.
        assert_eq!(palette.colors["accent"], "#ff0000");
        assert_eq!(palette.colors["background"], "#00ff00");
        assert_eq!(palette.colors["muted"], "#0000ff");
    }

    #[test]
    fn missing_or_colourless_files_are_not_errors() {
        let dir = tmpdir("empty");
        assert_eq!(read_palette_at(&dir.join("absent.toml")).unwrap(), None);
        // A directory is not a palette.
        assert_eq!(read_palette_at(&dir).unwrap(), None);
        let path = write(
            &dir,
            "colorless.toml",
            "mode = \"dark\"\nfont = \"Inter\"\n",
        );
        assert_eq!(read_palette_at(&path).unwrap(), None);
    }

    #[test]
    fn oversized_files_are_rejected() {
        let dir = tmpdir("oversized");
        let path = write(
            &dir,
            "huge.toml",
            &"x".repeat(MAX_PALETTE_BYTES as usize + 1),
        );
        assert!(read_palette_at(&path).is_err());
    }

    #[test]
    fn entry_count_is_capped() {
        let body: String = (0..MAX_ENTRIES + 50)
            .map(|i| format!("c{i} = \"#010203\"\n"))
            .collect();
        assert_eq!(parse_entries(&body).len(), MAX_ENTRIES);
    }
}
