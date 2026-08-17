use super::super::final_passes::resync_sweep_is_safe;

#[test]
fn a_short_ingest_does_not_get_to_sweep() {
    // Reproduces a real incident: the ingest re-stamped 168,922 rows while
    // the server reported 175,169. Unguarded, IS-7 tombstoned the 5,651-row
    // difference — 473 albums that still existed on the server.
    assert!(!resync_sweep_is_safe(168_922, Some(175_169)));
}

#[test]
fn a_complete_ingest_sweeps() {
    assert!(resync_sweep_is_safe(175_156, Some(175_156)));
}

#[test]
fn a_catalogue_that_genuinely_shrank_still_sweeps() {
    // The user removed a third of the library server-side: the ingest covers
    // the new count completely, so the leftovers are real orphans.
    assert!(resync_sweep_is_safe(70_000, Some(70_000)));
}

#[test]
fn any_unexplained_shortfall_keeps_the_destructive_sweep_off() {
    assert!(!resync_sweep_is_safe(99_999, Some(100_000)));
}

#[test]
fn an_overcount_is_not_completeness_proof() {
    assert!(!resync_sweep_is_safe(100_001, Some(100_000)));
}

#[test]
fn a_confirmed_empty_catalogue_can_sweep_the_last_rows() {
    assert!(resync_sweep_is_safe(0, Some(0)));
}

#[test]
fn no_server_count_cannot_authorize_a_destructive_sweep() {
    assert!(!resync_sweep_is_safe(0, None));
    assert!(!resync_sweep_is_safe(10, Some(-1)));
}
