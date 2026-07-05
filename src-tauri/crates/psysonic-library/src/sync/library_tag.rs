//! Post-sync library membership tagging for whole-server bulk ingests.
//!
//! Large Navidrome libraries ingest via OpenSubsonic `search3` without
//! `libraryId` on each track. After a sync job completes, this pass pages
//! `getAlbumList2` per music folder and tags `track.library_id` by album
//! membership without re-ingesting tracks or touching `resync_gen`/tombstones.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use psysonic_integration::subsonic::{MusicFolder, SubsonicClient};
use rusqlite::OptionalExtension;

use crate::repos::TrackRepository;
use crate::store::LibraryStore;

use super::error::SyncError;
use super::now_unix_ms;
use super::progress::{Progress, ProgressEvent};

const ALBUM_PAGE_SIZE: u32 = 500;

/// Summary of a library-tagging pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagReport {
    pub folders_processed: u32,
    pub albums_processed: u32,
    pub tracks_tagged: u64,
    pub untagged_remaining: u64,
    pub skipped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TagStateRow {
    folders_hash: String,
    last_untagged_count: u64,
}

/// Stable fingerprint of the server's music-folder list for gating.
pub(crate) fn folders_hash(folders: &[MusicFolder]) -> String {
    let mut pairs: Vec<(String, String)> = folders
        .iter()
        .map(|f| (f.id.clone(), f.name.clone()))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    pairs
        .into_iter()
        .map(|(id, name)| format!("{id}:{name}"))
        .collect::<Vec<_>>()
        .join("|")
}

/// Skip when nothing is untagged, or a prior pass made no progress on the
/// same folder set (avoids re-paging album-less tracks forever).
pub(crate) fn should_run_tagging_pass(
    untagged: u64,
    prior: Option<&TagStateRow>,
    folders_hash: &str,
) -> bool {
    if untagged == 0 {
        return false;
    }
    if let Some(p) = prior {
        if p.last_untagged_count == untagged && p.folders_hash == folders_hash {
            return false;
        }
    }
    true
}

fn read_tag_state(store: &LibraryStore, server_id: &str) -> Result<Option<TagStateRow>, SyncError> {
    store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT folders_hash, last_untagged_count FROM library_tag_state WHERE server_id = ?1",
                rusqlite::params![server_id],
                |row| {
                    Ok(TagStateRow {
                        folders_hash: row.get(0)?,
                        last_untagged_count: row.get::<_, i64>(1)?.max(0) as u64,
                    })
                },
            )
            .optional()
        })
        .map_err(|e| SyncError::Storage(e.to_string()))
}

fn write_tag_state(
    store: &LibraryStore,
    server_id: &str,
    folders_hash: &str,
    untagged: u64,
) -> Result<(), SyncError> {
    let now = now_unix_ms();
    store
        .with_conn_mut("library_tag.write_state", |conn| {
            conn.execute(
                "INSERT INTO library_tag_state (server_id, folders_hash, last_untagged_count, completed_at) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(server_id) DO UPDATE SET \
                   folders_hash = excluded.folders_hash, \
                   last_untagged_count = excluded.last_untagged_count, \
                   completed_at = excluded.completed_at",
                rusqlite::params![server_id, folders_hash, untagged as i64, now],
            )
        })
        .map_err(|e| SyncError::Storage(e.to_string()))?;
    Ok(())
}

fn check_cancel(cancel: Option<&Arc<AtomicBool>>) -> Result<(), SyncError> {
    if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
        return Err(SyncError::Cancelled);
    }
    Ok(())
}

