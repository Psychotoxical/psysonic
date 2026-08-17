use std::sync::Mutex;

use tauri::Manager;

use crate::lib_commands::ui::{PAUSE_RENDERING_JS, RESUME_RENDERING_JS};

#[derive(Default)]
struct MainWindowLifecycleInner {
    generation: u64,
    registration_attempt: u64,
    frontend_ready: bool,
    close_pending: bool,
    force_quit_pending: bool,
    native_fallback_minimize_to_tray: Option<bool>,
    last_minimize_to_tray: bool,
    frontend_decorations_claimed: bool,
    decoration_transition: u64,
    visibility_transition: u64,
    startup_visibility_pending: bool,
}

#[derive(Default)]
pub(crate) struct MainWindowLifecycleState {
    inner: Mutex<MainWindowLifecycleInner>,
    decoration_operation: Mutex<()>,
    visibility_operation: Mutex<()>,
}

#[derive(Clone, Copy)]
pub(crate) enum PendingLifecycleAction {
    Close { transition: u64 },
    ForceQuit,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LifecycleRequest {
    Queued,
    EmitClose { transition: u64 },
    EmitForceQuit,
    NativeHide,
    NativeExit,
}

impl MainWindowLifecycleState {
    pub(crate) fn mark_frontend_loading(&self) {
        let _operation = self
            .visibility_operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.registration_attempt = 0;
        state.frontend_ready = false;
        state.native_fallback_minimize_to_tray = None;
        state.frontend_decorations_claimed = false;
        state.decoration_transition = 0;
        state.visibility_transition = state.visibility_transition.wrapping_add(1);
        state.startup_visibility_pending = true;
    }

    pub(super) fn generation(&self) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .generation
    }

    pub(super) fn begin_frontend_registration(&self, generation: u64, attempt: u64) -> bool {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.generation != generation || attempt <= state.registration_attempt {
            return false;
        }
        state.registration_attempt = attempt;
        state.frontend_ready = false;
        state.native_fallback_minimize_to_tray = None;
        true
    }

    pub(crate) fn request_close(&self) -> LifecycleRequest {
        let _operation = self
            .visibility_operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.startup_visibility_pending = false;
        if state.frontend_ready {
            state.visibility_transition = state.visibility_transition.wrapping_add(1);
            LifecycleRequest::EmitClose {
                transition: state.visibility_transition,
            }
        } else if let Some(minimize_to_tray) = state.native_fallback_minimize_to_tray {
            if minimize_to_tray {
                LifecycleRequest::NativeHide
            } else {
                LifecycleRequest::NativeExit
            }
        } else {
            state.close_pending = true;
            LifecycleRequest::Queued
        }
    }

    pub(crate) fn request_force_quit(&self) -> LifecycleRequest {
        let _operation = self
            .visibility_operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.startup_visibility_pending = false;
        if state.frontend_ready {
            LifecycleRequest::EmitForceQuit
        } else if state.native_fallback_minimize_to_tray.is_some() {
            LifecycleRequest::NativeExit
        } else {
            state.force_quit_pending = true;
            state.close_pending = false;
            LifecycleRequest::Queued
        }
    }

    pub(super) fn enable_native_fallback(
        &self,
        generation: u64,
        attempt: u64,
        minimize_to_tray: bool,
    ) -> Result<Option<LifecycleRequest>, String> {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.generation != generation || attempt < state.registration_attempt {
            return Err("stale window lifecycle fallback".to_string());
        }
        state.registration_attempt = attempt;
        state.frontend_ready = false;
        state.last_minimize_to_tray = minimize_to_tray;
        state.native_fallback_minimize_to_tray = Some(minimize_to_tray);
        if std::mem::take(&mut state.force_quit_pending) {
            state.close_pending = false;
            Ok(Some(LifecycleRequest::NativeExit))
        } else if std::mem::take(&mut state.close_pending) {
            Ok(Some(if minimize_to_tray {
                LifecycleRequest::NativeHide
            } else {
                LifecycleRequest::NativeExit
            }))
        } else {
            Ok(None)
        }
    }

