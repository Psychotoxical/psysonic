use super::parse::cli_action_registry_entries;

pub fn print_version() {
    println!("{}", env!("CARGO_PKG_VERSION"));
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
    eprintln!(
        "  Reads a JSON file written by the running app. Open the main window at least once."
    );
    eprintln!("  {program} --info             Human-readable summary.");
    eprintln!("  {program} --info --json      One JSON object on stdout.");
    eprintln!("  Linux: exits with an error if the primary instance is not on the session D-Bus.");
    eprintln!("  Windows / macOS: no D-Bus check; an empty or missing file means the UI has not");
    eprintln!("  published a snapshot yet.\n");
    eprintln!("── Logs channel (normal + debug) ──");
    eprintln!("  {program} --logs                      Print recent log lines and exit.");
    eprintln!("  {program} --logs --tail <lines>       Print the last <lines> entries.");
    eprintln!("  {program} --logs --tail <lines> -f    Keep streaming new lines.\n");
    eprintln!("── Benchmark ──");
    eprintln!("  {program} benchmark run [--scenario all-pages|core-pages] [--runs 1-20]");
    eprintln!("      [--profile realistic|isolated] [--json]");
    eprintln!("  {program} benchmark latest [--json]\n");
    eprintln!("── Remote commands (--player …) ──");
    eprintln!("  Require the main Psysonic process. Same flags on Linux, Windows, and macOS.");
    eprintln!(
        "  Linux: a second CLI process can forward over D-Bus without opening another window."
    );
    eprintln!(
        "  Windows / macOS: handled via single-instance (a helper process may run briefly).\n"
    );
    eprintln!("  Global flags (place before --player when needed):");
    eprintln!("    --quiet | -q     Suppress \"OK: …\" lines (stderr errors are always shown).");
    eprintln!("    --json           With `audio-device list`, `library list`, `server list`, or `search`: JSON on stdout.");
    eprintln!("    Use  {program} -q --player seek -5  so the seek delta is not parsed as a flag.");
    eprintln!("         Same for relative volume:  {program} -q --player volume -5\n");
    eprintln!("  Playback");
    eprintln!("    {program} [--quiet|-q] --player <action>");
    for entry in cli_action_registry_entries() {
        eprintln!(
            "    {program} [--quiet|-q] --player {:<14} {}",
            entry.verb, entry.description
        );
    }
    eprintln!("    {program} [--quiet|-q] --player play <id>   Track, album, or artist id (artist → shuffled library).");
    eprintln!(
        "    {program} [--quiet|-q] --player seek <seconds>      Integer delta, e.g. 15 or -10"
    );
    eprintln!("    {program} [--quiet|-q] --player volume <0-100>     Absolute volume percent.");
    eprintln!("    {program} [--quiet|-q] --player volume <±N>       Relative change in percent, e.g. +5 or -10.");
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