/// Best-effort post-sync pass: enumerate music folders, page scoped album
/// lists, and fill empty `track.library_id` values by album membership.
///
/// When `require_untagged` is true (delta sync), returns immediately if no
/// untagged tracks exist. Initial sync passes `false` so the gating logic
/// still runs after folder enumeration.
pub async fn tag_library_membership(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
    cancel: Option<Arc<AtomicBool>>,
    progress: Arc<dyn Progress + Send + Sync>,
    require_untagged: bool,
) -> Result<TagReport, SyncError> {
    let tracks = TrackRepository::new(store);
    let untagged = tracks
        .count_untagged_tracks(server_id)
        .map_err(SyncError::Storage)?;

    if require_untagged && untagged == 0 {
        return Ok(TagReport {
            folders_processed: 0,
            albums_processed: 0,
            tracks_tagged: 0,
            untagged_remaining: 0,
            skipped: true,
        });
    }

    let folders = subsonic
        .get_music_folders()
        .await
        .map_err(SyncError::from)?;
    if folders.is_empty() {
        return Ok(TagReport {
            folders_processed: 0,
            albums_processed: 0,
            tracks_tagged: 0,
            untagged_remaining: untagged,
            skipped: true,
        });
    }

    let hash = folders_hash(&folders);
    let prior = read_tag_state(store, server_id)?;
    if !should_run_tagging_pass(untagged, prior.as_ref(), &hash) {
        return Ok(TagReport {
            folders_processed: 0,
            albums_processed: 0,
            tracks_tagged: 0,
            untagged_remaining: untagged,
            skipped: true,
        });
    }

    progress.emit(ProgressEvent::PhaseChanged {
        phase: "library_tag".to_string(),
    });

    let mut folders_processed = 0u32;
    let mut albums_processed = 0u32;
    let mut tracks_tagged = 0u64;

    for folder in &folders {
        check_cancel(cancel.as_ref())?;
        let mut offset = 0u32;
        loop {
            check_cancel(cancel.as_ref())?;
            let page = subsonic
                .get_album_list2(
                    "alphabeticalByName",
                    ALBUM_PAGE_SIZE,
                    offset,
                    Some(folder.id.as_str()),
                )
                .await
                .map_err(SyncError::from)?;
            if page.is_empty() {
                break;
            }
            let album_ids: Vec<String> = page.iter().map(|a| a.id.clone()).collect();
            albums_processed += album_ids.len() as u32;
            let tagged = tracks
                .tag_library_by_album_ids(server_id, &folder.id, &album_ids)
                .map_err(SyncError::Storage)?;
            tracks_tagged += tagged;

            if page.len() < ALBUM_PAGE_SIZE as usize {
                break;
            }
            offset = offset.saturating_add(ALBUM_PAGE_SIZE);
        }
        folders_processed += 1;
    }

    let untagged_remaining = tracks
        .count_untagged_tracks(server_id)
        .map_err(SyncError::Storage)?;
    write_tag_state(store, server_id, &hash, untagged_remaining)?;

    Ok(TagReport {
        folders_processed,
        albums_processed,
        tracks_tagged,
        untagged_remaining,
        skipped: false,
    })
}