    pub(super) fn update_native_fallback_policy(&self, generation: u64, minimize_to_tray: bool) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.generation == generation {
            state.last_minimize_to_tray = minimize_to_tray;
            if state.native_fallback_minimize_to_tray.is_some() {
                state.native_fallback_minimize_to_tray = Some(minimize_to_tray);
            }
        }
    }

    pub(super) fn mark_frontend_ready(
        &self,
        generation: u64,
        attempt: u64,
        minimize_to_tray: bool,
    ) -> Option<PendingLifecycleAction> {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.generation != generation
            || state.registration_attempt != attempt
            || state.native_fallback_minimize_to_tray.is_some()
        {
            return None;
        }
        state.frontend_ready = true;
        state.native_fallback_minimize_to_tray = None;
        state.last_minimize_to_tray = minimize_to_tray;
        if std::mem::take(&mut state.force_quit_pending) {
            state.close_pending = false;
            Some(PendingLifecycleAction::ForceQuit)
        } else if std::mem::take(&mut state.close_pending) {
            state.visibility_transition = state.visibility_transition.wrapping_add(1);
            Some(PendingLifecycleAction::Close {
                transition: state.visibility_transition,
            })
        } else {
            None
        }
    }

    pub(crate) fn native_request_after_emit_failure(
        &self,
        action: PendingLifecycleAction,
    ) -> LifecycleRequest {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match action {
            PendingLifecycleAction::Close { .. } if state.last_minimize_to_tray => {
                LifecycleRequest::NativeHide
            }
            PendingLifecycleAction::Close { .. } | PendingLifecycleAction::ForceQuit => {
                LifecycleRequest::NativeExit
            }
        }
    }

    pub(crate) fn apply_frontend_visibility<T>(
        &self,
        generation: u64,
        transition: u64,
        apply: impl FnOnce() -> T,
    ) -> Option<T> {
        let _operation = self
            .visibility_operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let mut state = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.generation != generation || state.visibility_transition != transition {
                return None;
            }
            state.startup_visibility_pending = false;
        }
        Some(apply())
    }

    pub(crate) fn apply_startup_visibility<T, E>(
        &self,
        generation: u64,
        apply: impl FnOnce() -> Result<T, E>,
    ) -> Result<Option<T>, E> {
        let _operation = self
            .visibility_operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let state = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.generation != generation || !state.startup_visibility_pending {
                return Ok(None);
            }
        }
        let value = apply()?;
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.generation == generation {
            state.startup_visibility_pending = false;
        }
        Ok(Some(value))
    }

    pub(crate) fn apply_native_visibility<T>(
        &self,
        supersede_pending_close: bool,
        apply: impl FnOnce() -> T,
    ) -> T {
        let _operation = self
            .visibility_operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let mut state = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.visibility_transition = state.visibility_transition.wrapping_add(1);
            state.startup_visibility_pending = false;
            if supersede_pending_close {
                state.close_pending = false;
            }
        }
        apply()
    }

    #[cfg(any(target_os = "linux", test))]
    pub(crate) fn apply_startup_decorations<T>(
        &self,
        generation: u64,
        apply: impl FnOnce() -> T,
    ) -> Option<T> {
        let _operation = self
            .decoration_operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let state = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.generation != generation || state.frontend_decorations_claimed {
                return None;
            }
        }
        Some(apply())
    }

    pub(crate) fn apply_frontend_decorations<T>(
        &self,
        generation: u64,
        transition: u64,
        apply: impl FnOnce() -> T,
    ) -> Option<T> {
        let _operation = self
            .decoration_operation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            let mut state = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if state.generation != generation || transition <= state.decoration_transition {
                return None;
            }
            state.decoration_transition = transition;
            state.frontend_decorations_claimed = true;
        }
        Some(apply())
    }
}

pub(crate) fn run_native_lifecycle_fallback(
    request: LifecycleRequest,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    match request {
        LifecycleRequest::NativeHide => {
            if let Some(window) = app_handle.get_webview_window("main") {
                app_handle
                    .state::<MainWindowLifecycleState>()
                    .apply_native_visibility(false, || {
                        let _ = window.eval(PAUSE_RENDERING_JS);
                        if let Err(error) = window.hide() {
                            let _ = window.eval(RESUME_RENDERING_JS);
                            return Err(error.to_string());
                        }
                        Ok(())
                    })?;
            }
        }
        LifecycleRequest::NativeExit => super::exit_app(app_handle),
        LifecycleRequest::Queued
        | LifecycleRequest::EmitClose { .. }
        | LifecycleRequest::EmitForceQuit => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests;
