use super::super::backfill_queue::*;
use super::super::cpu_seed::seed_key;
use super::super::http_backfill::{cpu_seed_pipeline_cap, should_idle_for_cpu_backpressure};
use super::super::types::*;
use std::collections::{HashMap, HashSet};

// ── AnalysisBackfillQueueState ────────────────────────────────────────────

#[test]
fn backfill_default_state_has_empty_queues_and_no_in_progress() {
    let s = AnalysisBackfillQueueState::default();
    assert_eq!(s.queued_len(), 0);
    assert!(s.in_progress.is_empty());
}

#[test]
fn backfill_is_reserved_checks_all_tiers_and_in_progress() {
    let mut s = AnalysisBackfillQueueState::default();
    s.enqueue(
        String::new(),
        "queued".into(),
        "u".into(),
        AnalysisBackfillPriority::Middle,
    );
    s.in_progress
        .insert(seed_key("", "active"), AnalysisBackfillPriority::Low);
    assert!(s.is_reserved(&seed_key("", "queued")));
    assert!(s.is_reserved(&seed_key("", "active")));
    assert!(!s.is_reserved(&seed_key("", "other")));
}

#[test]
fn backfill_try_pop_next_drains_high_then_middle_then_low() {
    let mut s = AnalysisBackfillQueueState::default();
    s.enqueue(
        String::new(),
        "low".into(),
        "u".into(),
        AnalysisBackfillPriority::Low,
    );
    s.enqueue(
        String::new(),
        "mid".into(),
        "u".into(),
        AnalysisBackfillPriority::Middle,
    );
    s.enqueue(
        String::new(),
        "hi".into(),
        "u".into(),
        AnalysisBackfillPriority::High,
    );
    assert_eq!(s.try_pop_next(4).unwrap().0, "hi");
    assert_eq!(s.try_pop_next(4).unwrap().0, "mid");
    assert_eq!(s.try_pop_next(4).unwrap().0, "low");
}

#[test]
fn backfill_enqueue_low_priority_appends_to_low_tier() {
    let mut s = AnalysisBackfillQueueState::default();
    s.enqueue(
        String::new(),
        "first".into(),
        "u".into(),
        AnalysisBackfillPriority::High,
    );
    let kind = s.enqueue(
        String::new(),
        "second".into(),
        "u2".into(),
        AnalysisBackfillPriority::Low,
    );
    assert_eq!(kind, AnalysisBackfillEnqueueKind::NewLow);
    assert_eq!(s.try_pop_next(4).unwrap().0, "first");
    assert_eq!(s.try_pop_next(4).unwrap().0, "second");
}

#[test]
fn backfill_enqueue_high_priority_pushes_to_high_tier() {
    let mut s = AnalysisBackfillQueueState::default();
    s.enqueue(
        String::new(),
        "old".into(),
        "u".into(),
        AnalysisBackfillPriority::Low,
    );
    let kind = s.enqueue(
        String::new(),
        "hot".into(),
        "u2".into(),
        AnalysisBackfillPriority::High,
    );
    assert_eq!(kind, AnalysisBackfillEnqueueKind::NewHigh);
    assert_eq!(s.try_pop_next(4).unwrap().0, "hot");
}

#[test]
fn backfill_enqueue_middle_priority_appends_to_middle_tier() {
    let mut s = AnalysisBackfillQueueState::default();
    s.enqueue(
        String::new(),
        "old".into(),
        "u".into(),
        AnalysisBackfillPriority::Low,
    );
    let kind = s.enqueue(
        String::new(),
        "next".into(),
        "u2".into(),
        AnalysisBackfillPriority::Middle,
    );
    assert_eq!(kind, AnalysisBackfillEnqueueKind::NewMiddle);
    assert_eq!(s.try_pop_next(4).unwrap().0, "next");
    assert_eq!(s.try_pop_next(4).unwrap().0, "old");
}

