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

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use psysonic_integration::subsonic::{SubsonicClient, SubsonicError};
use serde_json::Value;

use super::bandwidth::{ParallelismBudget, PlaybackHint};
use super::capability::CapabilityFlags;
use super::error::SyncError;
use super::ingest_parallel::{retry_fetch, sleep_request_gap, wait_while_bulk_paused};
use super::mapping::album_track_rows;
use super::now_unix_ms;
use crate::repos::TrackRepository;
use crate::store::LibraryStore;

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

/// One album as either side of the census sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumInventoryEntry {
    pub album_id: String,
    /// `None` when the side did not report it. A server that omits `songCount`
    /// must not make every album look changed, so an unknown shape means the
    /// album's presence is compared and its contents are left alone.
    pub song_count: Option<i64>,
    pub duration_sec: Option<i64>,
}

/// What the two inventories disagree about. Nothing here is acted on directly:
/// `absent_on_server` still needs per-album confirmation, and the counts are a
/// hint that one album deserves a closer look, not a diff of its tracks.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CensusDiff {
    /// The server lists it, the index does not — a gap to fetch. This is how an
    /// album added on the server reaches the library without a full resync: the
    /// delta cannot see it, because it only reads forward from a watermark the
    /// album already sits behind.
    pub missing_locally: Vec<String>,
    /// The index holds it, the server's enumeration does not — a removal
    /// candidate, pending confirmation.
    pub absent_on_server: Vec<String>,
}

impl CensusDiff {
    pub fn is_empty(&self) -> bool {
        self.missing_locally.is_empty() && self.absent_on_server.is_empty()
    }
}

/// Compare the two inventories. Both sides are keyed by the server's album id,
/// so this is a set comparison plus a per-album shape check; ordering and
/// duplicates on either side do not matter.
pub fn diff_inventories(
    local: &[AlbumInventoryEntry],
    server: &[AlbumInventoryEntry],
) -> CensusDiff {
    let local_by_id: HashMap<&str, &AlbumInventoryEntry> = local
        .iter()
        .map(|entry| (entry.album_id.as_str(), entry))
        .collect();
    let server_by_id: HashMap<&str, &AlbumInventoryEntry> = server
        .iter()
        .map(|entry| (entry.album_id.as_str(), entry))
        .collect();

    let mut diff = CensusDiff::default();
    for entry in server {
        if !local_by_id.contains_key(entry.album_id.as_str()) {
            diff.missing_locally.push(entry.album_id.clone());
        }
    }
    for entry in local {
        if !server_by_id.contains_key(entry.album_id.as_str()) {
            diff.absent_on_server.push(entry.album_id.clone());
        }
    }

    diff.missing_locally.sort();
    diff.absent_on_server.sort();
    diff
}

/// Whether a run may act on this many removals at all. `local_albums == 0`
/// means there is nothing to protect and nothing to remove.
pub fn removal_is_within_cap(candidates: usize, local_albums: usize, cap_percent: usize) -> bool {
    if candidates == 0 {
        return true;
    }
    if local_albums == 0 {
        return false;
    }
    candidates.saturating_mul(100) <= local_albums.saturating_mul(cap_percent)
}

