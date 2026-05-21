//! C12 — HTTP backoff for ingest batches (spec §6.8).
//!
//! The runner does not advance its cursor on transient failure; it
//! sleeps via `Backoff::next_delay`, retries the same batch, and
//! resets the counter on success. The cap is 120 s — the user is
//! waiting for sync to finish, longer hangs become indistinguishable
//! from "stuck" without progress events to reassure them.

use std::time::Duration;

/// Exponential schedule per §6.8: `2s → 4s → 8s → … cap 120s`. The
/// caller adds jitter on top to avoid herd-sync against a recovering
/// upstream proxy.
#[derive(Debug, Clone)]
pub struct Backoff {
    attempt: u32,
    base: Duration,
    cap: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(Duration::from_secs(2), Duration::from_secs(120))
    }
}

impl Backoff {
    pub fn new(base: Duration, cap: Duration) -> Self {
        Self { attempt: 0, base, cap }
    }

    /// Reset after a successful batch — the next failure starts at
    /// the base delay again.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    /// Compute the next sleep duration and bump the attempt counter.
    /// Doubles each call (2 → 4 → 8 → …) and clamps to `cap`. Caller
    /// adds jitter via `with_jitter` if desired.
    pub fn next_delay(&mut self) -> Duration {
        let n = self.attempt;
        self.attempt = self.attempt.saturating_add(1);
        let scaled = self.base.saturating_mul(1u32 << n.min(31));
        scaled.min(self.cap)
    }

    pub fn attempt(&self) -> u32 {
        self.attempt
    }
}

/// Salt for production jitter: attempt plus sub-second clock noise so
/// concurrent retries don't share the same jitter slot.
pub fn jitter_salt(attempt: u32) -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    u64::from(attempt).saturating_add(nanos)
}

/// Add ±25% jitter to a planned sleep — deterministic per `salt` so
/// tests can pin the result without pulling in `rand`. Production
/// code passes `jitter_salt(attempt)` as the salt; tests pass a fixed
/// value to assert the formula.
pub fn with_jitter(base: Duration, salt: u64) -> Duration {
    let millis = base.as_millis().min(u128::from(u64::MAX)) as u64;
    if millis == 0 {
        return base;
    }
    let span = millis / 2; // ±25% = total span of 50% of base
    if span == 0 {
        return base;
    }
    // map salt into [-span/2, +span/2]
    let pct = (salt % span) as i64 - (span as i64 / 2);
    let jittered = (millis as i64).saturating_add(pct).max(1) as u64;
    Duration::from_millis(jittered)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_delay_doubles_until_cap() {
        let mut b = Backoff::default();
        assert_eq!(b.next_delay(), Duration::from_secs(2));
        assert_eq!(b.next_delay(), Duration::from_secs(4));
        assert_eq!(b.next_delay(), Duration::from_secs(8));
        assert_eq!(b.next_delay(), Duration::from_secs(16));
        assert_eq!(b.next_delay(), Duration::from_secs(32));
        assert_eq!(b.next_delay(), Duration::from_secs(64));
        // Next would be 128 — clamps to 120 cap.
        assert_eq!(b.next_delay(), Duration::from_secs(120));
        // Stays at cap from here on.
        assert_eq!(b.next_delay(), Duration::from_secs(120));
    }

    #[test]
    fn reset_brings_schedule_back_to_base() {
        let mut b = Backoff::default();
        b.next_delay();
        b.next_delay();
        assert!(b.attempt() > 0);
        b.reset();
        assert_eq!(b.attempt(), 0);
        assert_eq!(b.next_delay(), Duration::from_secs(2));
    }

    #[test]
    fn next_delay_handles_custom_base_and_cap() {
        let mut b = Backoff::new(Duration::from_millis(50), Duration::from_secs(1));
        assert_eq!(b.next_delay(), Duration::from_millis(50));
        assert_eq!(b.next_delay(), Duration::from_millis(100));
        assert_eq!(b.next_delay(), Duration::from_millis(200));
        assert_eq!(b.next_delay(), Duration::from_millis(400));
        assert_eq!(b.next_delay(), Duration::from_millis(800));
        // 1600 would exceed 1s cap.
        assert_eq!(b.next_delay(), Duration::from_secs(1));
    }

    #[test]
    fn next_delay_does_not_overflow_at_extreme_attempts() {
        let mut b = Backoff::default();
        for _ in 0..100 {
            // Should saturate at the cap, never panic on shift overflow.
            let _ = b.next_delay();
        }
        assert_eq!(b.next_delay(), Duration::from_secs(120));
    }

    #[test]
    fn jitter_stays_within_plus_minus_half_of_span() {
        let base = Duration::from_secs(8);
        let span_ms = base.as_millis() as u64 / 2; // 4000 ms
        let lo = base.as_millis() as u64 - span_ms / 2; // 6000 ms
        let hi = base.as_millis() as u64 + span_ms / 2; // 10000 ms
        for salt in 0u64..1000 {
            let j = with_jitter(base, salt).as_millis() as u64;
            assert!(j >= lo && j <= hi, "salt {salt} → {j}ms outside [{lo},{hi}]");
        }
    }

    #[test]
    fn jitter_with_zero_base_returns_zero() {
        assert_eq!(with_jitter(Duration::ZERO, 12345), Duration::ZERO);
    }
}