#[test]
fn backfill_enqueue_same_track_id_on_two_servers_stays_two_jobs() {
    // Same Subsonic id on two servers is two different files: the second
    // enqueue must not be DuplicateSkipped nor steal the first job's scope.
    let mut s = AnalysisBackfillQueueState::default();
    s.enqueue(
        "server-a".into(),
        "dup".into(),
        "url-a".into(),
        AnalysisBackfillPriority::Low,
    );
    let kind = s.enqueue(
        "server-b".into(),
        "dup".into(),
        "url-b".into(),
        AnalysisBackfillPriority::Low,
    );
    assert_eq!(kind, AnalysisBackfillEnqueueKind::NewLow);
    assert_eq!(s.queued_len(), 2, "one backfill job per server");
    let first = s.try_pop_next(4).unwrap();
    let second = s.try_pop_next(4).unwrap();
    assert_eq!((first.0.as_str(), first.2.as_str()), ("dup", "server-a"));
    assert_eq!((second.0.as_str(), second.2.as_str()), ("dup", "server-b"));
}

#[test]
fn backfill_enqueue_returns_duplicate_skipped_for_same_tier_dup() {
    let mut s = AnalysisBackfillQueueState::default();
    s.enqueue(
        String::new(),
        "dup".into(),
        "u".into(),
        AnalysisBackfillPriority::Low,
    );
    let kind = s.enqueue(
        String::new(),
        "dup".into(),
        "u2".into(),
        AnalysisBackfillPriority::Low,
    );
    assert_eq!(kind, AnalysisBackfillEnqueueKind::DuplicateSkipped);
    assert_eq!(s.queued_len(), 1);
}

#[test]
fn backfill_enqueue_upgrades_low_to_middle() {
    // Same (server, track): a higher-priority re-enqueue reorders the job.
    let mut s = AnalysisBackfillQueueState::default();
    s.enqueue(
        "server-1".into(),
        "dup".into(),
        "old_url".into(),
        AnalysisBackfillPriority::Low,
    );
    let kind = s.enqueue(
        "server-1".into(),
        "dup".into(),
        "fresh_url".into(),
        AnalysisBackfillPriority::Middle,
    );
    assert_eq!(kind, AnalysisBackfillEnqueueKind::ReorderedHigher);
    let job = s.try_pop_next(4).unwrap();
    assert_eq!(job.0, "dup");
    assert_eq!(job.1, "fresh_url");
    assert_eq!(job.2, "server-1");
    assert_eq!(s.queued_len(), 0);
}

#[test]
fn backfill_enqueue_returns_running_skipped_for_high_prio_active_track() {
    let mut s = AnalysisBackfillQueueState {
        in_progress: HashMap::from([(seed_key("", "active"), AnalysisBackfillPriority::Low)]),
        ..Default::default()
    };
    let kind = s.enqueue(
        String::new(),
        "active".into(),
        "u".into(),
        AnalysisBackfillPriority::High,
    );
    assert_eq!(kind, AnalysisBackfillEnqueueKind::RunningSkipped);
}

#[test]
fn backfill_transient_failure_defers_low_priority_retry() {
    let mut s = AnalysisBackfillQueueState::default();
    let key = seed_key("server-1", "retry");
    s.in_progress
        .insert(key.clone(), AnalysisBackfillPriority::Low);
    s.finish_job(&key, AnalysisBackfillFinish::RetryableFailure);

    let kind = s.enqueue(
        "server-1".into(),
        "retry".into(),
        "url".into(),
        AnalysisBackfillPriority::Low,
    );

    assert_eq!(kind, AnalysisBackfillEnqueueKind::RetryDeferred);
    assert_eq!(s.queued_len(), 0);
}

#[test]
fn backfill_high_priority_retry_bypasses_and_clears_cooldown() {
    let mut s = AnalysisBackfillQueueState::default();
    let key = seed_key("server-1", "retry");
    s.in_progress
        .insert(key.clone(), AnalysisBackfillPriority::Low);
    s.finish_job(&key, AnalysisBackfillFinish::RetryableFailure);

    assert_eq!(
        s.enqueue(
            "server-1".into(),
            "retry".into(),
            "url".into(),
            AnalysisBackfillPriority::High,
        ),
        AnalysisBackfillEnqueueKind::NewHigh
    );
    let job = s.try_pop_next(1).unwrap();
    s.finish_job(&seed_key(&job.2, &job.0), AnalysisBackfillFinish::Success);

    assert_eq!(
        s.enqueue(
            "server-1".into(),
            "retry".into(),
            "url".into(),
            AnalysisBackfillPriority::Low,
        ),
        AnalysisBackfillEnqueueKind::NewLow
    );
}

