use super::stream_rate_needs_switch;

#[test]
fn negotiated_rate_difference_does_not_reopen_same_request() {
    // ALSA may negotiate 48 kHz for a 44.1 kHz request. Reopen decisions
    // compare the next target with the prior request, not with that 48 kHz
    // actual rate, so the same mode stays on the existing stream.
    assert!(!stream_rate_needs_switch(44_100, 44_100));
    assert!(stream_rate_needs_switch(96_000, 44_100));
    assert!(!stream_rate_needs_switch(0, 44_100));
}
