//! Linux: subscribe to logind `PrepareForSleep` on the system bus — `start == false` means resume
//! completed (systemd says the boolean is true when going to sleep, false when waking).

use tauri::AppHandle;

use super::power_resume::{debounce_allow_resume_reopen, reopen_audio_after_system_resume};

pub fn register(app: AppHandle) {
    let res = std::thread::Builder::new()
        .name("psysonic-logind-sleep".into())
        .spawn(move || run_listener(app));

    if let Err(e) = res {
        crate::app_eprintln!("[psysonic] could not spawn logind listener: {e}");
    }
}

fn run_listener(app: AppHandle) {
    use zbus::blocking::{Connection, MessageIterator};
    use zbus::message::Type;
    use zbus::MatchRule;

    let conn = match Connection::system() {
        Ok(c) => c,
        Err(e) => {
            crate::app_eprintln!(
                "[psysonic] D-Bus system bus unavailable — post-sleep audio recovery disabled: {e}"
            );
            return;
        }
    };

    let rule: zbus::MatchRule = match (|| -> zbus::Result<_> {
        Ok(MatchRule::builder()
            .msg_type(Type::Signal)
            .path("/org/freedesktop/login1")?
            .interface("org.freedesktop.login1.Manager")?
            .member("PrepareForSleep")?
            .build())
    })() {
        Ok(r) => r,
        Err(e) => {
            crate::app_eprintln!(
                "[psysonic] MatchRule for logind PrepareForSleep failed: {e}"
            );
            return;
        }
    };

    let mut iter = match MessageIterator::for_match_rule(rule, &conn, Some(32)) {
        Ok(i) => i,
        Err(e) => {
            crate::app_eprintln!("[psysonic] logind signal subscription failed: {e}");
            return;
        }
    };

    crate::app_eprintln!("[psysonic] logind PrepareForSleep listener registered (post-sleep audio recovery)");

    loop {
        let Some(result) = iter.next() else {
            break;
        };
        let msg = match result {
            Ok(m) => m,
            Err(e) => {
                crate::app_eprintln!("[psysonic] logind message stream error: {e}");
                break;
            }
        };

        let start: bool = match msg.body().deserialize() {
            Ok(b) => b,
            Err(_) => continue,
        };

        if start {
            continue;
        }

        if !debounce_allow_resume_reopen() {
            continue;
        }

        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            reopen_audio_after_system_resume(&app).await;
        });
    }
}
