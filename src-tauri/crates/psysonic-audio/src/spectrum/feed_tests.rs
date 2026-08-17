use std::sync::{atomic::Ordering, Arc, Barrier};

use super::tests::{lock_globals, reset_globals};
use super::*;

#[test]
fn settled_and_decay_ticks_do_not_request_ring_snapshots() {
    assert_eq!(emit_work(10, 10, true), EmitWork::Idle);
    assert_eq!(emit_work(10, 10, false), EmitWork::Decay);
    assert_eq!(emit_work(11, 10, true), EmitWork::Snapshot);
    assert_eq!(emit_work(11, 10, false), EmitWork::Snapshot);
}

#[test]
fn repeated_activation_updates_parameters_without_replacing_the_task_generation() {
    let _guard = lock_globals();
    reset_globals();

    assert_eq!(
        update_feed_state(true, Some(30), Some(0.2)),
        FeedTransition::Start(1)
    );
    let generation = GENERATION.load(Ordering::Relaxed);
    assert_eq!(
        update_feed_state(true, Some(75), Some(0.9)),
        FeedTransition::Update
    );
    assert_eq!(GENERATION.load(Ordering::Relaxed), generation);
    assert_eq!(FPS.load(Ordering::Relaxed), 75);
    assert!((current_responsiveness() - 0.9).abs() < f32::EPSILON);

    assert_eq!(update_feed_state(false, None, None), FeedTransition::Stop);
    assert!(!ACTIVE.load(Ordering::Relaxed));
    assert!(GENERATION.load(Ordering::Relaxed) > generation);
    assert_eq!(
        update_feed_state(false, None, None),
        FeedTransition::AlreadyStopped
    );
}

#[test]
fn concurrent_stop_start_publishes_one_consistent_lifecycle_order() {
    let _guard = lock_globals();
    reset_globals();
    assert_eq!(
        update_feed_state(true, Some(60), Some(0.5)),
        FeedTransition::Start(1)
    );

    let barrier = Arc::new(Barrier::new(3));
    let stop_barrier = Arc::clone(&barrier);
    let stop = std::thread::spawn(move || {
        stop_barrier.wait();
        update_feed_state(false, None, None)
    });
    let start_barrier = Arc::clone(&barrier);
    let start = std::thread::spawn(move || {
        start_barrier.wait();
        update_feed_state(true, Some(75), Some(0.8))
    });
    barrier.wait();

    let stop = stop.join().unwrap();
    let start = start.join().unwrap();
    let restarted =
        matches!(stop, FeedTransition::Stop) && matches!(start, FeedTransition::Start(_));
    assert_eq!(ACTIVE.load(Ordering::Acquire), restarted);
    assert_eq!(
        GENERATION.load(Ordering::Acquire),
        if restarted { 3 } else { 2 }
    );
    assert!(matches!(stop, FeedTransition::Stop));
    assert!(matches!(
        start,
        FeedTransition::Start(_) | FeedTransition::Update
    ));

    update_feed_state(false, None, None);
}
