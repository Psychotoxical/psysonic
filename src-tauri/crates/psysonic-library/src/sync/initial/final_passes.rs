use super::common::retry_with_backoff;
use super::runner::InitialSyncRunner;
use crate::repos::SyncStateRepository;
use crate::sync::artist_index;
use crate::sync::capability::CapabilityFlags;
use crate::sync::error::SyncError;

impl InitialSyncRunner<'_> {
    // ── IS-4 artist pass (best-effort browse acceleration) ─────────────

    /// Returns `true` when `getArtists` returned an authoritative body (≥ 1
    /// confirmed artist), which the caller uses to gate the IS-7 orphan prune.
    pub(super) async fn run_artist_pass(
        &self,
        _sync_state: &SyncStateRepository<'_>,
    ) -> Result<bool, SyncError> {
        let scope = self.library_scope_opt();
        let artists =
            retry_with_backoff(self, || self.subsonic.get_artists(scope), SyncError::from)
                .await
                .ok();
        let confirmed = if let Some(index) = artists {
            artist_index::apply_artist_index(
                self.store,
                &self.server_id,
                &self.library_scope,
                &index,
            )? > 0
        } else {
            false
        };
        Ok(confirmed)
    }

    // ── IS-5 watermarks ────────────────────────────────────────────────

    pub(super) async fn run_watermark_pass(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<Option<i64>, SyncError> {
        let mut fresh_server_track_count = None;
        if self
            .capability_flags
            .contains(CapabilityFlags::SCAN_STATUS_AVAILABLE)
        {
            if let Ok(s) = self.subsonic.get_scan_status().await {
                sync_state
                    .set_server_last_scan_iso(
                        &self.server_id,
                        &self.library_scope,
                        s.last_scan.as_deref(),
                    )
                    .map_err(SyncError::Storage)?;
                // The same response carries the track count. Persisting it here
                // keeps IS-7's completeness check honest: without it the sweep
                // compares against whatever the bind-time probe wrote, which can
                // be hours old and predate a deliberate server-side deletion.
                // A count observed during a scan is a moving partial result, not
                // proof that the ingest covered the catalogue. Outside a scan,
                // zero is meaningful: it lets a full resync retire the final
                // rows after the user deliberately empties a server.
                if !s.scanning {
                    if let Some(count) = s.count.filter(|&c| c >= 0) {
                        sync_state
                            .set_server_track_count(&self.server_id, &self.library_scope, count)
                            .map_err(SyncError::Storage)?;
                        fresh_server_track_count = Some(count);
                    }
                }
            }
        }
        Ok(fresh_server_track_count)
    }
}

/// IS-7 deletes exactly what the ingest did not re-stamp, so a bulk pass that
/// silently loses a page turns into a mass deletion. This gate compares what the
/// run actually stamped against the count the server reports (refreshed in IS-5,
/// so it reflects deliberate server-side removals rather than a stale bind-time
/// snapshot). A catalogue that genuinely shrank stamps 100 % of the new count
/// and still sweeps; an ingest that dropped rows does not.
///
/// No server count means no completeness proof. The ingest still completes,
/// but the destructive sweep stays off and the census/manual verifier handles
/// deletions with direct confirmation instead.
pub(crate) fn resync_sweep_is_safe(stamped: i64, server_count: Option<i64>) -> bool {
    match server_count {
        Some(expected) if expected >= 0 => stamped == expected,
        _ => false,
    }
}
