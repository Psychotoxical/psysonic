//! Album census — reconcile the local index against the server's inventory.
//!
//! The delta only ever moves forward: it fetches what changed since a watermark
//! and skips everything below it. That makes it blind in both directions. A
//! deletion never appears in a changed-list, so it lingers until something goes
//! looking for it; and a row the ingest missed once sits below the watermark
//! forever, because nothing re-reads that range.
//!
//! Both are the same missing capability — nothing compares the two catalogues.
//! The census does, at album granularity, which is cheap enough to run on a
//! schedule: one `getAlbumList2` page run covers a whole server, and the local
//! side comes from `album_browse_projection`, which the ingest and sweep paths
//! already maintain.
//!
//! Two rules make this safe to run unattended, and they exist because the
//! resync sweep taught us what happens without them:
//!
//! 1. **Act only on a complete enumeration.** A page run that failed halfway
//!    tells us nothing about the albums it never reached. Half a census is not
//!    a census.
//! 2. **An absent album is a candidate, not a verdict.** Removal happens only
//!    after a direct `getAlbum` confirms the album is gone, and only within a
//!    cap on how much a single run may take out.

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use psysonic_integration::subsonic::{SubsonicClient, SubsonicError};
use serde_json::Value;

use super::bandwidth::{ParallelismBudget, PlaybackHint};
use super::capability::CapabilityFlags;
use super::error::SyncError;
use super::ingest_parallel::{
    next_album_list_offset, retry_fetch, sleep_request_gap, wait_while_bulk_paused,
};
use super::mapping::album_track_rows;
use super::now_unix_ms;
use crate::repos::TrackRepository;
use crate::store::LibraryStore;

mod inventory;

pub use inventory::{
    diff_inventories, local_album_inventory, removal_is_within_cap, AlbumInventoryEntry,
    CensusDiff, CensusReport,
};

/// Albums per `getAlbumList2` page. The Subsonic maximum, so a catalogue costs
/// `albums / 500` requests: 26 for a 12,700-album library.
pub const CENSUS_PAGE_SIZE: u32 = 500;

/// Follow-up `getAlbum` calls one run may spend. Whatever is left over is still
/// there next time — the census is a repeating pass, not a one-shot repair, and
/// a desktop player has no business firing thousands of requests in one tick.
pub const CENSUS_ALBUM_PROBE_CAP: usize = 100;

/// Hard stop on the page walk. A server that ignores `offset` answers every
/// page with the same full batch, and the loop's only other exit is a short
/// page; without this it would allocate until the tick is killed.
pub const CENSUS_MAX_PAGES: u32 = 4_000;

// Note on what this deliberately does not do: compare the *contents* of an
// album both sides have. An earlier version flagged albums whose song count or
// total duration disagreed and re-read them. That check could never settle,
// because the census does not retire individual tracks (see `ingest_album`) —
// so a genuine mismatch survived the re-read, was flagged again on the next
// run, and produced a fetch and a UI refresh every single time. Album presence
// is a question the census can answer and finish; album contents are not.

/// Ceiling on how much of a server's catalogue one census may remove. A run
/// that wants to delete more than this is far likelier to be a broken
/// enumeration than a user who deleted that much between two passes.
pub const CENSUS_REMOVAL_CAP_PERCENT: usize = 20;

/// Percentage-only caps make ordinary deletions impossible in small
/// libraries (one album out of four is already 25%). Every removal still needs
/// a direct `getAlbum` NotFound, so allow a small absolute floor while keeping
/// the large-catalogue circuit breaker.
pub const CENSUS_MIN_REMOVAL_CAP_ALBUMS: usize = 10;

