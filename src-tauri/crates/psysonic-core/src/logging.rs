//! Runtime logging facade.
//!
//! Provides level-gated `eprintln!` macros (`app_eprintln!` / `app_deprintln!`)
//! that also append to a bounded in-memory ring buffer and a CLI-readable
//! per-runtime log file. Live mode toggling at runtime via
//! `set_logging_mode_from_str("off"|"normal"|"debug")`.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum LoggingMode {
    Off = 0,
    Normal = 1,
    Debug = 2,
}

static LOGGING_MODE: AtomicU8 = AtomicU8::new(LoggingMode::Normal as u8);
static PSYLAB_ALBUMS_BROWSE_TRACE: AtomicBool = AtomicBool::new(false);
static PSYLAB_ARTISTS_BROWSE_TRACE: AtomicBool = AtomicBool::new(false);
const LOG_BUFFER_MAX_LINES: usize = 20_000;

/// Monotonic sequence assigned to each appended line; lets the UI tail
/// incrementally (request only lines newer than the last seq it has seen).
static LOG_SEQ: AtomicU64 = AtomicU64::new(0);

/// A single buffered log line plus its monotonic sequence number.
#[derive(Clone, Debug)]
pub struct LogLine {
    pub seq: u64,
    pub text: String,
}

/// Result of an incremental tail request.
#[derive(Clone, Debug, Default)]
pub struct LogTail {
    pub lines: Vec<LogLine>,
    /// Sequence to pass back on the next request (highest seq known, even if no
    /// new lines were returned).
    pub last_seq: u64,
    /// True when the caller's `after_seq` predates the retained window, i.e. some
    /// lines were dropped from the ring buffer before they could be delivered.
    pub dropped: bool,
}

fn log_buffer() -> &'static Mutex<VecDeque<LogLine>> {
    static LOG_BUFFER: OnceLock<Mutex<VecDeque<LogLine>>> = OnceLock::new();
    LOG_BUFFER.get_or_init(|| Mutex::new(VecDeque::with_capacity(LOG_BUFFER_MAX_LINES)))
}

/// Shared runtime file used by CLI `--tail` to read normal/debug log channel.
pub fn cli_log_channel_path() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return std::path::PathBuf::from(dir).join("psysonic-cli.log");
        }
    }
    std::env::temp_dir().join("psysonic-cli.log")
}

fn parse_logging_mode(mode: &str) -> Option<LoggingMode> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "off" => Some(LoggingMode::Off),
        "normal" => Some(LoggingMode::Normal),
        "debug" => Some(LoggingMode::Debug),
        _ => None,
    }
}

pub fn set_logging_mode_from_str(mode: &str) -> Result<(), String> {
    let parsed = parse_logging_mode(mode)
        .ok_or_else(|| "invalid logging mode (expected: off | normal | debug)".to_string())?;
    LOGGING_MODE.store(parsed as u8, Ordering::Release);
    Ok(())
}

/// Current logging mode as a stable lowercase string for the UI.
pub fn current_mode_str() -> &'static str {
    match current_mode() {
        LoggingMode::Off => "off",
        LoggingMode::Normal => "normal",
        LoggingMode::Debug => "debug",
    }
}

fn current_mode() -> LoggingMode {
    match LOGGING_MODE.load(Ordering::Acquire) {
        0 => LoggingMode::Off,
        2 => LoggingMode::Debug,
        _ => LoggingMode::Normal,
    }
}

pub fn should_log_normal() -> bool {
    !matches!(current_mode(), LoggingMode::Off)
}

pub fn should_log_debug() -> bool {
    matches!(current_mode(), LoggingMode::Debug)
}

/// PsyLab → Toggles → Albums → Browse perf trace (frontend syncs via IPC).
pub fn set_psylab_albums_browse_trace(enabled: bool) {
    PSYLAB_ALBUMS_BROWSE_TRACE.store(enabled, Ordering::Relaxed);
}

pub fn should_log_albums_browse_trace() -> bool {
    should_log_debug() && PSYLAB_ALBUMS_BROWSE_TRACE.load(Ordering::Relaxed)
}

/// PsyLab → Toggles → Artists → Browse perf trace (frontend syncs via IPC).
pub fn set_psylab_artists_browse_trace(enabled: bool) {
    PSYLAB_ARTISTS_BROWSE_TRACE.store(enabled, Ordering::Relaxed);
}

pub fn should_log_artists_browse_trace() -> bool {
    should_log_debug() && PSYLAB_ARTISTS_BROWSE_TRACE.load(Ordering::Relaxed)
}

pub fn append_log_line(line: String) {
    let line = crate::log_sanitize::sanitize_log_line_infallible(&line);
    let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    {
        let mut buf = log_buffer().lock().unwrap();
        if buf.len() >= LOG_BUFFER_MAX_LINES {
            buf.pop_front();
        }
        buf.push_back(LogLine { seq, text: line.clone() });
    }
    let path = cli_log_channel_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", line);
    }
}

