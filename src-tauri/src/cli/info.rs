use serde_json::Value;

use super::exchange::cli_snapshot_path;
#[cfg(target_os = "linux")]
use super::linux_forward::linux_is_primary_instance_running;
use super::parse::wants_info_json;
use super::presenters::print_info_human;

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