/// Reconciles one server's albums against the index. See the module header for
/// the two rules this exists to honour.
pub struct AlbumCensusRunner<'a> {
    store: &'a LibraryStore,
    subsonic: &'a SubsonicClient,
    server_id: String,
    library_scope: Option<String>,
    capability_flags: CapabilityFlags,
    budget: ParallelismBudget,
    cancel: Option<Arc<AtomicBool>>,
    sleep_enabled: bool,
    probe_cap: usize,
    deadline: Option<Instant>,
}

#[cfg(test)]
mod tests;

impl<'a> AlbumCensusRunner<'a> {
    pub fn new(
        store: &'a LibraryStore,
        subsonic: &'a SubsonicClient,
        server_id: impl Into<String>,
    ) -> Self {
        Self {
            store,
            subsonic,
            server_id: server_id.into(),
            library_scope: None,
            capability_flags: CapabilityFlags::new(0),
            budget: ParallelismBudget::resolve(PlaybackHint::Idle),
            cancel: None,
            sleep_enabled: true,
            probe_cap: CENSUS_ALBUM_PROBE_CAP,
            deadline: None,
        }
    }

    pub fn with_cancellation(mut self, flag: Arc<AtomicBool>) -> Self {
        self.cancel = Some(flag);
        self
    }

    pub fn with_sleep_disabled(mut self) -> Self {
        self.sleep_enabled = false;
        self
    }

    pub fn with_probe_cap(mut self, cap: usize) -> Self {
        self.probe_cap = cap;
        self
    }

    pub fn with_deadline(mut self, deadline: Instant) -> Self {
        self.deadline = Some(deadline);
        self
    }

    /// The library a gap-filled track belongs to when the payload does not say.
    /// Without it the census writes rows with a NULL `library_id`, invisible to
    /// scoped browse until a later tagging pass happens to pick them up.
    pub fn with_library_scope(mut self, scope: impl Into<String>) -> Self {
        let scope = scope.into();
        self.library_scope = (!scope.is_empty()).then_some(scope);
        self
    }

    /// Servers that mint fresh track ids on rescan need the remap path, exactly
    /// as the delta ingest does — otherwise a rescan makes the census insert a
    /// second copy of the catalogue instead of recognising the same tracks.
    pub fn with_capability_flags(mut self, flags: CapabilityFlags) -> Self {
        self.capability_flags = flags;
        self
    }

    /// The tick's parallelism budget. The census is bulk work and has to yield
    /// to playback like every other bulk pass.
    pub fn with_budget(mut self, budget: ParallelismBudget) -> Self {
        self.budget = budget;
        self
    }

