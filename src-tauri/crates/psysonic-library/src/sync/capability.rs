//! C1 — Capability probe (spec §6.1 / §6.1.1).
//!
//! Drives the Subsonic client + an optional Navidrome native probe to
//! populate `sync_state.capability_flags` before initial sync picks its
//! ingest strategy (§6.3). PR-3a only writes flags from the responses;
//! interpretation lives in PR-3b's `IngestStrategy` selector.

use std::future::Future;
use std::time::Duration;

use psysonic_integration::navidrome::probe::native_bulk_available;
use psysonic_integration::subsonic::{ServerInfo, SubsonicClient, SubsonicError};

/// Bitfield matching spec §6.1.1. `u32` storage so the `sync_state`
/// table can keep it as a single integer column (`capability_flags
/// INTEGER NOT NULL DEFAULT 0`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CapabilityFlags(u32);

impl CapabilityFlags {
    /// N1 — Navidrome native `/api/song` paginated ingest.
    pub const NAVIDROME_NATIVE_BULK: u32 = 0x001;
    /// S1 — Subsonic `search3` empty-query bulk ingest.
    pub const SUBSONIC_SEARCH3_BULK: u32 = 0x002;
    /// `getScanStatus` available (Subsonic 1.15+); cheap-poll tier signal.
    pub const SCAN_STATUS_AVAILABLE: u32 = 0x004;
    /// Server advertises OpenSubsonic extensions (`isrc`, `played`,
    /// `bpm`, contributor arrays, …).
    pub const OPEN_SUBSONIC: u32 = 0x008;
    /// Track ids may shift across server re-indexing — sync engine must
    /// run the `track_id_history` remap pass (§6.9, P33). Always set
    /// for Navidrome.
    pub const UNSTABLE_TRACK_IDS: u32 = 0x010;
    /// S3 — `getIndexes` / `getMusicDirectory` available (file-tree
    /// fallback when ID3 endpoints are missing entirely).
    pub const FILE_TREE_BROWSE: u32 = 0x020;

    pub fn new(bits: u32) -> Self {
        Self(bits)
    }

    pub fn bits(self) -> u32 {
        self.0
    }

    pub fn contains(self, flag: u32) -> bool {
        self.0 & flag == flag
    }

    pub fn insert(&mut self, flag: u32) {
        self.0 |= flag;
    }

    pub fn remove(&mut self, flag: u32) {
        self.0 &= !flag;
    }
}

/// Optional input for `CapabilityProbe::run` — Navidrome native API
/// needs its own bearer token (separate from the Subsonic salted-md5
/// auth). When `None`, the `NavidromeNativeBulk` bit stays clear and
/// sync falls back to Subsonic strategies.
#[derive(Debug, Clone)]
pub struct NavidromeProbeCredentials {
    pub server_url: String,
    pub bearer_token: String,
}

/// Outcome of the capability probe — both the bitfield (stored in
/// `sync_state.capability_flags`) and the raw `ServerInfo` envelope
/// metadata (callers may want to log `serverVersion` etc.).
#[derive(Debug, Clone)]
pub struct CapabilityProbeResult {
    pub flags: CapabilityFlags,
    pub server_info: ServerInfo,
    /// Server-reported track count from `getScanStatus.count`, when the
    /// server exposes it. `None` when `getScanStatus` is unavailable or
    /// reports no count. Persisted as the `server_track_count` watermark so
    /// the strategy selector can route large catalogs to S1 at IS-1 without
    /// first hitting N1's deep-offset wall (R7-15 Q4).
    pub server_track_count: Option<i64>,
}

