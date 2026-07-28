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
use super::error::SyncError;
use super::ingest_parallel::{fetch_albums_parallel, ParallelAlbumFetchOpts};
use super::mapping::{merge_album_open_subsonic_track_raw, subsonic_song_to_track_row};
use super::now_unix_ms;
use crate::repos::{TrackRepository, TrackRow};
use crate::store::LibraryStore;

/// Albums per `getAlbumList2` page. The Subsonic maximum, so a catalogue costs
/// `albums / 500` requests: 26 for a 12,700-album library.
pub const CENSUS_PAGE_SIZE: u32 = 500;

/// Follow-up `getAlbum` calls one run may spend. Whatever is left over is still
/// there next time — the census is a repeating pass, not a one-shot repair, and
/// a desktop player has no business firing thousands of requests in one tick.
pub const CENSUS_ALBUM_PROBE_CAP: usize = 100;

/// Ceiling on how much of a server's catalogue one census may remove. A run
/// that wants to delete more than this is far likelier to be a broken
/// enumeration than a user who deleted that much between two passes.
pub const CENSUS_REMOVAL_CAP_PERCENT: usize = 20;

/// One album as either side of the census sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumInventoryEntry {
    pub album_id: String,
    pub song_count: i64,
    pub duration_sec: i64,
}

/// What the two inventories disagree about. Nothing here is acted on directly:
/// `absent_on_server` still needs per-album confirmation, and the counts are a
/// hint that one album deserves a closer look, not a diff of its tracks.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CensusDiff {
    /// The server lists it, the index does not — a gap to fetch.
    pub missing_locally: Vec<String>,
    /// The index holds it, the server's enumeration does not — a removal
    /// candidate, pending confirmation.
    pub absent_on_server: Vec<String>,
    /// Both sides have it and disagree on song count or total duration.
    pub needs_track_check: Vec<String>,
}

impl CensusDiff {
    pub fn is_empty(&self) -> bool {
        self.missing_locally.is_empty()
            && self.absent_on_server.is_empty()
            && self.needs_track_check.is_empty()
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
        match local_by_id.get(entry.album_id.as_str()) {
            None => diff.missing_locally.push(entry.album_id.clone()),
            Some(ours) => {
                // Duration catches the case a count cannot: one track removed
                // and another added between two passes leaves the count intact.
                if ours.song_count != entry.song_count || ours.duration_sec != entry.duration_sec {
                    diff.needs_track_check.push(entry.album_id.clone());
                }
            }
        }
    }
    for entry in local {
        if !server_by_id.contains_key(entry.album_id.as_str()) {
            diff.absent_on_server.push(entry.album_id.clone());
        }
    }

    diff.missing_locally.sort();
    diff.absent_on_server.sort();
    diff.needs_track_check.sort();
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
    /// Albums re-read because their shape disagreed.
    pub albums_reconciled: usize,
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

    pub async fn run(&self) -> Result<CensusReport, SyncError> {
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

        let mut spent = 0usize;
        let take = |ids: &[String], spent: &mut usize| -> Vec<String> {
            let room = self.probe_cap.saturating_sub(*spent);
            let slice = ids.iter().take(room).cloned().collect::<Vec<_>>();
            *spent += slice.len();
            slice
        };

        let to_remove = take(removable, &mut spent);
        let to_fill = take(&diff.missing_locally, &mut spent);
        let to_reconcile = take(&diff.needs_track_check, &mut spent);
        report.deferred = (removable.len() - to_remove.len())
            + (diff.missing_locally.len() - to_fill.len())
            + (diff.needs_track_check.len() - to_reconcile.len());

        // Rule 2, second half: an album missing from the page run is a
        // candidate. Only `getAlbum` answering "gone" turns it into a removal,
        // so a shifted page cannot delete music.
        for album_id in &to_remove {
            self.check_cancellation()?;
            match self.subsonic.get_album(album_id).await {
                Err(SubsonicError::NotFound) => {
                    self.tombstone_album(album_id)?;
                    report.albums_removed += 1;
                }
                Ok(_) => {}
                Err(other) => return Err(SyncError::from(other)),
            }
        }

        let mut refetch = to_fill.clone();
        refetch.extend(to_reconcile.iter().cloned());
        if !refetch.is_empty() {
            let fetched = fetch_albums_parallel(
                self.subsonic,
                &refetch,
                ParallelAlbumFetchOpts {
                    budget: self.budget,
                    sleep_enabled: self.sleep_enabled,
                    cancel: self.cancel.clone(),
                },
            )
            .await?;
            for (album, raw_album) in fetched {
                self.check_cancellation()?;
                self.ingest_album(&album, &raw_album)?;
            }
            report.gaps_filled = to_fill.len();
            report.albums_reconciled = to_reconcile.len();
        }

        Ok(report)
    }

