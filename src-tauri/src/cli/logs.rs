use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::time::Duration;

use super::parse::{logs_tail_lines, wants_follow};

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
