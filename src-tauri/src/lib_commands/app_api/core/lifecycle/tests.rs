use super::*;

#[test]
fn close_is_queued_until_the_frontend_is_ready() {
    let state = MainWindowLifecycleState::default();
    let generation = state.generation();
    assert!(state.begin_frontend_registration(generation, 1));

    assert_eq!(state.request_close(), LifecycleRequest::Queued);
    assert!(matches!(
        state.mark_frontend_ready(generation, 1, false),
        Some(PendingLifecycleAction::Close { .. })
    ));
    assert!(state.mark_frontend_ready(generation, 1, false).is_none());
    assert!(matches!(
        state.request_close(),
        LifecycleRequest::EmitClose { .. }
    ));
}

#[test]
fn repeated_early_close_requests_coalesce() {
    let state = MainWindowLifecycleState::default();
    let generation = state.generation();
    assert!(state.begin_frontend_registration(generation, 1));

    assert_eq!(state.request_close(), LifecycleRequest::Queued);
    assert_eq!(state.request_close(), LifecycleRequest::Queued);
    assert!(matches!(
        state.mark_frontend_ready(generation, 1, false),
        Some(PendingLifecycleAction::Close { .. })
    ));
    assert!(state.mark_frontend_ready(generation, 1, false).is_none());
}

#[test]
fn force_quit_takes_priority_over_an_early_close() {
    let state = MainWindowLifecycleState::default();
    let generation = state.generation();
    assert!(state.begin_frontend_registration(generation, 1));

    assert_eq!(state.request_close(), LifecycleRequest::Queued);
    assert_eq!(state.request_force_quit(), LifecycleRequest::Queued);
    assert!(matches!(
        state.mark_frontend_ready(generation, 1, false),
        Some(PendingLifecycleAction::ForceQuit)
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
        LifecycleRequest::EmitClose { .. }
    ));
    state.mark_frontend_loading();
    let second_generation = state.generation();
    assert!(state.begin_frontend_registration(second_generation, 1));
    assert_eq!(state.request_close(), LifecycleRequest::Queued);
    assert!(state
        .mark_frontend_ready(first_generation, 1, false)
        .is_none());
    assert!(matches!(
        state.mark_frontend_ready(second_generation, 1, false),
        Some(PendingLifecycleAction::Close { .. })
    ));
}

#[test]
fn failed_delivery_uses_the_last_known_native_policy() {
    let state = MainWindowLifecycleState::default();
    let generation = state.generation();
    assert!(state.begin_frontend_registration(generation, 1));

    assert_eq!(state.request_force_quit(), LifecycleRequest::Queued);
    let action = state
        .mark_frontend_ready(generation, 1, true)
        .expect("queued force quit");
    assert_eq!(
        state.native_request_after_emit_failure(action),
        LifecycleRequest::NativeExit
    );
    assert_eq!(
        state.native_request_after_emit_failure(PendingLifecycleAction::Close { transition: 1 }),
        LifecycleRequest::NativeHide
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
    assert_eq!(state.request_close(), LifecycleRequest::NativeHide);
    assert_eq!(state.request_force_quit(), LifecycleRequest::NativeExit);
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
    assert_eq!(state.request_close(), LifecycleRequest::NativeHide);
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
        LifecycleRequest::EmitClose { .. }
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
    assert_eq!(state.request_close(), LifecycleRequest::NativeExit);
}

#[test]
fn native_visibility_change_invalidates_a_frontend_hide_transition() {
    let state = MainWindowLifecycleState::default();
    let generation = state.generation();
    assert!(state.begin_frontend_registration(generation, 1));
    assert!(state.mark_frontend_ready(generation, 1, true).is_none());
    let transition = match state.request_close() {
        LifecycleRequest::EmitClose { transition } => transition,
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
    assert_eq!(state.request_close(), LifecycleRequest::Queued);
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

    assert_eq!(state.request_close(), LifecycleRequest::Queued);
    state.apply_native_visibility(true, || ());
    assert!(state.mark_frontend_ready(generation, 1, false).is_none());

    state.mark_frontend_loading();
    let next_generation = state.generation();
    assert!(state.begin_frontend_registration(next_generation, 1));
    assert_eq!(state.request_force_quit(), LifecycleRequest::Queued);
    state.apply_native_visibility(true, || ());
    assert!(matches!(
        state.mark_frontend_ready(next_generation, 1, false),
        Some(PendingLifecycleAction::ForceQuit)
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
