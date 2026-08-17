use super::super::cpu_seed::*;
use super::super::types::*;
use crate::analysis_cache;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

fn trusted_revision(md5_16kb: &str, generation: u64) -> Option<TrustedAnalysisRevision> {
    Some(TrustedAnalysisRevision {
        md5_16kb: md5_16kb.to_string(),
        generation,
        analysis_bytes_transcoded: false,
        content_hash_server_id: None,
    })
}

fn trusted_transcode_revision(md5_16kb: &str, generation: u64) -> Option<TrustedAnalysisRevision> {
    Some(TrustedAnalysisRevision {
        md5_16kb: md5_16kb.to_string(),
        generation,
        analysis_bytes_transcoded: true,
        content_hash_server_id: None,
    })
}
// ── AnalysisCpuSeedQueueState ─────────────────────────────────────────────

#[test]
fn cpu_seed_enqueue_low_prio_appends_to_low_tier() {
    let mut s = AnalysisCpuSeedQueueState::default();
    let (kind, _rx) = s.enqueue(
        String::new(),
        "a".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewLow);
    assert_eq!(s.queued_len(), 1);
}

#[test]
fn cpu_seed_enqueue_high_prio_pushes_to_high_tier() {
    let mut s = AnalysisCpuSeedQueueState::default();
    let (_, _r1) = s.enqueue(
        String::new(),
        "first".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    let (kind, _r2) = s.enqueue(
        String::new(),
        "hot".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::High,
        0,
    );
    assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewHigh);
    assert_eq!(s.try_pop_next().unwrap().track_id, "hot");
}

#[test]
fn cpu_seed_enqueue_existing_low_prio_merges_at_back() {
    // Same (server, track, revision): the fresh submission merges into the
    // queued job — e.g. two transcoded plays carrying the SAME trusted
    // original fingerprint. Fresher bytes win, both waiters attach.
    let mut s = AnalysisCpuSeedQueueState::default();
    let (_, _r1) = s.enqueue(
        "server-a".into(),
        "dup".into(),
        vec![1, 2, 3],
        None,
        trusted_revision("rev-x", 1),
        AnalysisBackfillPriority::Low,
        0,
    );
    let (kind, _r2) = s.enqueue(
        "server-a".into(),
        "dup".into(),
        vec![4, 5, 6],
        None,
        trusted_revision("rev-x", 1),
        AnalysisBackfillPriority::Low,
        0,
    );
    assert_eq!(kind, AnalysisCpuSeedEnqueueKind::MergedQueued);
    assert_eq!(s.queued_len(), 1);
    let job = s.try_pop_next().unwrap();
    assert_eq!(job.bytes, vec![4, 5, 6], "fresh bytes overwrite");
    assert_eq!(job.waiters.len(), 2, "both waiters attached");
}

#[test]
fn cpu_seed_merge_never_replaces_original_bytes_with_transcode() {
    let mut s = AnalysisCpuSeedQueueState::default();
    let (_, _original_rx) = s.enqueue(
        "server-a".into(),
        "track".into(),
        vec![1, 2, 3],
        None,
        trusted_revision("revision", 1),
        AnalysisBackfillPriority::High,
        0,
    );
    let (kind, _transcode_rx) = s.enqueue(
        "server-a".into(),
        "track".into(),
        vec![9, 9, 9],
        Some("mp3".into()),
        trusted_transcode_revision("revision", 1),
        AnalysisBackfillPriority::Low,
        0,
    );

    assert_eq!(kind, AnalysisCpuSeedEnqueueKind::MergedQueued);
    let job = s.try_pop_next().unwrap();
    assert_eq!(job.bytes, vec![1, 2, 3]);
    assert!(!job.trusted_revision.unwrap().analysis_bytes_transcoded);
    assert_eq!(job.waiters.len(), 2);
}

#[test]
fn cpu_seed_running_job_does_not_swallow_a_different_content_revision() {
    // A job for revision A is RUNNING; a submission for the same track
    // with a DIFFERENT trusted fingerprint (new original revision) must be
    // queued as its own job — attaching it as a follower would discard its
    // bytes and fingerprint entirely.
    let mut s = AnalysisCpuSeedQueueState::default();
    let (_, _r1) = s.enqueue(
        "srv".into(),
        "t1".into(),
        vec![1],
        None,
        trusted_revision("revision-a", 1),
        AnalysisBackfillPriority::Low,
        0,
    );
    let job_a = s.try_pop_next().unwrap();
    assert_eq!(
        job_a
            .trusted_revision
            .as_ref()
            .map(|trusted| trusted.md5_16kb.as_str()),
        Some("revision-a")
    );
    // Mirror the worker: mark revision A as running.
    s.running.insert(
        seed_revision_key(&job_a.server_id, &job_a.track_id, &job_a.revision),
        Arc::new(Mutex::new(Vec::new())),
    );
    assert!(s.contains_revision("srv", "t1", "revision-a"));
    assert!(!s.contains_revision("srv", "t1", "revision-b"));

    let (kind, _r2) = s.enqueue(
        "srv".into(),
        "t1".into(),
        vec![2],
        None,
        trusted_revision("revision-b", 2),
        AnalysisBackfillPriority::Low,
        0,
    );
    assert_ne!(
        kind,
        AnalysisCpuSeedEnqueueKind::RunningFollower,
        "a different content revision must not be swallowed as a follower"
    );
    let job_b = s.try_pop_next().expect("revision B queued as its own job");
    assert_eq!(
        job_b
            .trusted_revision
            .as_ref()
            .map(|trusted| trusted.md5_16kb.as_str()),
        Some("revision-b")
    );
    assert_eq!(job_b.bytes, vec![2]);
}

