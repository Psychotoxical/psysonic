//! Sync orchestrator. PR-3a lands the foundation — `CapabilityProbe`
//! (C1) and the extended `SyncStateRepository` accessors (C7); the
//! `InitialSyncRunner` / `DeltaSyncRunner` / background scheduler land
//! in PR-3b…d.

pub mod capability;

pub use capability::{CapabilityFlags, CapabilityProbe, NavidromeProbeCredentials};
