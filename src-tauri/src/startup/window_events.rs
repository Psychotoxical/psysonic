use tauri::{Emitter, Manager};

use crate::lib_commands::{
    persist_mini_pos_throttled, run_native_lifecycle_fallback, LifecycleRequest,
    MainWindowLifecycleState, PendingLifecycleAction, PAUSE_RENDERING_JS,
};

pub(crate) fn handle(window: &tauri::Window, event: &tauri::WindowEvent) {
    // Persist mini player position whenever the user drags it.
    if window.label() == "mini" {
        if let tauri::WindowEvent::Moved(pos) = event {
            persist_mini_pos_throttled(window.app_handle(), pos.x, pos.y);
        }
    }

    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" {
            api.prevent_close();
            match window.state::<MainWindowLifecycleState>().request_close() {
                LifecycleRequest::Queued => {}
                LifecycleRequest::EmitClose { transition } => {
                    if window.emit("window:close-requested", transition).is_err() {
                        let request = window
                            .state::<MainWindowLifecycleState>()
                            .native_request_after_emit_failure(PendingLifecycleAction::Close {
                                transition,
                            });
                        let _ = run_native_lifecycle_fallback(request, window.app_handle().clone());
                    }
                }
                LifecycleRequest::EmitForceQuit => {}
                request @ (LifecycleRequest::NativeHide | LifecycleRequest::NativeExit) => {
                    let _ = run_native_lifecycle_fallback(request, window.app_handle().clone());
                }
            }
        } else if window.label() == "mini" {
            api.prevent_close();
            if let Some(w) = window.app_handle().get_webview_window("mini") {
                let _ = w.eval(PAUSE_RENDERING_JS);
            }
            let _ = window.hide();
            if let Some(main) = window.app_handle().get_webview_window("main") {
                let _ = crate::lib_commands::ui::mini::restore_main_window(&main);
            }
        }
    }
}