    pub async fn run(&self) -> Result<CensusReport, SyncError> {
        // The projection is backfilled behind a resumable cursor, so until it
        // finishes it is a prefix of the catalogue. Diffing against a prefix
        // would report the remainder as gaps and re-fetch albums the index
        // already holds.
        if !crate::browse_projection::is_ready(self.store).map_err(SyncError::Storage)? {
            return Ok(CensusReport::default());
        }
        // And only for a server whose catalogue is actually in. On an index
        // whose initial sync never finished, every album the ingest has not
        // reached yet looks like a gap, and the census would quietly become a
        // second ingest path — one without strategy selection, without a
        // resumable cursor, without progress reporting, at a hundred albums per
        // run. That work belongs to the sync that owns it.
        let phase = crate::repos::SyncStateRepository::new(self.store)
            .get_sync_phase(&self.server_id, "")
            .map_err(SyncError::Storage)?;
        if phase.as_deref() != Some("ready") {
            return Ok(CensusReport::default());
        }
        let local =
            local_album_inventory(self.store, &self.server_id).map_err(SyncError::Storage)?;
        let mut report = CensusReport {
            local_albums: local.len(),
            ..CensusReport::default()
        };
        let server = match self.enumerate_server_albums().await? {
            AlbumEnumeration::Complete(server) => server,
            AlbumEnumeration::Invalid => return Ok(report),
            AlbumEnumeration::BudgetExhausted => {
                report.budget_exhausted = true;
                report.enumeration_incomplete = true;
                return Ok(report);
            }
        };
        report.server_albums = server.len();

        // Rule 1. An empty enumeration is not the statement "this server has no
        // music" — it is the absence of an answer, and acting on it would
        // tombstone the entire library.
        if server.is_empty() {
            return Ok(report);
        }

        let mut diff = diff_inventories(&local, &server);
        // An album the server itself reports as empty can never produce a track
        // row, so fetching it leaves the index unchanged and the gap open — and
        // because the gap list is sorted, the same album would take a slot from
        // a real gap on every run for the life of the install.
        let empty_on_server: std::collections::HashSet<&str> = server
            .iter()
            .filter(|entry| entry.song_count == Some(0))
            .map(|entry| entry.album_id.as_str())
            .collect();
        if !empty_on_server.is_empty() {
            diff.missing_locally
                .retain(|album_id| !empty_on_server.contains(album_id.as_str()));
        }
        if diff.is_empty() {
            return Ok(report);
        }

        // Rule 2, first half: refuse wholesale removals before spending a
        // single request on them.
        let removable = if removal_is_within_cap(
            diff.absent_on_server.len(),
            local.len(),
            CENSUS_REMOVAL_CAP_PERCENT,
        ) {
            diff.absent_on_server.as_slice()
        } else {
            report.removal_refused = true;
            crate::app_eprintln!(
                "[library-sync] census refused to remove {} of {} albums in one pass; \
                 treating the enumeration as unreliable",
                diff.absent_on_server.len(),
                local.len()
            );
            &[]
        };

        // Half the budget is reserved for each kind of work before either may
        // take the other's share, so a large backlog of one cannot starve the
        // other: removals used to run first and unbounded, which on a library
        // with many retired albums meant no new album was ever fetched.
        // `div_ceil` hands the odd unit to whoever asks first, so both halves
        // must still be clamped against what the cap has left — otherwise an odd
        // cap with work on both sides spends one request more than it may.
        let half = self.probe_cap.div_ceil(2);
        let to_remove_len = removable.len().min(half);
        let to_fill_len = diff
            .missing_locally
            .len()
            .min(half)
            .min(self.probe_cap.saturating_sub(to_remove_len));
        let mut spare = self.probe_cap.saturating_sub(to_remove_len + to_fill_len);
        let to_remove_len = to_remove_len + spare.min(removable.len() - to_remove_len);
        spare = self.probe_cap.saturating_sub(to_remove_len + to_fill_len);
        let to_fill_len = to_fill_len + spare.min(diff.missing_locally.len() - to_fill_len);

        let to_remove: Vec<String> = removable[..to_remove_len].to_vec();
        let to_fill: Vec<String> = diff.missing_locally[..to_fill_len].to_vec();
        report.deferred =
            (removable.len() - to_remove.len()) + (diff.missing_locally.len() - to_fill.len());

        // Rule 2, second half: an album missing from the page run is a
        // candidate. Only `getAlbum` answering "gone" turns it into a removal,
        // so a shifted page cannot delete music.
        let mut confirmed_gone = Vec::new();
        for (index, album_id) in to_remove.iter().enumerate() {
            if self.deadline_reached() {
                report.budget_exhausted = true;
                report.deferred += to_remove.len() - index;
                break;
            }
            self.check_cancellation()?;
            wait_while_bulk_paused(&self.budget, self.sleep_enabled, || {
                self.check_cancellation()
            })
            .await?;
            sleep_request_gap(&self.budget, self.sleep_enabled).await;
            if self.deadline_reached() {
                report.budget_exhausted = true;
                report.deferred += to_remove.len() - index;
                break;
            }
            let Some(result) = self
                .await_before_deadline(self.subsonic.get_album(album_id))
                .await
            else {
                report.budget_exhausted = true;
                report.deferred += to_remove.len() - index;
                break;
            };
            match result {
                Err(SubsonicError::NotFound) => confirmed_gone.push(album_id.clone()),
                Ok(_) => {}
                // One album that could not be asked is one album left for the
                // next pass, not a reason to throw away the removals already
                // applied and the gap work still to come.
                Err(other) => {
                    crate::app_eprintln!(
                        "[library-sync] census could not confirm an album: {other}"
                    );
                    report.deferred += 1;
                }
            }
        }
        if !confirmed_gone.is_empty() {
            let (retired, stale) = TrackRepository::new(self.store)
                .tombstone_albums(&self.server_id, &confirmed_gone)
                .map_err(SyncError::Storage)?;
            report.albums_removed = retired;
            report.stale_projections_dropped = stale;
        }

        // Albums the server has and the index does not. This is the half that
        // makes a newly added album appear without a full resync — the delta
        // reads forward from a watermark such an album already sits behind, so
        // nothing else in the system will ever fetch it.
        //
        // Fetched one at a time on purpose. The parallel helper is
        // all-or-nothing: one album that answers "gone" between the page walk
        // and the fetch would discard every other album in the batch, and the
        // enumeration would hand back the same list on the next run, so the
        // gap would never close.
        for (index, album_id) in to_fill.iter().enumerate() {
            if self.deadline_reached() {
                report.budget_exhausted = true;
                report.deferred += to_fill.len() - index;
                break;
            }
            self.check_cancellation()?;
            wait_while_bulk_paused(&self.budget, self.sleep_enabled, || {
                self.check_cancellation()
            })
            .await?;
            sleep_request_gap(&self.budget, self.sleep_enabled).await;
            if self.deadline_reached() {
                report.budget_exhausted = true;
                report.deferred += to_fill.len() - index;
                break;
            }
            let Some(result) = self
                .await_before_deadline(self.subsonic.get_album_with_raw(album_id))
                .await
            else {
                report.budget_exhausted = true;
                report.deferred += to_fill.len() - index;
                break;
            };
            match result {
                Ok((album, raw)) => {
                    if self.ingest_album(&album, &raw)? {
                        report.gaps_filled += 1;
                    }
                }
                Err(SubsonicError::NotFound) => {
                    // Listed a moment ago, gone now. Nothing to fetch and
                    // nothing to remove — the index never had it.
                }
                Err(other) => {
                    crate::app_eprintln!("[library-sync] census could not fetch an album: {other}");
                    report.deferred += 1;
                }
            }
        }

        Ok(report)
    }