/// Post-sync library tagging — best-effort; never fails the caller (sync job
/// or background scheduler tick).
pub async fn run_tag_pass_best_effort(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
    cancel: Option<Arc<AtomicBool>>,
    progress: Arc<dyn Progress + Send + Sync>,
    require_untagged: bool,
) {
    match tag_library_membership(
        store,
        subsonic,
        server_id,
        cancel,
        progress,
        require_untagged,
    )
    .await
    {
        Ok(report) if !report.skipped => {
            crate::app_eprintln!(
                "[library-tag] server `{server_id}`: tagged {} tracks across {} folders ({} albums), {} untagged left",
                report.tracks_tagged,
                report.folders_processed,
                report.albums_processed,
                report.untagged_remaining,
            );
        }
        Ok(_) => {}
        Err(SyncError::Cancelled) => {}
        Err(e) => {
            crate::app_eprintln!(
                "[library-tag] server `{server_id}`: best-effort pass failed: {e}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};
    use crate::store::LibraryStore;
    use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
    use serde_json::json;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn track_row(server: &str, id: &str, album_id: &str) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: id.into(),
            title_sort: None,
            artist: Some("A".into()),
            artist_id: Some("ar1".into()),
            album: "Al".into(),
            album_id: Some(album_id.into()),
            album_artist: Some("A".into()),
            duration_sec: 100,
            track_number: Some(1),
            disc_number: Some(1),
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    fn test_client(base: &str) -> SubsonicClient {
        SubsonicClient::with_static_credentials(
            base.to_string(),
            SubsonicCredentials {
                username: "u".into(),
                token: "t".into(),
                salt: "s".into(),
            },
            reqwest::Client::new(),
        )
    }

    #[test]
    fn folders_hash_is_order_independent() {
        let a = vec![
            MusicFolder {
                id: "2".into(),
                name: "B".into(),
            },
            MusicFolder {
                id: "1".into(),
                name: "A".into(),
            },
        ];
        let b = vec![
            MusicFolder {
                id: "1".into(),
                name: "A".into(),
            },
            MusicFolder {
                id: "2".into(),
                name: "B".into(),
            },
        ];
        assert_eq!(folders_hash(&a), folders_hash(&b));
        assert_eq!(folders_hash(&a), "1:A|2:B");
    }

    #[test]
    fn should_run_tagging_pass_gates_no_progress() {
        let prior = TagStateRow {
            folders_hash: "1:Main".into(),
            last_untagged_count: 5,
        };
        assert!(!should_run_tagging_pass(0, None, "1:Main"));
        assert!(!should_run_tagging_pass(5, Some(&prior), "1:Main"));
        assert!(should_run_tagging_pass(4, Some(&prior), "1:Main"));
        assert!(should_run_tagging_pass(5, Some(&prior), "1:Other"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tag_library_membership_tags_by_album_and_respects_prior_tags() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/getMusicFolders.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "musicFolders": {
                        "musicFolder": [
                            { "id": 1, "name": "Main" },
                            { "id": 2, "name": "Other" }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/getAlbumList2.view"))
            .and(query_param("musicFolderId", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": {
                        "album": [{ "id": "alb-a", "name": "A" }]
                    }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/getAlbumList2.view"))
            .and(query_param("musicFolderId", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": {
                        "album": [{ "id": "alb-b", "name": "B" }]
                    }
                }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let mut already = track_row("srv", "t0", "alb-a");
        already.library_id = Some("9".into());
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row("srv", "t1", "alb-a"),
                track_row("srv", "t2", "alb-b"),
                already,
            ])
            .unwrap();

        let report = tag_library_membership(
            &store,
            &test_client(&server.uri()),
            "srv",
            None,
            Arc::new(super::super::progress::NoopProgress),
            false,
        )
        .await
        .unwrap();

        assert!(!report.skipped);
        assert_eq!(report.folders_processed, 2);
        assert_eq!(report.tracks_tagged, 2);
        assert_eq!(report.untagged_remaining, 0);

        let lib1: String = store
            .with_read_conn(|c| {
                c.query_row(
                    "SELECT library_id FROM track WHERE id = 't1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let lib2: String = store
            .with_read_conn(|c| {
                c.query_row(
                    "SELECT library_id FROM track WHERE id = 't2'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let kept: String = store
            .with_read_conn(|c| {
                c.query_row(
                    "SELECT library_id FROM track WHERE id = 't0'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(lib1, "1");
        assert_eq!(lib2, "2");
        assert_eq!(kept, "9");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tag_library_membership_skips_when_no_progress_possible() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/getMusicFolders.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "musicFolders": {
                        "musicFolder": { "id": 1, "name": "Main" }
                    }
                }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track_row("srv", "orphan", "no-album")])
            .unwrap();
        write_tag_state(&store, "srv", "1:Main", 1).unwrap();

        let report = tag_library_membership(
            &store,
            &test_client(&server.uri()),
            "srv",
            None,
            Arc::new(super::super::progress::NoopProgress),
            false,
        )
        .await
        .unwrap();

        assert!(report.skipped);
        assert_eq!(report.albums_processed, 0);
        assert_eq!(report.tracks_tagged, 0);
        assert_eq!(report.untagged_remaining, 1);
    }
}