#[test]
fn post_admission_failure_preserves_reservation_and_increments_backoff() {
    let mut state = AnalysisBackfillQueueState::default();
    let key = seed_key("server-1", "retry");
    state
        .in_progress
        .insert(key.clone(), AnalysisBackfillPriority::Low);
    state.finish_job(&key, AnalysisBackfillFinish::RetryableFailure);
    assert_eq!(
        state.retry_state.get(&key).map(|retry| retry.failures),
        Some(1)
    );

    assert_eq!(
        state.enqueue(
            "server-1".into(),
            "retry".into(),
            "url".into(),
            AnalysisBackfillPriority::High,
        ),
        AnalysisBackfillEnqueueKind::NewHigh
    );
    let job = state.try_pop_next(1).unwrap();
    state.mark_cpu_admitted(&key);

    assert!(state.awaiting_cpu.contains(&key));
    assert_eq!(
        state.enqueue(
            "server-1".into(),
            "retry".into(),
            "url".into(),
            AnalysisBackfillPriority::High,
        ),
        AnalysisBackfillEnqueueKind::RunningSkipped
    );

    state.finish_job(
        &seed_key(&job.2, &job.0),
        AnalysisBackfillFinish::RetryableFailure,
    );

    assert!(state.retry_deferred(&key));
    assert_eq!(
        state.retry_state.get(&key).map(|retry| retry.failures),
        Some(2)
    );
}

#[test]
fn permanent_http_failure_suppresses_low_priority_until_high_priority_retries() {
    let mut state = AnalysisBackfillQueueState::default();
    let key = seed_key("server-1", "permanent");
    state
        .in_progress
        .insert(key.clone(), AnalysisBackfillPriority::Low);
    state.finish_job(&key, AnalysisBackfillFinish::TerminalFailure);

    assert_eq!(
        state.enqueue(
            "server-1".into(),
            "permanent".into(),
            "url".into(),
            AnalysisBackfillPriority::Low,
        ),
        AnalysisBackfillEnqueueKind::TerminalSkipped
    );
    assert_eq!(
        state.enqueue(
            "server-1".into(),
            "permanent".into(),
            "url".into(),
            AnalysisBackfillPriority::High,
        ),
        AnalysisBackfillEnqueueKind::NewHigh
    );
}

#[test]
fn terminal_failure_cooldown_allows_a_later_low_priority_retry() {
    let mut state = AnalysisBackfillQueueState::default();
    let key = seed_key("server-1", "changed-after-terminal");
    state
        .in_progress
        .insert(key.clone(), AnalysisBackfillPriority::Low);
    state.finish_job(&key, AnalysisBackfillFinish::TerminalFailure);
    state.terminal_failures.insert(
        key,
        std::time::Instant::now() - std::time::Duration::from_secs(1),
    );

    assert_eq!(
        state.enqueue(
            "server-1".into(),
            "changed-after-terminal".into(),
            "url".into(),
            AnalysisBackfillPriority::Low,
        ),
        AnalysisBackfillEnqueueKind::NewLow
    );
    assert!(state.terminal_failures.is_empty());
}

#[test]
fn forced_low_priority_retry_bypasses_terminal_cooldown() {
    let mut state = AnalysisBackfillQueueState::default();
    let key = seed_key("server-1", "manual-retry");
    state
        .in_progress
        .insert(key.clone(), AnalysisBackfillPriority::Low);
    state.finish_job(&key, AnalysisBackfillFinish::TerminalFailure);

    assert_eq!(
        state.enqueue_with_force(
            "server-1".into(),
            "manual-retry".into(),
            "url".into(),
            AnalysisBackfillPriority::Low,
            true,
        ),
        AnalysisBackfillEnqueueKind::NewLow
    );
}

