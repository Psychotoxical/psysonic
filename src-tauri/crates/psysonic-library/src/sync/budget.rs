//! C9 — request budget per spec §6.2.5.
//!
//! Soft caps the scheduler declares before each pass; runners
//! consume them to decide when to defer the remainder to the next
//! tick. PR-3d2 ships the data type + lookups; PR-5 / the runner
//! wires the actual consumption (delta runner can already be capped
//! via batch_size — the budget is a higher-level abstraction).

/// Per-pass HTTP call budgets matching the spec table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassKind {
    /// `poll_tick (unchanged watermark)` — 1 call (`getArtists` only).
    PollTick,
    /// `delta_sync (light)` — small targeted delta, 50 calls.
    DeltaLight,
    /// `delta_sync (count mismatch / tombstone)` — 200 calls,
    /// split across ticks if exhausted.
    DeltaMismatch,
    /// Initial sync — unlimited (only user cancel stops it).
    InitialSync,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestBudget {
    pub kind: PassKind,
    /// `None` = unlimited.
    pub cap: Option<u32>,
}

impl RequestBudget {
    pub const POLL_TICK_CAP: u32 = 1;
    pub const DELTA_LIGHT_CAP: u32 = 50;
    pub const DELTA_MISMATCH_CAP: u32 = 200;

    pub fn for_pass(kind: PassKind) -> Self {
        let cap = match kind {
            PassKind::PollTick => Some(Self::POLL_TICK_CAP),
            PassKind::DeltaLight => Some(Self::DELTA_LIGHT_CAP),
            PassKind::DeltaMismatch => Some(Self::DELTA_MISMATCH_CAP),
            PassKind::InitialSync => None,
        };
        Self { kind, cap }
    }

    pub fn is_unlimited(&self) -> bool {
        self.cap.is_none()
    }

    /// Returns `true` when `used` requests still fit inside the cap.
    /// Unlimited budgets always return `true`.
    pub fn has_room(&self, used: u32) -> bool {
        match self.cap {
            None => true,
            Some(cap) => used < cap,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_tick_cap_is_one_request() {
        let b = RequestBudget::for_pass(PassKind::PollTick);
        assert_eq!(b.cap, Some(1));
        assert!(b.has_room(0));
        assert!(!b.has_room(1));
    }

    #[test]
    fn delta_light_caps_at_fifty() {
        let b = RequestBudget::for_pass(PassKind::DeltaLight);
        assert_eq!(b.cap, Some(50));
        assert!(b.has_room(49));
        assert!(!b.has_room(50));
    }

    #[test]
    fn delta_mismatch_caps_at_two_hundred() {
        let b = RequestBudget::for_pass(PassKind::DeltaMismatch);
        assert_eq!(b.cap, Some(200));
        assert!(b.has_room(199));
        assert!(!b.has_room(200));
    }

    #[test]
    fn initial_sync_is_unlimited() {
        let b = RequestBudget::for_pass(PassKind::InitialSync);
        assert!(b.is_unlimited());
        assert!(b.has_room(u32::MAX));
    }
}
