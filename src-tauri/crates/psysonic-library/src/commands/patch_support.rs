use rusqlite::params;
use serde_json::Value;

use crate::runtime::LibraryRuntime;

/// Record the playback-derived `md5_16kb` as `track.content_hash` for
/// `(server_id, track_id)` (E2). A no-op when the value is empty or the library
/// has no row for that pair (index off for the server). Shared by the
/// analysis→library content_hash bridge (registered in the shell crate) and by
/// [`super::library_patch_track`]'s `contentHash` field. The playback hash is
/// authoritative, so this overwrites unconditionally; sync ingest preserves it
/// via `COALESCE(NULLIF(excluded.content_hash,''), …)` in the upsert.
pub fn patch_content_hash(
    runtime: &LibraryRuntime,
    server_id: &str,
    track_id: &str,
    md5_16kb: &str,
) -> Result<(), String> {
    if md5_16kb.is_empty() {
        return Ok(());
    }
    runtime
        .store
        .with_conn("cmd.patch_content_hash", |conn| {
            conn.execute(
                "UPDATE track SET content_hash = ?3 \
                 WHERE server_id = ?1 AND id = ?2",
                params![server_id, track_id, md5_16kb],
            )?;
            Ok(())
        })
        .map_err(|e| e.to_string())
}

/// Apply a sparse `library_patch_track` JSON patch (extracted from the command
/// so it is unit-testable without a Tauri `State`). Only fields explicitly
/// present in `patch` are applied; absent keys leave the column untouched. For
/// the nullable integer fields, an explicit `null` clears the column (e.g.
/// `unstar` → `starredAt: null`): `.map` keeps the present/absent distinction
/// (outer `Some` = key present), `as_i64()` yields the value or `None` → bound
/// as SQL NULL. Spec §6.5 patch-on-use: `starred_at`, `user_rating`,
/// `play_count`, `played_at`; §8.1 E2: `content_hash`. All UPDATEs no-op when
/// the library has no row for `(server_id, track_id)`.
pub(super) fn apply_track_patch(
    runtime: &LibraryRuntime,
    server_id: &str,
    track_id: &str,
    patch: &Value,
) -> Result<(), String> {
    let starred_at = patch.get("starredAt").map(|v| v.as_i64());
    let user_rating = patch.get("userRating").map(|v| v.as_i64());
    let play_count = patch.get("playCount").map(|v| v.as_i64());
    let played_at = patch.get("playedAt").map(|v| v.as_i64());
    let content_hash = patch
        .get("contentHash")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    runtime
        .store
        .with_conn("cmd.patch_track", |conn| {
            // One UPDATE per field present — keeps SQL simple and
            // matches the spec's per-field patch semantics.
            if let Some(v) = starred_at {
                conn.execute(
                    "UPDATE track SET starred_at = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, track_id, v],
                )?;
            }
            if let Some(v) = user_rating {
                conn.execute(
                    "UPDATE track SET user_rating = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, track_id, v],
                )?;
            }
            if let Some(v) = play_count {
                conn.execute(
                    "UPDATE track SET play_count = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, track_id, v],
                )?;
            }
            if let Some(v) = played_at {
                conn.execute(
                    "UPDATE track SET played_at = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, track_id, v],
                )?;
            }
            if let Some(v) = content_hash {
                conn.execute(
                    "UPDATE track SET content_hash = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, track_id, v],
                )?;
            }
            Ok(())
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::commands::test_support::{make_row, runtime};
    use crate::repos::TrackRepository;
    use crate::store::LibraryStore;

    #[test]
    fn patch_content_hash_sets_value_and_noops_on_absent_or_empty() {
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[make_row("s1", "tr_1", "al_1", 1)])
            .unwrap();
        let rt = runtime(store.clone());

        let read = |store: &LibraryStore| -> Option<String> {
            store
                .with_conn("misc", |c| {
                    c.query_row(
                        "SELECT content_hash FROM track WHERE server_id='s1' AND id='tr_1'",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap()
        };

        // No-ops leave the existing value untouched: empty md5, and a row that
        // doesn't exist (the absent-row case is how "index off" stays a no-op).
        patch_content_hash(&rt, "s1", "tr_1", "").unwrap();
        patch_content_hash(&rt, "s1", "missing", "deadbeef").unwrap();
        assert_eq!(read(&store).as_deref(), Some("hash-tr_1"));

        patch_content_hash(&rt, "s1", "tr_1", "md5-playback").unwrap();
        assert_eq!(read(&store).as_deref(), Some("md5-playback"));
    }

    #[test]
    fn apply_track_patch_sets_clears_and_leaves_fields() {
        // §6.5 patch-on-use: present value sets, explicit null clears, absent key
        // leaves the column untouched — so `unstar` ({starredAt:null}) actually
        // un-stars the local row.
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[make_row("s1", "tr_1", "al_1", 1)])
            .unwrap();
        let rt = runtime(store.clone());
        let read = |store: &LibraryStore| -> (Option<i64>, Option<i64>) {
            store
                .with_conn("misc", |c| {
                    c.query_row(
                        "SELECT starred_at, user_rating FROM track WHERE server_id='s1' AND id='tr_1'",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                })
                .unwrap()
        };

        apply_track_patch(
            &rt,
            "s1",
            "tr_1",
            &serde_json::json!({ "starredAt": 1700, "userRating": 4 }),
        )
        .unwrap();
        assert_eq!(read(&store), (Some(1700), Some(4)));

        // Explicit null clears starred_at; absent userRating stays.
        apply_track_patch(&rt, "s1", "tr_1", &serde_json::json!({ "starredAt": null })).unwrap();
        assert_eq!(
            read(&store),
            (None, Some(4)),
            "null clears, absent key untouched"
        );

        // Empty patch is a no-op.
        apply_track_patch(&rt, "s1", "tr_1", &serde_json::json!({})).unwrap();
        assert_eq!(read(&store), (None, Some(4)));
    }
}
