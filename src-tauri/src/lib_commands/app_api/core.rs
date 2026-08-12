use std::sync::Mutex;

use tauri::{Emitter, Manager};

use crate::analysis_cache;
use crate::lib_commands::sync::stop_audio_engine;
use crate::lib_commands::ui::{PAUSE_RENDERING_JS, RESUME_RENDERING_JS};
use crate::runtime_subsonic_wire_user_agent;

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

    fn generation(&self) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .generation
    }

    fn begin_frontend_registration(&self, generation: u64, attempt: u64) -> bool {
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

    fn enable_native_fallback(
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

    fn update_native_fallback_policy(&self, generation: u64, minimize_to_tray: bool) {
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

    fn mark_frontend_ready(
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
        LifecycleRequest::NativeExit => exit_app(app_handle),
        LifecycleRequest::Queued
        | LifecycleRequest::EmitClose { .. }
        | LifecycleRequest::EmitForceQuit => {}
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_generation(
    state: tauri::State<'_, MainWindowLifecycleState>,
) -> u64 {
    state.generation()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_begin(
    generation: u64,
    attempt: u64,
    state: tauri::State<'_, MainWindowLifecycleState>,
) -> Result<(), String> {
    state
        .begin_frontend_registration(generation, attempt)
        .then_some(())
        .ok_or_else(|| "stale window lifecycle registration".to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_ready(
    generation: u64,
    attempt: u64,
    minimize_to_tray: bool,
    state: tauri::State<'_, MainWindowLifecycleState>,
    app_handle: tauri::AppHandle,
) {
    if let Some(action) = state.mark_frontend_ready(generation, attempt, minimize_to_tray) {
        let emitted = app_handle
            .get_webview_window("main")
            .ok_or(())
            .and_then(|window| match action {
                PendingLifecycleAction::Close { transition } => window
                    .emit("window:close-requested", transition)
                    .map_err(|_| ()),
                PendingLifecycleAction::ForceQuit => {
                    window.emit("app:force-quit", ()).map_err(|_| ())
                }
            });
        if emitted.is_err() {
            let request = state.native_request_after_emit_failure(action);
            let _ = run_native_lifecycle_fallback(request, app_handle);
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_hide(
    generation: u64,
    transition: u64,
    state: tauri::State<'_, MainWindowLifecycleState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let Some(window) = app_handle.get_webview_window("main") else {
        return Ok(false);
    };
    match state.apply_frontend_visibility(generation, transition, || {
        let _ = window.eval(PAUSE_RENDERING_JS);
        if let Err(error) = window.hide() {
            let _ = window.eval(RESUME_RENDERING_JS);
            return Err(error.to_string());
        }
        Ok(())
    }) {
        Some(result) => result.map(|()| true),
        None => Ok(false),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_startup_visibility(
    hidden: bool,
    generation: u64,
    state: tauri::State<'_, MainWindowLifecycleState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let Some(window) = app_handle.get_webview_window("main") else {
        return Ok(false);
    };
    state
        .apply_startup_visibility(generation, || {
            if hidden {
                window.hide()
            } else {
                window.show()
            }
            .map_err(|error| error.to_string())
        })
        .map(|result| result.is_some())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_fallback(
    generation: u64,
    attempt: u64,
    minimize_to_tray: bool,
    state: tauri::State<'_, MainWindowLifecycleState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if let Some(request) = state.enable_native_fallback(generation, attempt, minimize_to_tray)? {
        run_native_lifecycle_fallback(request, app_handle)?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_update_fallback_policy(
    generation: u64,
    minimize_to_tray: bool,
    state: tauri::State<'_, MainWindowLifecycleState>,
) {
    state.update_native_fallback_policy(generation, minimize_to_tray);
}

#[tauri::command]
#[specta::specta]
pub(crate) fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn exit_app(app_handle: tauri::AppHandle) {
    if let Some(cache) = app_handle.try_state::<analysis_cache::AnalysisCache>() {
        let _ = cache.checkpoint_wal("exit");
    }
    stop_audio_engine(&app_handle);
    app_handle.exit(0);
}

#[cfg(test)]
mod tests {
    use super::MainWindowLifecycleState;

    #[test]
    fn close_is_queued_until_the_frontend_is_ready() {
        let state = MainWindowLifecycleState::default();
        let generation = state.generation();
        assert!(state.begin_frontend_registration(generation, 1));

        assert_eq!(state.request_close(), super::LifecycleRequest::Queued);
        assert!(matches!(
            state.mark_frontend_ready(generation, 1, false),
            Some(super::PendingLifecycleAction::Close { .. })
        ));
        assert!(state.mark_frontend_ready(generation, 1, false).is_none());
        assert!(matches!(
            state.request_close(),
            super::LifecycleRequest::EmitClose { .. }
        ));
    }

    #[test]
    fn repeated_early_close_requests_coalesce() {
        let state = MainWindowLifecycleState::default();
        let generation = state.generation();
        assert!(state.begin_frontend_registration(generation, 1));

        assert_eq!(state.request_close(), super::LifecycleRequest::Queued);
        assert_eq!(state.request_close(), super::LifecycleRequest::Queued);
        assert!(matches!(
            state.mark_frontend_ready(generation, 1, false),
            Some(super::PendingLifecycleAction::Close { .. })
        ));
        assert!(state.mark_frontend_ready(generation, 1, false).is_none());
    }

    #[test]
    fn force_quit_takes_priority_over_an_early_close() {
        let state = MainWindowLifecycleState::default();
        let generation = state.generation();
        assert!(state.begin_frontend_registration(generation, 1));

        assert_eq!(state.request_close(), super::LifecycleRequest::Queued);
        assert_eq!(
            state.request_force_quit(),
            super::LifecycleRequest::Queued
        );
        assert!(matches!(
            state.mark_frontend_ready(generation, 1, false),
            Some(super::PendingLifecycleAction::ForceQuit)
        ));
        assert!(state.mark_frontend_ready(generation, 1, false).is_none());
    }

    #[test]
    fn page_load_resets_readiness_without_dropping_future_closes() {
        let state = MainWindowLifecycleState::default();
        let first_generation = state.generation();
        assert!(state.begin_frontend_registration(first_generation, 1));

        assert!(state
            .mark_frontend_ready(first_generation, 1, false)
            .is_none());
        assert!(matches!(
            state.request_close(),
            super::LifecycleRequest::EmitClose { .. }
        ));
        state.mark_frontend_loading();
        let second_generation = state.generation();
        assert!(state.begin_frontend_registration(second_generation, 1));
        assert_eq!(state.request_close(), super::LifecycleRequest::Queued);
        assert!(state
            .mark_frontend_ready(first_generation, 1, false)
            .is_none());
        assert!(matches!(
            state.mark_frontend_ready(second_generation, 1, false),
            Some(super::PendingLifecycleAction::Close { .. })
        ));
    }

    #[test]
    fn failed_delivery_uses_the_last_known_native_policy() {
        let state = MainWindowLifecycleState::default();
        let generation = state.generation();
        assert!(state.begin_frontend_registration(generation, 1));

        assert_eq!(
            state.request_force_quit(),
            super::LifecycleRequest::Queued
        );
        let action = state
            .mark_frontend_ready(generation, 1, true)
            .expect("queued force quit");
        assert_eq!(
            state.native_request_after_emit_failure(action),
            super::LifecycleRequest::NativeExit
        );
        assert_eq!(
            state.native_request_after_emit_failure(super::PendingLifecycleAction::Close {
                transition: 1,
            }),
            super::LifecycleRequest::NativeHide
        );
    }

    #[test]
    fn native_fallback_uses_the_last_known_close_policy() {
        let state = MainWindowLifecycleState::default();
        let generation = state.generation();
        assert!(state.begin_frontend_registration(generation, 1));
        state.update_native_fallback_policy(generation, true);

        assert!(state
            .enable_native_fallback(generation, 1, true)
            .expect("current fallback")
            .is_none());
        assert_eq!(state.request_close(), super::LifecycleRequest::NativeHide);
        assert_eq!(
            state.request_force_quit(),
            super::LifecycleRequest::NativeExit
        );
    }

    #[test]
    fn late_readiness_cannot_override_native_fallback() {
        let state = MainWindowLifecycleState::default();
        let generation = state.generation();
        assert!(state.begin_frontend_registration(generation, 1));
        state.update_native_fallback_policy(generation, true);
        assert!(state
            .enable_native_fallback(generation, 2, true)
            .expect("current fallback")
            .is_none());

        assert!(!state.begin_frontend_registration(generation, 1));
        assert!(state.mark_frontend_ready(generation, 1, true).is_none());
        assert_eq!(state.request_close(), super::LifecycleRequest::NativeHide);
    }

    #[test]
    fn stale_attempts_and_generations_cannot_replace_a_ready_contract() {
        let state = MainWindowLifecycleState::default();
        let first_generation = state.generation();
        assert!(state.begin_frontend_registration(first_generation, 1));
        assert!(state.begin_frontend_registration(first_generation, 2));
        assert!(!state.begin_frontend_registration(first_generation, 1));
        assert!(state
            .mark_frontend_ready(first_generation, 1, false)
            .is_none());
        assert!(state
            .mark_frontend_ready(first_generation, 2, false)
            .is_none());

        state.mark_frontend_loading();
        let second_generation = state.generation();
        assert!(state.begin_frontend_registration(second_generation, 1));
        assert!(state
            .mark_frontend_ready(second_generation, 1, false)
            .is_none());
        assert!(state
            .enable_native_fallback(first_generation, 2, false)
            .is_err());
        assert!(matches!(
            state.request_close(),
            super::LifecycleRequest::EmitClose { .. }
        ));
    }

    #[test]
    fn fallback_policy_updates_only_for_the_active_generation() {
        let state = MainWindowLifecycleState::default();
        let generation = state.generation();
        assert!(state.begin_frontend_registration(generation, 1));
        state.update_native_fallback_policy(generation, true);
        assert!(state
            .enable_native_fallback(generation, 1, true)
            .expect("current fallback")
            .is_none());

        state.update_native_fallback_policy(generation, false);
        assert_eq!(state.request_close(), super::LifecycleRequest::NativeExit);
    }

    #[test]
    fn native_visibility_change_invalidates_a_frontend_hide_transition() {
        let state = MainWindowLifecycleState::default();
        let generation = state.generation();
        assert!(state.begin_frontend_registration(generation, 1));
        assert!(state.mark_frontend_ready(generation, 1, true).is_none());
        let transition = match state.request_close() {
            super::LifecycleRequest::EmitClose { transition } => transition,
            request => panic!("expected close event, got {request:?}"),
        };

        assert_eq!(
            state.apply_frontend_visibility(generation, transition, || 1),
            Some(1)
        );
        state.apply_native_visibility(false, || ());
        assert!(state
            .apply_frontend_visibility(generation, transition, || 2)
            .is_none());
    }

    #[test]
    fn startup_visibility_is_single_use_and_retries_only_after_failure() {
        let state = MainWindowLifecycleState::default();
        state.mark_frontend_loading();
        let generation = state.generation();

        let failed: Result<Option<()>, &str> =
            state.apply_startup_visibility(generation, || Err("show failed"));
        assert_eq!(failed, Err("show failed"));
        assert_eq!(
            state.apply_startup_visibility(generation, || Ok::<_, &str>(1)),
            Ok(Some(1))
        );
        assert_eq!(
            state.apply_startup_visibility(generation, || Ok::<_, &str>(2)),
            Ok(None)
        );
    }

    #[test]
    fn newer_visibility_intent_rejects_a_late_startup_mutation() {
        let state = MainWindowLifecycleState::default();
        state.mark_frontend_loading();
        let generation = state.generation();

        state.apply_native_visibility(false, || ());
        assert_eq!(
            state.apply_startup_visibility(generation, || Ok::<_, &str>(1)),
            Ok(None)
        );

        state.mark_frontend_loading();
        let next_generation = state.generation();
        assert_eq!(state.request_close(), super::LifecycleRequest::Queued);
        assert_eq!(
            state.apply_startup_visibility(next_generation, || Ok::<_, &str>(2)),
            Ok(None)
        );
        assert_eq!(
            state.apply_startup_visibility(generation, || Ok::<_, &str>(3)),
            Ok(None)
        );
    }

    #[test]
    fn native_restore_supersedes_a_queued_close_but_not_force_quit() {
        let state = MainWindowLifecycleState::default();
        let generation = state.generation();
        assert!(state.begin_frontend_registration(generation, 1));

        assert_eq!(state.request_close(), super::LifecycleRequest::Queued);
        state.apply_native_visibility(true, || ());
        assert!(state.mark_frontend_ready(generation, 1, false).is_none());

        state.mark_frontend_loading();
        let next_generation = state.generation();
        assert!(state.begin_frontend_registration(next_generation, 1));
        assert_eq!(
            state.request_force_quit(),
            super::LifecycleRequest::Queued
        );
        state.apply_native_visibility(true, || ());
        assert!(matches!(
            state.mark_frontend_ready(next_generation, 1, false),
            Some(super::PendingLifecycleAction::ForceQuit)
        ));
    }

    #[test]
    fn frontend_decoration_claim_rejects_late_startup_and_stale_transitions() {
        let state = MainWindowLifecycleState::default();
        let generation = state.generation();

        assert_eq!(state.apply_startup_decorations(generation, || 1), Some(1));
        assert_eq!(
            state.apply_frontend_decorations(generation, 10, || 2),
            Some(2)
        );
        assert!(state.apply_startup_decorations(generation, || 3).is_none());
        assert!(state
            .apply_frontend_decorations(generation, 9, || 4)
            .is_none());

        state.mark_frontend_loading();
        let next_generation = state.generation();
        assert!(state.apply_startup_decorations(generation, || 5).is_none());
        assert_eq!(
            state.apply_startup_decorations(next_generation, || 6),
            Some(6)
        );
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_logging_mode(mode: String) -> Result<(), String> {
    crate::logging::set_logging_mode_from_str(&mode)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_psylab_albums_browse_trace(enabled: bool) -> Result<(), String> {
    psysonic_core::logging::set_psylab_albums_browse_trace(enabled);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_psylab_artists_browse_trace(enabled: bool) -> Result<(), String> {
    psysonic_core::logging::set_psylab_artists_browse_trace(enabled);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_logging_mode() -> String {
    crate::logging::current_mode_str().to_string()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn export_runtime_logs(path: String) -> Result<usize, String> {
    crate::logging::export_logs_to_file(&path)
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogLineDto {
    pub seq: u64,
    pub text: String,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogTailDto {
    pub lines: Vec<LogLineDto>,
    pub last_seq: u64,
    pub dropped: bool,
}

/// Incremental tail of the in-memory runtime log buffer for the PsyLab Logs tab.
/// `after_seq` is the highest seq the UI already has (omit for
/// the initial fetch of the most recent `max` lines).
#[tauri::command]
#[specta::specta]
pub(crate) fn tail_runtime_logs(after_seq: Option<u64>, max: Option<usize>) -> LogTailDto {
    let tail = crate::logging::tail_logs(after_seq, max.unwrap_or(2000));
    LogTailDto {
        lines: tail
            .lines
            .into_iter()
            .map(|l| LogLineDto { seq: l.seq, text: l.text })
            .collect(),
        last_seq: tail.last_seq,
        dropped: tail.dropped,
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn frontend_debug_log(scope: String, message: String) -> Result<(), String> {
    crate::app_deprintln!("[frontend][{}] {}", scope, message);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_subsonic_wire_user_agent(
    user_agent: String,
    window_label: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if window_label != "main" {
        return Ok(());
    }
    let ua = user_agent.trim();
    if ua.is_empty() {
        return Err("user agent is empty".to_string());
    }
    let mut guard = runtime_subsonic_wire_user_agent()
        .write()
        .map_err(|_| "user agent state poisoned".to_string())?;
    guard.clear();
    guard.push_str(ua);
    drop(guard);

    crate::audio::refresh_http_user_agent(&app_handle.state::<crate::audio::AudioEngine>(), ua);
    Ok(())
}