/// Run `CapabilityProbe::run` and persist the resulting flags while temporarily
/// transitioning `sync_phase` to `probing`. Phase restoration is conditional so
/// a sync runner that advances the phase while the probe is in flight wins.
///
/// PR-3d wires this in front of every initial / delta run so the
/// stored `capability_flags` always reflects the current server.
/// Returns the freshly resolved `(flags, server_info)` so callers
/// can pick their `IngestStrategy` without re-reading SQLite.
pub async fn probe_and_persist(
    store: &crate::store::LibraryStore,
    subsonic: &psysonic_integration::subsonic::SubsonicClient,
    navidrome: Option<&NavidromeProbeCredentials>,
    http_registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_id: &str,
    library_scope: &str,
) -> Result<CapabilityProbeResult, psysonic_integration::subsonic::SubsonicError> {
    probe_and_persist_inner(
        store,
        subsonic,
        navidrome,
        http_registry,
        server_id,
        library_scope,
        None,
    )
    .await
}

pub async fn probe_and_persist_with_timeout(
    store: &crate::store::LibraryStore,
    subsonic: &psysonic_integration::subsonic::SubsonicClient,
    navidrome: Option<&NavidromeProbeCredentials>,
    http_registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_id: &str,
    library_scope: &str,
    timeout: Duration,
) -> Result<CapabilityProbeResult, psysonic_integration::subsonic::SubsonicError> {
    probe_and_persist_inner(
        store,
        subsonic,
        navidrome,
        http_registry,
        server_id,
        library_scope,
        Some(timeout),
    )
    .await
}

async fn probe_and_persist_inner(
    store: &crate::store::LibraryStore,
    subsonic: &psysonic_integration::subsonic::SubsonicClient,
    navidrome: Option<&NavidromeProbeCredentials>,
    http_registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_id: &str,
    library_scope: &str,
    timeout: Option<Duration>,
) -> Result<CapabilityProbeResult, psysonic_integration::subsonic::SubsonicError> {
    with_probing_phase(store, server_id, library_scope, async {
        let sync_state = crate::repos::SyncStateRepository::new(store);
        let existing_flags = sync_state
            .get_capability_flags(server_id, library_scope)
            .map_err(SubsonicError::Transport)?
            .unwrap_or(0);

        let probe = CapabilityProbe::run(subsonic, navidrome, http_registry, Some(server_id));
        let mut result = match timeout {
            Some(limit) => tokio::time::timeout(limit, probe).await.map_err(|_| {
                SubsonicError::Transport(format!(
                    "capability probe timed out after {} ms",
                    limit.as_millis()
                ))
            })??,
            None => probe.await?,
        };

        // R7-15 Q3: a probe run without a Navidrome bearer can't test N1, so it
        // must not drop a previously-learned NavidromeNativeBulk capability — the
        // server still supports `/api/song`; only the token is missing this bind.
        // Token availability gates actual N1 use per run (see library_sync_start).
        if navidrome.is_none() && existing_flags & CapabilityFlags::NAVIDROME_NATIVE_BULK != 0 {
            result.flags.insert(CapabilityFlags::NAVIDROME_NATIVE_BULK);
        }

        sync_state
            .set_capability_flags(server_id, library_scope, result.flags.bits())
            .map_err(SubsonicError::Transport)?;
        // Refresh the track-count watermark only when the probe learned one — a
        // missing `getScanStatus.count` must not clobber a count from a prior run.
        if let Some(count) = result.server_track_count {
            sync_state
                .set_server_track_count(server_id, library_scope, count)
                .map_err(SubsonicError::Transport)?;
        }

        Ok(result)
    })
    .await
}

async fn with_probing_phase<T>(
    store: &crate::store::LibraryStore,
    server_id: &str,
    library_scope: &str,
    operation: impl Future<Output = Result<T, SubsonicError>>,
) -> Result<T, SubsonicError> {
    let sync_state = crate::repos::SyncStateRepository::new(store);
    sync_state
        .ensure(server_id, library_scope)
        .map_err(SubsonicError::Transport)?;

    let phase_before = loop {
        let phase = sync_state
            .get_sync_phase(server_id, library_scope)
            .map_err(SubsonicError::Transport)?
            .unwrap_or_else(|| "idle".to_string());
        if sync_state
            .set_sync_phase_if(server_id, library_scope, &phase, "probing")
            .map_err(SubsonicError::Transport)?
        {
            break phase;
        }
    };

    let completed = match operation.await {
        Ok(value) => {
            match phase_after_success(&sync_state, server_id, library_scope, &phase_before) {
                Ok(phase) => Ok((value, phase)),
                Err(error) => Err(SubsonicError::Transport(error)),
            }
        }
        Err(error) => Err(error),
    };
    let restore_phase = match &completed {
        Ok((_, phase)) => phase.as_str(),
        Err(_) => phase_before.as_str(),
    };

    // Runtime lifecycle/activity serialization owns production bind ordering.
    // The compare-and-set still preserves a newer phase if another writer
    // advanced it while a direct caller or test probe was in flight.
    sync_state
        .set_sync_phase_if(server_id, library_scope, "probing", restore_phase)
        .map_err(SubsonicError::Transport)?;

    completed.map(|(value, _)| value)
}

