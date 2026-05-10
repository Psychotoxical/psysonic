//! Runtime logging facade.
//!
//! Provides level-gated `eprintln!` macros (`app_eprintln!` / `app_deprintln!`)
//! that also append to a bounded in-memory ring buffer and a CLI-readable
//! per-runtime log file. Live mode toggling at runtime via
//! `set_logging_mode_from_str("off"|"normal"|"debug")`.

use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum LoggingMode {
    Off = 0,
    Normal = 1,
    Debug = 2,
}

static LOGGING_MODE: AtomicU8 = AtomicU8::new(LoggingMode::Normal as u8);
const LOG_BUFFER_MAX_LINES: usize = 20_000;

fn log_buffer() -> &'static Mutex<VecDeque<String>> {
    static LOG_BUFFER: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
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

pub fn append_log_line(line: String) {
    let mut buf = log_buffer().lock().unwrap();
    if buf.len() >= LOG_BUFFER_MAX_LINES {
        buf.pop_front();
    }
    buf.push_back(line.clone());
    drop(buf);
    let path = cli_log_channel_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{}", line);
    }
}

pub fn export_logs_to_file(path: &str) -> Result<usize, String> {
    let snapshot = {
        let buf = log_buffer().lock().unwrap();
        if buf.is_empty() {
            String::new()
        } else {
            let mut s = buf.iter().cloned().collect::<Vec<_>>().join("\n");
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
