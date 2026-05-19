//! C1 — Capability probe (spec §6.1 / §6.1.1).
//!
//! Drives the Subsonic client + an optional Navidrome native probe to
//! populate `sync_state.capability_flags` before initial sync picks its
//! ingest strategy (§6.3). PR-3a only writes flags from the responses;
//! interpretation lives in PR-3b's `IngestStrategy` selector.

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
}

/// Run `CapabilityProbe::run` and persist the resulting flags +
/// transition `sync_phase` from whatever it was to `probing` →
/// `idle` (caller is responsible for advancing to `initial_sync` /
/// `ready` once the appropriate runner starts).
///
/// PR-3d wires this in front of every initial / delta run so the
/// stored `capability_flags` always reflects the current server.
/// Returns the freshly resolved `(flags, server_info)` so callers
/// can pick their `IngestStrategy` without re-reading SQLite.
pub async fn probe_and_persist(
    store: &crate::store::LibraryStore,
    subsonic: &psysonic_integration::subsonic::SubsonicClient,
    navidrome: Option<&NavidromeProbeCredentials>,
    server_id: &str,
    library_scope: &str,
) -> Result<CapabilityProbeResult, psysonic_integration::subsonic::SubsonicError> {
    let sync_state = crate::repos::SyncStateRepository::new(store);
    sync_state
        .ensure(server_id, library_scope)
        .map_err(psysonic_integration::subsonic::SubsonicError::Transport)?;
    sync_state
        .set_sync_phase(server_id, library_scope, "probing")
        .map_err(psysonic_integration::subsonic::SubsonicError::Transport)?;

    let result = CapabilityProbe::run(subsonic, navidrome).await?;

    sync_state
        .set_capability_flags(server_id, library_scope, result.flags.bits())
        .map_err(psysonic_integration::subsonic::SubsonicError::Transport)?;
    sync_state
        .set_sync_phase(server_id, library_scope, "idle")
        .map_err(psysonic_integration::subsonic::SubsonicError::Transport)?;

    Ok(result)
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

        if subsonic.get_scan_status().await.is_ok() {
            flags.insert(CapabilityFlags::SCAN_STATUS_AVAILABLE);
        }

        if subsonic.get_indexes(None, None).await.is_ok() {
            flags.insert(CapabilityFlags::FILE_TREE_BROWSE);
        }

        if let Some(creds) = navidrome {
            match native_bulk_available(&creds.server_url, &creds.bearer_token).await {
                Ok(true) => flags.insert(CapabilityFlags::NAVIDROME_NATIVE_BULK),
                Ok(false) => {}
                Err(_) => {
                    // Probe transport failed but Subsonic ping worked —
                    // assume the native endpoint is unavailable for this
                    // setup and let sync fall back to S1/S2.
                }
            }
        }

        Ok(CapabilityProbeResult { flags, server_info })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
    use serde_json::json;
    use wiremock::matchers::{header, method as wm_method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // ── CapabilityFlags bitfield ─────────────────────────────────────────

    #[test]
    fn capability_flags_contains_respects_individual_bits() {
        let mut f = CapabilityFlags::default();
        assert!(!f.contains(CapabilityFlags::OPEN_SUBSONIC));
        f.insert(CapabilityFlags::OPEN_SUBSONIC);
        assert!(f.contains(CapabilityFlags::OPEN_SUBSONIC));
        assert!(!f.contains(CapabilityFlags::NAVIDROME_NATIVE_BULK));
    }

    #[test]
    fn capability_flags_insert_is_idempotent() {
        let mut f = CapabilityFlags::default();
        f.insert(CapabilityFlags::SUBSONIC_SEARCH3_BULK);
        let after_first = f.bits();
        f.insert(CapabilityFlags::SUBSONIC_SEARCH3_BULK);
        assert_eq!(f.bits(), after_first);
    }

    #[test]
    fn capability_flags_remove_clears_only_the_named_bit() {
        let mut f = CapabilityFlags::new(
            CapabilityFlags::OPEN_SUBSONIC | CapabilityFlags::UNSTABLE_TRACK_IDS,
        );
        f.remove(CapabilityFlags::OPEN_SUBSONIC);
        assert!(!f.contains(CapabilityFlags::OPEN_SUBSONIC));
        assert!(f.contains(CapabilityFlags::UNSTABLE_TRACK_IDS));
    }

    #[test]
    fn capability_flags_bit_values_match_spec_table() {
        // Spec §6.1.1 hex values — pin the wire format so future
        // schema-migration writers don't shift them silently.
        assert_eq!(CapabilityFlags::NAVIDROME_NATIVE_BULK, 0x001);
        assert_eq!(CapabilityFlags::SUBSONIC_SEARCH3_BULK, 0x002);
        assert_eq!(CapabilityFlags::SCAN_STATUS_AVAILABLE, 0x004);
        assert_eq!(CapabilityFlags::OPEN_SUBSONIC, 0x008);
        assert_eq!(CapabilityFlags::UNSTABLE_TRACK_IDS, 0x010);
        assert_eq!(CapabilityFlags::FILE_TREE_BROWSE, 0x020);
    }

    // ── CapabilityProbe wiremock harness ─────────────────────────────────

    fn test_subsonic_client(uri: &str) -> SubsonicClient {
        SubsonicClient::with_static_credentials(
            uri,
            SubsonicCredentials::with_static("user", "tok", "salt"),
            reqwest::Client::new(),
        )
    }

    fn ok_envelope(body_key: &str, body: serde_json::Value) -> serde_json::Value {
        json!({
            "subsonic-response": {
                "status": "ok",
                "version": "1.16.1",
                body_key: body,
            }
        })
    }

    async fn mount_subsonic_full_navidrome(server: &MockServer) {
        // ping → navidrome + openSubsonic
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "version": "1.16.1",
                    "type": "navidrome",
                    "serverVersion": "0.55.2",
                    "openSubsonic": true
                }
            })))
            .mount(server)
            .await;
        // search3 empty query
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_envelope(
                "searchResult3",
                json!({ "song": [{ "id": "x", "title": "y" }] }),
            )))
            .mount(server)
            .await;
        // getScanStatus
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getScanStatus.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_envelope(
                "scanStatus",
                json!({ "scanning": false }),
            )))
            .mount(server)
            .await;
        // getIndexes
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getIndexes.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_envelope(
                "indexes",
                json!({ "lastModified": 0, "ignoredArticles": "", "index": [] }),
            )))
            .mount(server)
            .await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn probe_sets_all_subsonic_bits_on_a_fully_capable_navidrome_server() {
        let server = MockServer::start().await;
        mount_subsonic_full_navidrome(&server).await;

        let result = CapabilityProbe::run(&test_subsonic_client(&server.uri()), None)
            .await
            .unwrap();
        assert!(result.flags.contains(CapabilityFlags::SUBSONIC_SEARCH3_BULK));
        assert!(result.flags.contains(CapabilityFlags::SCAN_STATUS_AVAILABLE));
        assert!(result.flags.contains(CapabilityFlags::FILE_TREE_BROWSE));
        assert!(result.flags.contains(CapabilityFlags::OPEN_SUBSONIC));
        assert!(result.flags.contains(CapabilityFlags::UNSTABLE_TRACK_IDS));
        // No navidrome probe creds passed → N1 stays clear.
        assert!(!result.flags.contains(CapabilityFlags::NAVIDROME_NATIVE_BULK));
        assert_eq!(result.server_info.server_type.as_deref(), Some("navidrome"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn probe_returns_err_when_subsonic_ping_fails() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "failed",
                    "error": { "code": 40, "message": "Wrong credentials" }
                }
            })))
            .mount(&server)
            .await;

        let err = CapabilityProbe::run(&test_subsonic_client(&server.uri()), None)
            .await
            .unwrap_err();
        assert!(matches!(err, SubsonicError::Api { code: 40, .. }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn probe_keeps_optional_bits_clear_when_their_endpoint_fails() {
        // Minimal Subsonic-like server: ping ok, search3 ok, but
        // scanStatus + getIndexes 4xx. UnstableTrackIds + OpenSubsonic
        // stay clear because the ping envelope omits them.
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "version": "1.13" }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(ok_envelope(
                "searchResult3",
                json!({}),
            )))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getScanStatus.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "failed",
                    "error": { "code": 30, "message": "Method not available" }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getIndexes.view"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let result = CapabilityProbe::run(&test_subsonic_client(&server.uri()), None)
            .await
            .unwrap();
        assert!(result.flags.contains(CapabilityFlags::SUBSONIC_SEARCH3_BULK));
        assert!(!result.flags.contains(CapabilityFlags::SCAN_STATUS_AVAILABLE));
        assert!(!result.flags.contains(CapabilityFlags::FILE_TREE_BROWSE));
        assert!(!result.flags.contains(CapabilityFlags::OPEN_SUBSONIC));
        assert!(!result.flags.contains(CapabilityFlags::UNSTABLE_TRACK_IDS));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn probe_sets_navidrome_native_bulk_when_credentials_succeed() {
        let server = MockServer::start().await;
        mount_subsonic_full_navidrome(&server).await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .and(header("X-ND-Authorization", "Bearer nd-tok"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;

        let nav = NavidromeProbeCredentials {
            server_url: server.uri(),
            bearer_token: "nd-tok".into(),
        };
        let result = CapabilityProbe::run(&test_subsonic_client(&server.uri()), Some(&nav))
            .await
            .unwrap();
        assert!(result.flags.contains(CapabilityFlags::NAVIDROME_NATIVE_BULK));
    }

    // ── probe_and_persist round-trip ──────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn probe_and_persist_writes_flags_and_resets_phase_to_idle() {
        use crate::repos::SyncStateRepository;
        use crate::store::LibraryStore;

        let server = MockServer::start().await;
        mount_subsonic_full_navidrome(&server).await;

        let store = LibraryStore::open_in_memory();
        let result = super::probe_and_persist(
            &store,
            &test_subsonic_client(&server.uri()),
            None,
            "s1",
            "",
        )
        .await
        .unwrap();

        let sync_state = SyncStateRepository::new(&store);
        let flags = sync_state.get_capability_flags("s1", "").unwrap().unwrap();
        assert_eq!(flags, result.flags.bits());
        assert!(flags & CapabilityFlags::OPEN_SUBSONIC != 0);
        assert!(flags & CapabilityFlags::UNSTABLE_TRACK_IDS != 0);

        // Phase ends at `idle` so the caller can transition to
        // `initial_sync` / `ready` based on whether a sync is needed.
        assert_eq!(
            sync_state.get_sync_phase("s1", "").unwrap().as_deref(),
            Some("idle")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn probe_leaves_navidrome_native_bulk_clear_when_endpoint_404s() {
        let server = MockServer::start().await;
        mount_subsonic_full_navidrome(&server).await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let nav = NavidromeProbeCredentials {
            server_url: server.uri(),
            bearer_token: "nd-tok".into(),
        };
        let result = CapabilityProbe::run(&test_subsonic_client(&server.uri()), Some(&nav))
            .await
            .unwrap();
        assert!(!result.flags.contains(CapabilityFlags::NAVIDROME_NATIVE_BULK));
    }
}