/// Return retained log lines with `seq > after_seq`, capped to `max` (most
/// recent kept). Pass `after_seq = None` to fetch the latest `max` lines.
pub fn tail_logs(after_seq: Option<u64>, max: usize) -> LogTail {
    let max = max.clamp(1, LOG_BUFFER_MAX_LINES);
    let buf = log_buffer().lock().unwrap();
    let last_seq = buf.back().map(|l| l.seq).unwrap_or(0);
    let earliest_seq = buf.front().map(|l| l.seq).unwrap_or(0);

    let after = after_seq.unwrap_or(0);
    // A gap occurred if the caller already saw `after` lines but the buffer no
    // longer holds the line right after it (it scrolled out of the window).
    let dropped = after_seq.is_some()
        && after > 0
        && earliest_seq > 0
        && after + 1 < earliest_seq;

    let mut lines: Vec<LogLine> = buf
        .iter()
        .filter(|l| l.seq > after)
        .cloned()
        .collect();
    if lines.len() > max {
        lines.drain(0..lines.len() - max);
    }

    LogTail { lines, last_seq, dropped }
}

pub fn export_logs_to_file(path: &str) -> Result<usize, String> {
    let snapshot = {
        let buf = log_buffer().lock().unwrap();
        if buf.is_empty() {
            String::new()
        } else {
            let mut s = buf.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join("\n");
            s.push('\n');
            s
        }
    };
    std::fs::write(path, snapshot).map_err(|e| e.to_string())?;
    let lines = {
        let buf = log_buffer().lock().unwrap();
        buf.len()
    };
    Ok(lines)
}

pub fn log_timestamp_local() -> String {
    let now = ::std::time::SystemTime::now()
        .duration_since(::std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.subsec_millis();

    #[cfg(unix)]
    {
        use std::ffi::CStr;
        let secs: libc::time_t = now.as_secs() as libc::time_t;
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        let mut date_buf: [libc::c_char; 64] = [0; 64];
        let mut tz_buf: [libc::c_char; 16] = [0; 16];
        let date_fmt = b"%Y-%m-%d %H:%M:%S\0";
        let tz_fmt = b"%z\0";

        unsafe {
            if libc::localtime_r(&secs as *const libc::time_t, &mut tm as *mut libc::tm).is_null() {
                return format!("{}.{:03}", now.as_secs(), millis);
            }
            let date_ok = libc::strftime(
                date_buf.as_mut_ptr(),
                date_buf.len(),
                date_fmt.as_ptr().cast(),
                &tm as *const libc::tm,
            );
            if date_ok == 0 {
                return format!("{}.{:03}", now.as_secs(), millis);
            }
            let tz_ok = libc::strftime(
                tz_buf.as_mut_ptr(),
                tz_buf.len(),
                tz_fmt.as_ptr().cast(),
                &tm as *const libc::tm,
            );

            let date = CStr::from_ptr(date_buf.as_ptr()).to_string_lossy();
            if tz_ok == 0 {
                return format!("{}.{:03}", date, millis);
            }
            let tz = CStr::from_ptr(tz_buf.as_ptr()).to_string_lossy();
            format!("{}.{:03} {}", date, millis, tz)
        }
    }

    #[cfg(not(unix))]
    {
        format!("{}.{:03}", now.as_secs(), millis)
    }
}

#[macro_export]
macro_rules! app_eprintln {
    () => {{
        if $crate::logging::should_log_normal() {
            let ts = $crate::logging::log_timestamp_local();
            let line = format!("[{}]", ts);
            $crate::logging::append_log_line(line.clone());
            ::std::eprintln!("{}", line);
        }
    }};
    ($($arg:tt)*) => {{
        if $crate::logging::should_log_normal() {
            let ts = $crate::logging::log_timestamp_local();
            let line = format!("[{}] {}", ts, format_args!($($arg)*));
            $crate::logging::append_log_line(line.clone());
            ::std::eprintln!("{}", line);
        }
    }};
}

#[macro_export]
macro_rules! app_deprintln {
    () => {{
        if $crate::logging::should_log_debug() {
            let ts = $crate::logging::log_timestamp_local();
            let line = format!("[{}]", ts);
            $crate::logging::append_log_line(line.clone());
            ::std::eprintln!("{}", line);
        }
    }};
    ($($arg:tt)*) => {{
        if $crate::logging::should_log_debug() {
            let ts = $crate::logging::log_timestamp_local();
            let line = format!("[{}] {}", ts, format_args!($($arg)*));
            $crate::logging::append_log_line(line.clone());
            ::std::eprintln!("{}", line);
        }
    }};
}