    /// Page through the server's albums. Any failing page aborts the whole run:
    /// a partial list would make every album it never reached look absent.
    async fn enumerate_server_albums(&self) -> Result<AlbumEnumeration, SyncError> {
        let mut out: Vec<AlbumInventoryEntry> = Vec::new();
        let mut seen = HashSet::new();
        let mut offset: u32 = 0;
        for _ in 0..CENSUS_MAX_PAGES {
            if self.deadline_reached() {
                return Ok(AlbumEnumeration::BudgetExhausted);
            }
            self.check_cancellation()?;
            wait_while_bulk_paused(&self.budget, self.sleep_enabled, || {
                self.check_cancellation()
            })
            .await?;
            sleep_request_gap(&self.budget, self.sleep_enabled).await;
            if self.deadline_reached() {
                return Ok(AlbumEnumeration::BudgetExhausted);
            }
            // Retried like every other bulk fetch in the crate: a transient
            // failure on page 17 of 26 must not cost the whole pass, because
            // the run is then deferred for a full interval.
            let Some(page) = self
                .await_before_deadline(retry_fetch(
                    self.sleep_enabled,
                    || self.check_cancellation(),
                    || {
                        self.subsonic.get_album_list2(
                            "alphabeticalByName",
                            CENSUS_PAGE_SIZE,
                            offset,
                            None,
                        )
                    },
                    SyncError::from,
                ))
                .await
            else {
                return Ok(AlbumEnumeration::BudgetExhausted);
            };
            let page = page?;
            let received = page.len();
            if received == 0 {
                return Ok(AlbumEnumeration::Complete(out));
            }
            let mut new_ids = 0usize;
            for summary in page {
                if !seen.insert(summary.id.clone()) {
                    continue;
                }
                new_ids += 1;
                out.push(AlbumInventoryEntry {
                    album_id: summary.id,
                    // Kept as reported: an omitted field means "unknown", and
                    // reading it as zero would mark the whole catalogue changed.
                    song_count: summary.song_count,
                    duration_sec: summary.duration,
                });
            }
            if new_ids == 0 {
                crate::app_eprintln!(
                    "[library-sync] census album page did not advance at offset {offset}; \
                     discarding the enumeration"
                );
                return Ok(AlbumEnumeration::Invalid);
            }
            offset = next_album_list_offset(offset, received).unwrap_or(offset);
        }
        // Ran out of pages without a short one: the server is not paginating
        // the way this walk assumes, so the list cannot be trusted as complete.
        // An incomplete enumeration is exactly what must never reach the diff.
        crate::app_eprintln!(
            "[library-sync] census page walk did not terminate after {CENSUS_MAX_PAGES} pages; \
             discarding the enumeration"
        );
        Ok(AlbumEnumeration::Invalid)
    }