    /// Page through the server's albums. Any failing page aborts the whole run:
    /// a partial list would make every album it never reached look absent.
    async fn enumerate_server_albums(&self) -> Result<Vec<AlbumInventoryEntry>, SyncError> {
        let mut out: Vec<AlbumInventoryEntry> = Vec::new();
        let mut offset: u32 = 0;
        loop {
            self.check_cancellation()?;
            let page = self
                .subsonic
                .get_album_list2("alphabeticalByName", CENSUS_PAGE_SIZE, offset, None)
                .await?;
            let received = page.len() as u32;
            for summary in page {
                out.push(AlbumInventoryEntry {
                    album_id: summary.id,
                    song_count: summary.song_count.unwrap_or(0),
                    duration_sec: summary.duration.unwrap_or(0),
                });
            }
            if received < CENSUS_PAGE_SIZE {
                break;
            }
            offset = offset.saturating_add(CENSUS_PAGE_SIZE);
        }
        Ok(out)
    }

    fn tombstone_album(&self, album_id: &str) -> Result<(), SyncError> {
        let tracks = TrackRepository::new(self.store);
        let ids = tracks
            .live_track_ids_for_album(&self.server_id, album_id)
            .map_err(SyncError::Storage)?;
        if ids.is_empty() {
            return Ok(());
        }
        tracks
            .apply_tombstone_results(&self.server_id, "", &[], &ids)
            .map_err(SyncError::Storage)
    }

    /// Same shape as the S2 ingest: album metadata first, then its songs with
    /// the album-level fields merged in.
    fn ingest_album(&self, album: &psysonic_integration::subsonic::Album, raw_album: &Value) -> Result<(), SyncError> {
        let synced_at = now_unix_ms();
        super::album_metadata::upsert_album_from_get_album(
            self.store,
            &self.server_id,
            album,
            raw_album,
            synced_at,
        )?;

        let raw_songs = raw_album
            .get("song")
            .and_then(|s| s.as_array())
            .cloned()
            .unwrap_or_default();
        let mut rows: Vec<TrackRow> = Vec::with_capacity(album.song.len());
        for (index, song) in album.song.iter().enumerate() {
            let mut raw = raw_songs
                .get(index)
                .cloned()
                .unwrap_or_else(|| serde_json::to_value(song).unwrap_or(Value::Null));
            merge_album_open_subsonic_track_raw(raw_album, &mut raw);
            rows.push(subsonic_song_to_track_row(
                &self.server_id,
                song,
                &raw,
                synced_at,
                None,
            ));
        }
        if rows.is_empty() {
            return Ok(());
        }
        let repo = TrackRepository::new(self.store);
        repo.upsert_batch(&rows).map_err(SyncError::Storage)?;

        // The album's authoritative track set just arrived: anything still live
        // under this album that it does not mention is gone from the server.
        let returned: std::collections::HashSet<&str> =
            album.song.iter().map(|song| song.id.as_str()).collect();
        let stale: Vec<String> = repo
            .live_track_ids_for_album(&self.server_id, &album.id)
            .map_err(SyncError::Storage)?
            .into_iter()
            .filter(|id| !returned.contains(id.as_str()))
            .collect();
        if !stale.is_empty() {
            repo.apply_tombstone_results(&self.server_id, "", &[], &stale)
                .map_err(SyncError::Storage)?;
        }
        Ok(())
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
            song_count: songs,
            duration_sec: duration,
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
    fn a_changed_song_count_asks_for_a_closer_look() {
        let local = vec![entry("al-1", 10, 2000)];
        let server = vec![entry("al-1", 11, 2200)];

        assert_eq!(
            diff_inventories(&local, &server).needs_track_check,
            vec!["al-1"]
        );
    }

    #[test]
    fn one_track_swapped_for_another_still_shows_up() {
        // The case a count alone cannot see: same number of songs, different
        // total duration because the replacement is not the same recording.
        let local = vec![entry("al-1", 10, 2000)];
        let server = vec![entry("al-1", 10, 2043)];

        assert_eq!(
            diff_inventories(&local, &server).needs_track_check,
            vec!["al-1"]
        );
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
    async fn an_album_the_index_never_got_is_fetched() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
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