/// The index's own album inventory for one server, aggregated across its
/// libraries so it lines up with a server-wide album list. Reads
/// `album_browse_projection` rather than aggregating `track`: measured on a
/// 175k-track library, 13 ms against 403 ms, and this runs on the shared read
/// connection where a slow query starves every browse surface behind it.
pub fn local_album_inventory(
    store: &LibraryStore,
    server_id: &str,
) -> Result<Vec<AlbumInventoryEntry>, String> {
    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT album_id, SUM(song_count), SUM(duration_sec) \
             FROM album_browse_projection \
             WHERE server_id = ?1 \
             GROUP BY album_id",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![server_id], |row| {
                Ok(AlbumInventoryEntry {
                    album_id: row.get(0)?,
                    song_count: row.get(1)?,
                    duration_sec: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// What one census run did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CensusReport {
    /// Albums the server listed. Zero means the enumeration produced nothing,
    /// which the runner treats as "no answer", never as "everything is gone".
    pub server_albums: usize,
    pub local_albums: usize,
    /// Albums fetched because the index did not have them.
    pub gaps_filled: usize,
    /// Albums whose rows were tombstoned after `getAlbum` confirmed the loss.
    pub albums_removed: usize,
    /// Candidates left for the next run by the per-run probe cap.
    pub deferred: usize,
    /// True when the removal cap refused this run's candidates outright.
    pub removal_refused: bool,
}

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
}

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
        let server = self.enumerate_server_albums().await?;
        let local = local_album_inventory(self.store, &self.server_id).map_err(SyncError::Storage)?;

        let mut report = CensusReport {
            server_albums: server.len(),
            local_albums: local.len(),
            ..CensusReport::default()
        };

        // Rule 1. An empty enumeration is not the statement "this server has no
        // music" — it is the absence of an answer, and acting on it would
        // tombstone the entire library.
        if server.is_empty() {
            return Ok(report);
        }

        let diff = diff_inventories(&local, &server);
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
        let half = self.probe_cap.div_ceil(2);
        let to_remove_len = removable.len().min(half);
        let to_fill_len = diff.missing_locally.len().min(half);
        let mut spare = self.probe_cap.saturating_sub(to_remove_len + to_fill_len);
        let to_remove_len = to_remove_len + spare.min(removable.len() - to_remove_len);
        spare = self
            .probe_cap
            .saturating_sub(to_remove_len + to_fill_len);
        let to_fill_len = to_fill_len + spare.min(diff.missing_locally.len() - to_fill_len);

        let to_remove: Vec<String> = removable[..to_remove_len].to_vec();
        let to_fill: Vec<String> = diff.missing_locally[..to_fill_len].to_vec();
        report.deferred =
            (removable.len() - to_remove.len()) + (diff.missing_locally.len() - to_fill.len());

        // Rule 2, second half: an album missing from the page run is a
        // candidate. Only `getAlbum` answering "gone" turns it into a removal,
        // so a shifted page cannot delete music.
        for album_id in &to_remove {
            self.check_cancellation()?;
            wait_while_bulk_paused(&self.budget, self.sleep_enabled, || self.check_cancellation())
                .await?;
            sleep_request_gap(&self.budget, self.sleep_enabled).await;
            match self.subsonic.get_album(album_id).await {
                Err(SubsonicError::NotFound) => {
                    if self.tombstone_album(album_id)? {
                        report.albums_removed += 1;
                    }
                }
                Ok(_) => {}
                // One album that could not be asked is one album left for the
                // next pass, not a reason to throw away the removals already
                // applied and the gap work still to come.
                Err(other) => {
                    crate::app_eprintln!("[library-sync] census could not confirm an album: {other}");
                    report.deferred += 1;
                }
            }
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
        for album_id in &to_fill {
            self.check_cancellation()?;
            wait_while_bulk_paused(&self.budget, self.sleep_enabled, || self.check_cancellation())
                .await?;
            sleep_request_gap(&self.budget, self.sleep_enabled).await;
            match self.subsonic.get_album(album_id).await {
                Ok(album) => {
                    let raw = serde_json::to_value(&album).unwrap_or(Value::Null);
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
    async fn enumerate_server_albums(&self) -> Result<Vec<AlbumInventoryEntry>, SyncError> {
        let mut out: Vec<AlbumInventoryEntry> = Vec::new();
        let mut offset: u32 = 0;
        for _ in 0..CENSUS_MAX_PAGES {
            self.check_cancellation()?;
            wait_while_bulk_paused(&self.budget, self.sleep_enabled, || self.check_cancellation())
                .await?;
            sleep_request_gap(&self.budget, self.sleep_enabled).await;
            // Retried like every other bulk fetch in the crate: a transient
            // failure on page 17 of 26 must not cost the whole pass, because
            // the run is then deferred for a full interval.
            let page = retry_fetch(
                self.sleep_enabled,
                || self.check_cancellation(),
                || {
                    self.subsonic
                        .get_album_list2("alphabeticalByName", CENSUS_PAGE_SIZE, offset, None)
                },
                SyncError::from,
            )
            .await?;
            let received = page.len() as u32;
            for summary in page {
                out.push(AlbumInventoryEntry {
                    album_id: summary.id,
                    // Kept as reported: an omitted field means "unknown", and
                    // reading it as zero would mark the whole catalogue changed.
                    song_count: summary.song_count,
                    duration_sec: summary.duration,
                });
            }
            if received < CENSUS_PAGE_SIZE {
                return Ok(out);
            }
            offset = offset.saturating_add(CENSUS_PAGE_SIZE);
        }
        // Ran out of pages without a short one: the server is not paginating
        // the way this walk assumes, so the list cannot be trusted as complete.
        // An incomplete enumeration is exactly what must never reach the diff.
        crate::app_eprintln!(
            "[library-sync] census page walk did not terminate after {CENSUS_MAX_PAGES} pages; \
             discarding the enumeration"
        );
        Ok(Vec::new())
    }

    /// Returns whether anything was actually retired. An album with no live
    /// rows left is a stale projection entry: nothing to tombstone, and the
    /// caller must not count it as a removal or it would spend a probe on the
    /// same album on every future run.
    fn tombstone_album(&self, album_id: &str) -> Result<bool, SyncError> {
        let tracks = TrackRepository::new(self.store);
        let ids = tracks
            .live_track_ids_for_album(&self.server_id, album_id)
            .map_err(SyncError::Storage)?;
        if ids.is_empty() {
            self.drop_stale_projection_row(album_id)?;
            return Ok(false);
        }
        tracks
            .apply_tombstone_results(&self.server_id, "", &[], &ids)
            .map_err(SyncError::Storage)?;
        Ok(true)
    }

    /// A projection row whose tracks are all gone would otherwise keep the
    /// album in the local inventory forever, and every census would probe it
    /// again.
    fn drop_stale_projection_row(&self, album_id: &str) -> Result<(), SyncError> {
        self.store
            .with_conn_mut("census.drop_stale_projection_row", |conn| {
                let tx = conn.transaction()?;
                // Refreshing the scope is what removes an album with no live
                // tracks — and it keeps the composer projection in step, which
                // a hand-written DELETE on one table would leave behind.
                let mut stmt = tx.prepare(
                    "SELECT DISTINCT server_id, library_id FROM album_browse_projection \
                     WHERE server_id = ?1 AND album_id = ?2",
                )?;
                let scopes: Vec<(String, String)> = stmt
                    .query_map(rusqlite::params![self.server_id, album_id], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                drop(stmt);
                let affected: std::collections::HashSet<(String, String, String)> = scopes
                    .into_iter()
                    .map(|(server_id, library_id)| (server_id, library_id, album_id.to_string()))
                    .collect();
                crate::browse_projection::refresh_album_scopes(&tx, affected)?;
                tx.commit()
            })
            .map_err(SyncError::Storage)
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, songs: i64, duration: i64) -> AlbumInventoryEntry {
        AlbumInventoryEntry {
            album_id: id.into(),
            song_count: Some(songs),
            duration_sec: Some(duration),
        }
    }

    /// An album the server lists without saying how big it is.
    fn shapeless_entry(id: &str) -> AlbumInventoryEntry {
        AlbumInventoryEntry {
            album_id: id.into(),
            song_count: None,
            duration_sec: None,
        }
    }

    #[test]
    fn identical_inventories_produce_nothing() {
        let side = vec![entry("al-1", 10, 2000), entry("al-2", 4, 800)];
        assert!(diff_inventories(&side, &side).is_empty());
    }

    #[test]
    fn an_album_only_the_server_has_is_a_gap() {
        let local = vec![entry("al-1", 10, 2000)];
        let server = vec![entry("al-1", 10, 2000), entry("al-2", 4, 800)];

        let diff = diff_inventories(&local, &server);
        assert_eq!(diff.missing_locally, vec!["al-2"]);
        assert!(diff.absent_on_server.is_empty());
    }

    #[test]
    fn an_album_only_the_index_has_is_a_removal_candidate() {
        let local = vec![entry("al-1", 10, 2000), entry("al-gone", 7, 1400)];
        let server = vec![entry("al-1", 10, 2000)];

        let diff = diff_inventories(&local, &server);
        assert_eq!(diff.absent_on_server, vec!["al-gone"]);
        assert!(diff.missing_locally.is_empty());
    }

    #[test]
    fn an_album_both_sides_have_is_left_alone_whatever_its_shape() {
        // The census compares presence, not contents. It does not retire
        // individual tracks, so a disagreement about an album's size is one it
        // could never settle: it would re-read the album and fire a refresh on
        // every run, forever. Album contents belong to the paths that confirm
        // per track.
        let local = vec![entry("al-1", 10, 2000)];
        let server = vec![entry("al-1", 11, 2200)];
        assert!(diff_inventories(&local, &server).is_empty());
    }

    #[test]
    fn a_server_that_reports_no_sizes_still_gets_a_presence_check() {
        let local = vec![entry("al-1", 10, 2000), entry("al-2", 4, 800)];
        let server = vec![shapeless_entry("al-1"), shapeless_entry("al-3")];

        let diff = diff_inventories(&local, &server);
        assert_eq!(diff.missing_locally, vec!["al-3"]);
        assert_eq!(diff.absent_on_server, vec!["al-2"]);
    }

    #[test]
    fn the_cap_refuses_a_run_that_would_gut_the_library() {
        // 3000 of 12,746 albums is not a user deleting music between two
        // passes; it is an enumeration that went wrong.
        assert!(!removal_is_within_cap(3_000, 12_746, CENSUS_REMOVAL_CAP_PERCENT));
    }

    #[test]
    fn the_cap_lets_an_ordinary_cleanup_through() {
        assert!(removal_is_within_cap(30, 12_746, CENSUS_REMOVAL_CAP_PERCENT));
        assert!(removal_is_within_cap(0, 0, CENSUS_REMOVAL_CAP_PERCENT));
    }

    #[test]
    fn nothing_local_means_nothing_to_remove() {
        assert!(!removal_is_within_cap(5, 0, CENSUS_REMOVAL_CAP_PERCENT));
    }

    // ── runner behaviour ─────────────────────────────────────────────────
    //
    // These drive the real HTTP paths through wiremock. The interesting cases
    // are the ones where the server's answer is incomplete or wrong, because
    // that is where a census can destroy a library.

    use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
    use serde_json::json;
    use wiremock::matchers::{method as wm_method, path as wm_path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_subsonic(uri: &str) -> SubsonicClient {
        SubsonicClient::with_static_credentials(
            uri,
            SubsonicCredentials::with_static("user", "tok", "salt"),
            reqwest::Client::new(),
        )
    }

    /// A server whose catalogue is in. The census refuses to run on anything
    /// else, so every runner test needs it.
    fn mark_ready(store: &LibraryStore) {
        let sync_state = crate::repos::SyncStateRepository::new(store);
        sync_state.ensure("s1", "").unwrap();
        sync_state.set_sync_phase("s1", "", "ready").unwrap();
    }

    /// One album in the index: its live tracks plus the projection row the
    /// census reads.
    fn seed_album(store: &LibraryStore, album_id: &str, song_ids: &[&str], duration: i64) {
        store
            .with_conn_mut("test.seed_album", |conn| {
                for id in song_ids {
                    conn.execute(
                        "INSERT INTO track (server_id, id, title, album, album_id, duration_sec, \
                         deleted, synced_at, raw_json) \
                         VALUES ('s1', ?1, 'Title', 'Album', ?2, ?3, 0, 1, '{}')",
                        rusqlite::params![id, album_id, duration / song_ids.len().max(1) as i64],
                    )?;
                }
                conn.execute(
                    "INSERT INTO album_browse_projection \
                     (server_id, library_id, album_id, name, song_count, duration_sec, \
                      synced_at, representative_track_id) \
                     VALUES ('s1', '', ?1, 'Album', ?2, ?3, 1, ?4)",
                    rusqlite::params![
                        album_id,
                        song_ids.len() as i64,
                        duration,
                        song_ids.first().copied().unwrap_or("t0")
                    ],
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn album_summary(id: &str, songs: i64, duration: i64) -> serde_json::Value {
        json!({ "id": id, "name": "Album", "songCount": songs, "duration": duration })
    }

    async fn mount_album_list(server: &MockServer, albums: Vec<serde_json::Value>) {
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "albumList2": { "album": albums } }
            })))
            .mount(server)
            .await;
    }

    async fn mount_album_gone(server: &MockServer, album_id: &str) {
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .and(query_param("id", album_id))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "failed",
                    "error": { "code": 70, "message": "Album not found" }
                }
            })))
            .mount(server)
            .await;
    }

    async fn mount_album_present(server: &MockServer, album_id: &str, song_ids: &[&str]) {
        let songs: Vec<_> = song_ids
            .iter()
            .map(|id| json!({ "id": id, "title": "Title", "album": "Album", "albumId": album_id, "duration": 100 }))
            .collect();
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .and(query_param("id", album_id))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "album": { "id": album_id, "name": "Album", "songCount": song_ids.len(), "song": songs }
                }
            })))
            .mount(server)
            .await;
    }

    fn live_rows(store: &LibraryStore, album_id: &str) -> i64 {
        store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track WHERE album_id = ?1 AND deleted = 0",
                    rusqlite::params![album_id],
                    |r| r.get(0),
                )
            })
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_album_the_server_lost_is_removed_after_confirmation() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        mark_ready(&store);
        for index in 0..10 {
            seed_album(&store, &format!("al-{index}"), &[&format!("t-{index}")], 100);
        }
        // The server still lists nine of the ten.
        let listed: Vec<_> = (0..9).map(|i| album_summary(&format!("al-{i}"), 1, 100)).collect();
        mount_album_list(&server, listed).await;
        mount_album_gone(&server, "al-9").await;

        let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .run()
            .await
            .unwrap();

        assert_eq!(report.albums_removed, 1);
        assert_eq!(live_rows(&store, "al-9"), 0);
        assert_eq!(live_rows(&store, "al-0"), 1, "the rest is untouched");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_album_missing_from_the_page_run_but_still_there_is_not_touched() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        mark_ready(&store);
        for index in 0..10 {
            seed_album(&store, &format!("al-{index}"), &[&format!("t-{index}")], 100);
        }
        let listed: Vec<_> = (0..9).map(|i| album_summary(&format!("al-{i}"), 1, 100)).collect();
        mount_album_list(&server, listed).await;
        // The enumeration skipped it, but the album is alive and well.
        mount_album_present(&server, "al-9", &["t-9"]).await;

        let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .run()
            .await
            .unwrap();

        assert_eq!(report.albums_removed, 0);
        assert_eq!(
            live_rows(&store, "al-9"),
            1,
            "a shifted page must never delete music"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_empty_enumeration_is_no_answer_at_all() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        mark_ready(&store);
        seed_album(&store, "al-1", &["t-1"], 100);
        mount_album_list(&server, Vec::new()).await;

        let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .run()
            .await
            .unwrap();

        assert_eq!(report.server_albums, 0);
        assert_eq!(report.albums_removed, 0);
        assert_eq!(live_rows(&store, "al-1"), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_wholesale_purge_is_refused_before_a_single_request() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        mark_ready(&store);
        for index in 0..10 {
            seed_album(&store, &format!("al-{index}"), &[&format!("t-{index}")], 100);
        }
        // Only one album survives the enumeration — nine of ten would go.
        mount_album_list(&server, vec![album_summary("al-0", 1, 100)]).await;

        let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .run()
            .await
            .unwrap();

        assert!(report.removal_refused);
        assert_eq!(report.albums_removed, 0);
        assert_eq!(live_rows(&store, "al-9"), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_probe_cap_bounds_one_run_and_reports_the_rest() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        mark_ready(&store);
        for index in 0..100 {
            seed_album(&store, &format!("al-{index:03}"), &[&format!("t-{index}")], 100);
        }
        // Ten of a hundred are gone: well inside the removal cap, well above
        // the probe cap this run is given.
        let listed: Vec<_> = (10..100)
            .map(|i| album_summary(&format!("al-{i:03}"), 1, 100))
            .collect();
        mount_album_list(&server, listed).await;
        for index in 0..10 {
            mount_album_gone(&server, &format!("al-{index:03}")).await;
        }

        let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .with_probe_cap(3)
            .run()
            .await
            .unwrap();

        assert!(!report.removal_refused, "ten of a hundred is an ordinary cleanup");
        assert_eq!(report.albums_removed, 3, "one run spends its cap and stops");
        assert_eq!(report.deferred, 7, "the rest is named, not silently dropped");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stale_projection_row_is_dropped_rather_than_counted() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        mark_ready(&store);
        for index in 0..9 {
            seed_album(&store, &format!("al-{index}"), &[&format!("t-{index}")], 100);
        }
        // An album row with no live tracks behind it: nothing to tombstone.
        seed_album(&store, "al-stale", &[], 0);
        let listed: Vec<_> = (0..9).map(|i| album_summary(&format!("al-{i}"), 1, 100)).collect();
        mount_album_list(&server, listed).await;
        mount_album_gone(&server, "al-stale").await;

        let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .run()
            .await
            .unwrap();

        assert_eq!(
            report.albums_removed, 0,
            "nothing was retired, so nothing may be reported as retired"
        );
        let left: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM album_browse_projection WHERE album_id = 'al-stale'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(left, 0, "or the same album is probed again on every run");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_album_the_index_never_got_is_fetched() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        mark_ready(&store);
        seed_album(&store, "al-1", &["t-1"], 100);
        mount_album_list(
            &server,
            vec![album_summary("al-1", 1, 100), album_summary("al-2", 2, 200)],
        )
        .await;
        mount_album_present(&server, "al-2", &["t-2a", "t-2b"]).await;

        let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .run()
            .await
            .unwrap();

        assert_eq!(report.gaps_filled, 1);
        assert_eq!(
            live_rows(&store, "al-2"),
            2,
            "the delta cannot reach below its watermark; the census can"
        );
    }

    #[test]
    fn local_inventory_aggregates_an_album_across_libraries() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed_projection", |conn| {
                conn.execute(
                    "INSERT INTO album_browse_projection \
                     (server_id, library_id, album_id, name, song_count, duration_sec, \
                      synced_at, representative_track_id) \
                     VALUES ('s1', 'lib-a', 'al-1', 'Split', 4, 800, 1, 't1'), \
                            ('s1', 'lib-b', 'al-1', 'Split', 6, 1200, 1, 't2'), \
                            ('s1', 'lib-a', 'al-2', 'Other', 3, 600, 1, 't3'), \
                            ('s2', 'lib-a', 'al-9', 'Elsewhere', 9, 900, 1, 't9')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let mut inventory = local_album_inventory(&store, "s1").unwrap();
        inventory.sort_by(|a, b| a.album_id.cmp(&b.album_id));

        assert_eq!(
            inventory,
            vec![entry("al-1", 10, 2000), entry("al-2", 3, 600)],
            "an album in two libraries counts once, with its songs summed"
        );
    }
}