    /// Same shape as the S2 ingest: album metadata first, then its songs with
    /// the album-level fields merged in.
    /// Returns whether anything was written.
    fn ingest_album(
        &self,
        album: &psysonic_integration::subsonic::Album,
        raw_album: &Value,
    ) -> Result<bool, SyncError> {
        let synced_at = now_unix_ms();
        super::album_metadata::upsert_album_from_get_album(
            self.store,
            &self.server_id,
            album,
            raw_album,
            synced_at,
        )?;

        let rows = album_track_rows(
            &self.server_id,
            album,
            raw_album,
            synced_at,
            self.library_scope.as_deref(),
        );
        if rows.is_empty() {
            return Ok(false);
        }
        let repo = TrackRepository::new(self.store);
        // Servers that rebuild their id space on rescan hand back the same
        // music under new ids. Without the remap the census would insert a
        // second copy of the catalogue and leave the first one live.
        repo.upsert_batch_with_remap(
            &rows,
            self.capability_flags
                .contains(CapabilityFlags::UNSTABLE_TRACK_IDS),
        )
        .map_err(SyncError::Storage)?;

        // Deliberately no track-level sweep here. A `getAlbum` response is
        // authoritative only for what this request can see: on a server with
        // several libraries, or a user with access to a subset of them, the
        // tracks it omits are not gone — they are out of view. Retiring them on
        // that evidence is the same mistake the module header rules out one
        // level up, and it would repeat on every run.
        //
        // Track-level removal therefore stays with the paths that confirm per
        // track (the tombstone reconciler and the manual integrity pass); the
        // census removes whole albums, and only after asking about each one.
        Ok(true)
    }

    fn check_cancellation(&self) -> Result<(), SyncError> {
        if let Some(flag) = &self.cancel {
            if flag.load(Ordering::SeqCst) {
                return Err(SyncError::Cancelled);
            }
        }
        Ok(())
    }

    fn deadline_reached(&self) -> bool {
        self.deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
    }

    /// Bound the in-flight future as well as the gaps between requests. Without
    /// this, one stalled HTTP response can outlive the census budget and the
    /// scheduler loses the exact report for work already committed.
    async fn await_before_deadline<F>(&self, future: F) -> Option<F::Output>
    where
        F: Future,
    {
        let Some(deadline) = self.deadline else {
            return Some(future.await);
        };
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), future)
            .await
            .ok()
    }
}

enum AlbumEnumeration {
    Complete(Vec<AlbumInventoryEntry>),
    Invalid,
    BudgetExhausted,
}