#[test]
fn clearing_failed_tracks_removes_matching_backfill_cooldowns() {
    let mut state = AnalysisBackfillQueueState::default();
    let bare_key = seed_key("server-1", "missing");
    let stream_key = seed_key("server-1", "stream:missing");
    let other_server_key = seed_key("server-2", "missing");
    state.record_retryable_failure(&bare_key);
    state.terminal_failures.insert(
        stream_key.clone(),
        std::time::Instant::now() + std::time::Duration::from_secs(60),
    );
    state.terminal_failures.insert(
        other_server_key.clone(),
        std::time::Instant::now() + std::time::Duration::from_secs(60),
    );

    state.clear_failure_state("server-1", &["missing".to_string()]);

    assert!(!state.retry_state.contains_key(&bare_key));
    assert!(!state.terminal_failures.contains_key(&stream_key));
    assert!(state.terminal_failures.contains_key(&other_server_key));
}
#[test]
fn backfill_try_pop_next_respects_max_concurrent() {
    let mut s = AnalysisBackfillQueueState::default();
    s.enqueue(
        String::new(),
        "a".into(),
        "u".into(),
        AnalysisBackfillPriority::Low,
    );
    s.enqueue(
        String::new(),
        "b".into(),
        "u".into(),
        AnalysisBackfillPriority::Low,
    );
    s.in_progress
        .insert("active".into(), AnalysisBackfillPriority::Low);
    assert!(s.try_pop_next(1).is_none());
    assert_eq!(s.try_pop_next(2).unwrap().0, "a");
}

#[test]
fn backfill_prune_queued_not_in_drops_unkept_entries() {
    let mut s = AnalysisBackfillQueueState::default();
    for tid in ["a", "b", "c", "d"] {
        s.enqueue(
            String::new(),
            tid.into(),
            "u".into(),
            AnalysisBackfillPriority::Low,
        );
    }
    let keep: HashSet<&str> = ["a", "c"].iter().copied().collect();
    let removed = s.prune_queued_not_in(&keep, None);
    assert_eq!(removed, 2);
    assert_eq!(s.try_pop_next(4).unwrap().0, "a");
    assert_eq!(s.try_pop_next(4).unwrap().0, "c");
}
// ── CPU-seed backpressure ─────────────────────────────────────────────────

#[test]
fn cpu_seed_pipeline_cap_scales_with_workers() {
    assert_eq!(cpu_seed_pipeline_cap(1), 2);
    assert_eq!(cpu_seed_pipeline_cap(3), 6);
    assert_eq!(cpu_seed_pipeline_cap(6), 12);
    assert_eq!(cpu_seed_pipeline_cap(20), 40);
}

#[test]
fn cpu_seed_pipeline_cap_has_floor_of_two() {
    assert_eq!(cpu_seed_pipeline_cap(0), 2);
}

#[test]
fn backpressure_idles_when_cpu_load_meets_cap_and_no_high() {
    assert!(should_idle_for_cpu_backpressure(12, 0, 12, false));
    assert!(should_idle_for_cpu_backpressure(20, 0, 12, false));
}

#[test]
fn backpressure_allows_pop_when_cpu_load_below_cap() {
    assert!(!should_idle_for_cpu_backpressure(11, 0, 12, false));
    assert!(!should_idle_for_cpu_backpressure(0, 0, 12, false));
    assert!(should_idle_for_cpu_backpressure(11, 1, 12, false));
}

#[test]
fn backpressure_reserves_one_extra_slot_for_high_priority_jobs() {
    assert!(!should_idle_for_cpu_backpressure(12, 0, 12, true));
    assert!(should_idle_for_cpu_backpressure(12, 1, 12, true));
    assert!(should_idle_for_cpu_backpressure(13, 0, 12, true));
    assert!(should_idle_for_cpu_backpressure(100, 0, 12, true));
}

#[test]
fn backpressure_admits_only_one_high_download_beyond_cpu_cap() {
    let mut state = AnalysisBackfillQueueState::default();
    state.enqueue(
        "backpressure-server".into(),
        "first".into(),
        "u1".into(),
        AnalysisBackfillPriority::High,
    );
    state.enqueue(
        "backpressure-server".into(),
        "second".into(),
        "u2".into(),
        AnalysisBackfillPriority::High,
    );

    assert!(state
        .try_pop_next_with_cpu_backpressure(20, 12, 12)
        .is_some());
    assert!(state
        .try_pop_next_with_cpu_backpressure(20, 12, 12)
        .is_none());
    assert_eq!(state.in_progress.len(), 1);
    assert_eq!(state.queued_len(), 1);
}