#[test]
fn cpu_seed_enqueue_same_track_id_on_two_servers_stays_two_jobs() {
    // The same Subsonic id on different servers is different content —
    // it must NOT merge into one decode or steal the other's scope.
    let mut s = AnalysisCpuSeedQueueState::default();
    let (_, _r1) = s.enqueue(
        "server-a".into(),
        "dup".into(),
        vec![1, 2, 3],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    let (kind, _r2) = s.enqueue(
        "server-b".into(),
        "dup".into(),
        vec![4, 5, 6],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewLow);
    assert_eq!(s.queued_len(), 2, "one job per server");
    let first = s.try_pop_next().unwrap();
    let second = s.try_pop_next().unwrap();
    assert_eq!(first.server_id, "server-a");
    assert_eq!(second.server_id, "server-b");
}

#[test]
fn cpu_seed_enqueue_existing_low_prio_upgrades_to_high() {
    let mut s = AnalysisCpuSeedQueueState::default();
    let (_, _r1) = s.enqueue(
        String::new(),
        "first".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    let (_, _r2) = s.enqueue(
        String::new(),
        "dup".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    let (kind, _r3) = s.enqueue(
        String::new(),
        "dup".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::High,
        0,
    );
    assert_eq!(kind, AnalysisCpuSeedEnqueueKind::ReorderedHigher);
    assert_eq!(s.try_pop_next().unwrap().track_id, "dup");
}

#[test]
fn cpu_seed_enqueue_running_id_attaches_as_follower() {
    let mut s = AnalysisCpuSeedQueueState::default();
    let followers = Arc::new(Mutex::new(Vec::new()));
    s.running.insert(
        seed_revision_key("", "active", &analysis_cache::md5_first_16kb(&[])),
        followers.clone(),
    );
    let (kind, _rx) = s.enqueue(
        String::new(),
        "active".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    assert_eq!(kind, AnalysisCpuSeedEnqueueKind::RunningFollower);
    assert_eq!(
        followers.lock().unwrap().len(),
        1,
        "follower channel attached"
    );
    assert_eq!(s.queued_len(), 0, "follower does not occupy a queue slot");
}

#[test]
fn cpu_seed_finish_running_closes_follower_registration_before_drain() {
    let mut s = AnalysisCpuSeedQueueState::default();
    let revision = analysis_cache::md5_first_16kb(&[]);
    let key = seed_revision_key("", "active", &revision);
    let followers = Arc::new(Mutex::new(Vec::new()));
    let (existing_tx, _existing_rx) = tokio::sync::oneshot::channel();
    followers.lock().unwrap().push(existing_tx);
    s.running.insert(key.clone(), followers);
    s.running_tiers
        .insert(key.clone(), AnalysisBackfillPriority::Low);

    let drained = s.finish_running(&key);
    assert_eq!(drained.len(), 1);
    assert!(!s.running.contains_key(&key));
    assert!(!s.running_tiers.contains_key(&key));

    let (kind, _rx) = s.enqueue(
        String::new(),
        "active".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    assert_eq!(kind, AnalysisCpuSeedEnqueueKind::NewLow);
}

#[test]
fn cpu_seed_prune_returns_removed_jobs_and_waiter_count() {
    let mut s = AnalysisCpuSeedQueueState::default();
    let (_, _r1) = s.enqueue(
        String::new(),
        "a".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    let (_, _r2) = s.enqueue(
        String::new(),
        "b".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    let (_, _r3) = s.enqueue(
        String::new(),
        "a".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    let (_, _r4) = s.enqueue(
        String::new(),
        "c".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );

    let keep: HashSet<&str> = ["a"].iter().copied().collect();
    let (removed_jobs, removed_waiters) = s.prune_queued_not_in(&keep, None);
    assert_eq!(removed_jobs, 2, "b and c removed");
    assert_eq!(removed_waiters, 2, "one waiter on b + one on c");
    assert_eq!(s.try_pop_next().unwrap().track_id, "a");
}

#[test]
fn cpu_seed_prune_sends_err_to_dropped_waiters() {
    let mut s = AnalysisCpuSeedQueueState::default();
    let (_, rx) = s.enqueue(
        String::new(),
        "doomed".into(),
        vec![],
        None,
        None,
        AnalysisBackfillPriority::Low,
        0,
    );
    let keep: HashSet<&str> = HashSet::new();
    let _ = s.prune_queued_not_in(&keep, None);
    let result = rx
        .blocking_recv()
        .expect("sender side should have closed cleanly");
    assert!(result.is_err(), "pruned job must yield Err, got {result:?}");
}