fn phase_after_success(
    sync_state: &crate::repos::SyncStateRepository<'_>,
    server_id: &str,
    library_scope: &str,
    phase_before: &str,
) -> Result<String, String> {
    match phase_before {
        // Re-bind on app restart must not clobber a finished or active index —
        // callers gate local search on `ready` (§9.3 / P8).
        "ready" | "initial_sync" | "error" => Ok(phase_before.to_string()),
        _ if sync_state.has_last_full_sync_at(server_id, library_scope)? => Ok("ready".to_string()),
        _ => Ok("idle".to_string()),
    }
}

pub struct CapabilityProbe;

impl CapabilityProbe {
    /// Run the §6.1 probe chain. Returns the resolved flags plus the
    /// envelope metadata captured from the Subsonic ping.
    ///
    /// The Subsonic ping is the only failure-blocking probe — if it
    /// returns `Err`, the server is unreachable / wrong creds / wrong
    /// URL, and no other capability can be determined. Every other
    /// probe is best-effort: it sets its flag on success and leaves it
    /// clear on any error.
    pub async fn run(
        subsonic: &SubsonicClient,
        navidrome: Option<&NavidromeProbeCredentials>,
        http_registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
        server_id: Option<&str>,
    ) -> Result<CapabilityProbeResult, SubsonicError> {
        let server_info = subsonic.server_info().await?;

        let mut flags = CapabilityFlags::default();

        if server_info.open_subsonic {
            flags.insert(CapabilityFlags::OPEN_SUBSONIC);
        }
        // Navidrome rebuilds its track id space on full re-scan; spec
        // §6.9 / P33 makes the remap pass mandatory for those servers.
        if matches!(server_info.server_type.as_deref(), Some("navidrome")) {
            flags.insert(CapabilityFlags::UNSTABLE_TRACK_IDS);
        }

        // `search3` with songCount=1 is the cheapest way to confirm the
        // bulk-ingest endpoint is usable on this server (Navidrome
        // accepts empty query; some forks reject it).
        if subsonic.search3("", 1, 0, None).await.is_ok() {
            flags.insert(CapabilityFlags::SUBSONIC_SEARCH3_BULK);
        }

        let mut server_track_count = None;
        if let Ok(scan) = subsonic.get_scan_status().await {
            flags.insert(CapabilityFlags::SCAN_STATUS_AVAILABLE);
            // Only a positive count is a usable watermark; a scan in progress
            // can report 0, which we treat as "unknown" rather than "empty".
            server_track_count = scan.count.filter(|&c| c > 0);
        }

        if subsonic.get_indexes(None, None).await.is_ok() {
            flags.insert(CapabilityFlags::FILE_TREE_BROWSE);
        }

        if let Some(creds) = navidrome {
            match native_bulk_available(
                http_registry,
                server_id,
                &creds.server_url,
                &creds.bearer_token,
            )
            .await
            {
                Ok(true) => flags.insert(CapabilityFlags::NAVIDROME_NATIVE_BULK),
                Ok(false) => {}
                Err(_) => {
                    // Probe transport failed but Subsonic ping worked —
                    // assume the native endpoint is unavailable for this
                    // setup and let sync fall back to S1/S2.
                }
            }
        }

        Ok(CapabilityProbeResult {
            flags,
            server_info,
            server_track_count,
        })
    }
}

#[cfg(test)]
mod tests;
