//! One-time blocking backfill: populate `track_genre` from existing `track` rows.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Emitter};

use crate::genre_tags::{genres_for_track_extracted, replace_track_genre_rows};
use crate::store::LibraryStore;

pub const GENRE_TAGS_MIGRATION_ID: &str = "genre_tags_v1";

const BATCH_SIZE: i64 = 10_000;

type BackfillTrackRow = (
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn ensure_genre_tags_tables(conn: &mut Connection) -> rusqlite::Result<()> {
    crate::store::ensure_genre_tags_schema(conn)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreTagsInspectDto {
    pub needed: bool,
    pub total_tracks: u64,
    pub done_tracks: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreTagsProgressEvent {
    pub done: u64,
    pub total: u64,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn migration_completed(conn: &Connection) -> Result<bool, rusqlite::Error> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![GENRE_TAGS_MIGRATION_ID],
            |r| r.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn count_live_tracks(conn: &Connection) -> Result<u64, rusqlite::Error> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM track WHERE deleted = 0",
        [],
        |r| r.get(0),
    )?;
    Ok(n.max(0) as u64)
}

fn cursor_rowid(conn: &Connection) -> Result<i64, rusqlite::Error> {
    let rowid: Option<i64> = conn
        .query_row(
            "SELECT cursor_rowid FROM library_data_migration WHERE id = ?1",
            params![GENRE_TAGS_MIGRATION_ID],
            |r| r.get(0),
        )
        .optional()?;
    Ok(rowid.unwrap_or(0))
}

pub fn inspect_genre_tags_backfill(store: &LibraryStore) -> Result<GenreTagsInspectDto, String> {
    store.with_conn_mut("genre_tags.ensure_schema", ensure_genre_tags_tables)?;
    store.with_read_conn(|conn| {
        let total_tracks = count_live_tracks(conn)?;
        if total_tracks == 0 {
            return Ok(GenreTagsInspectDto {
                needed: false,
                total_tracks: 0,
                done_tracks: 0,
            });
        }
        if migration_completed(conn)? {
            return Ok(GenreTagsInspectDto {
                needed: false,
                total_tracks,
                done_tracks: total_tracks,
            });
        }
        let cursor = cursor_rowid(conn)?;
        let done: i64 = conn.query_row(
            "SELECT COUNT(*) FROM track WHERE deleted = 0 AND rowid <= ?1",
            params![cursor],
            |r| r.get(0),
        )?;
        Ok(GenreTagsInspectDto {
            needed: true,
            total_tracks,
            done_tracks: done.max(0) as u64,
        })
    })
}

fn emit_progress(app: &AppHandle, done: u64, total: u64) -> Result<(), String> {
    app.emit(
        "genre_tags:progress",
        GenreTagsProgressEvent { done, total },
    )
    .map_err(|e| e.to_string())
}

pub fn run_genre_tags_backfill(store: &LibraryStore, app: &AppHandle) -> Result<(), String> {
    run_genre_tags_backfill_impl(store, Some(app))
}

fn run_genre_tags_backfill_impl(
    store: &LibraryStore,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let inspect = inspect_genre_tags_backfill(store)?;
    if !inspect.needed {
        return Ok(());
    }
    let total = inspect.total_tracks;

    loop {
        let (batch_done, finished) = store.with_conn_mut("genre_tags.backfill", |conn| {
            if migration_completed(conn)? {
                return Ok::<(i64, bool), rusqlite::Error>((total as i64, true));
            }

            conn.execute(
                "INSERT INTO library_data_migration (id, cursor_rowid, started_at) \
                 VALUES (?1, 0, ?2) \
                 ON CONFLICT(id) DO UPDATE SET \
                   started_at = COALESCE(library_data_migration.started_at, excluded.started_at)",
                params![GENRE_TAGS_MIGRATION_ID, now_unix()],
            )?;

            let cursor = cursor_rowid(conn)?;

            let mut stmt = conn.prepare(
                "SELECT rowid, server_id, id, genre, \
                        CASE WHEN json_valid(raw_json) THEN json_extract(raw_json, '$.genres') END, \
                        album_id, library_id \
                 FROM track \
                 WHERE deleted = 0 AND rowid > ?1 \
                 ORDER BY rowid \
                 LIMIT ?2",
            )?;

            let rows: Vec<BackfillTrackRow> =
                stmt
                    .query_map(params![cursor, BATCH_SIZE], |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;

            if rows.is_empty() {
                conn.execute(
                    "UPDATE library_data_migration SET completed_at = ?2, cursor_rowid = \
                     (SELECT COALESCE(MAX(rowid), 0) FROM track WHERE deleted = 0) \
                     WHERE id = ?1",
                    params![GENRE_TAGS_MIGRATION_ID, now_unix()],
                )?;
                return Ok((total as i64, true));
            }

            let tx = conn.unchecked_transaction()?;
            let mut last_rowid = cursor;
            for (rowid, server_id, track_id, genre, genres_json, album_id, library_id) in rows {
                let genres = genres_for_track_extracted(
                    genres_json.as_deref(),
                    genre.as_deref(),
                );
                replace_track_genre_rows(
                    &tx,
                    &server_id,
                    &track_id,
                    album_id.as_deref(),
                    library_id.as_deref(),
                    &genres,
                )?;
                last_rowid = rowid;
            }
            tx.commit()?;

            conn.execute(
                "UPDATE library_data_migration SET cursor_rowid = ?2 WHERE id = ?1",
                params![GENRE_TAGS_MIGRATION_ID, last_rowid],
            )?;

            let done: i64 = conn.query_row(
                "SELECT COUNT(*) FROM track WHERE deleted = 0 AND rowid <= ?1",
                params![last_rowid],
                |r| r.get(0),
            )?;
            Ok((done, false))
        })?;

        if let Some(app) = app {
            emit_progress(app, batch_done.max(0) as u64, total)?;
        }

        if finished {
            break;
        }
    }

    // Belt-and-suspenders: all live tracks processed but `completed_at` not set
    // (can happen when rowid gaps from soft-deletes make done == total early).
    store.with_conn_mut("genre_tags.backfill.finalize", |conn| {
        if migration_completed(conn)? {
            return Ok(());
        }
        let cursor = cursor_rowid(conn)?;
        let pending: i64 = conn.query_row(
            "SELECT COUNT(*) FROM track WHERE deleted = 0 AND rowid > ?1",
            params![cursor],
            |r| r.get(0),
        )?;
        if pending == 0 {
            conn.execute(
                "UPDATE library_data_migration SET completed_at = ?2, cursor_rowid = \
                 (SELECT COALESCE(MAX(rowid), 0) FROM track WHERE deleted = 0) \
                 WHERE id = ?1",
                params![GENRE_TAGS_MIGRATION_ID, now_unix()],
            )?;
        }
        Ok(())
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::track::{TrackRepository, TrackRow};
    use crate::store::LibraryStore;

    fn track(server_id: &str, id: &str, genre: &str, deleted: bool) -> TrackRow {
        TrackRow {
            server_id: server_id.into(),
            id: id.into(),
            title: id.into(),
            title_sort: None,
            artist: Some("Artist".into()),
            artist_id: None,
            album: "Album".into(),
            album_id: Some("al1".into()),
            album_artist: None,
            duration_sec: 100,
            track_number: Some(1),
            disc_number: Some(1),
            year: None,
            genre: Some(genre.into()),
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: Some("lib1".into()),
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    #[test]
    fn backfill_marks_complete_when_rowid_gaps_leave_pending_rows() {
        let store = LibraryStore::open_in_memory();
        let live: Vec<TrackRow> = (1..=5)
            .map(|n| track("s1", &format!("t{n}"), "Rock", false))
            .collect();
        let mut batch = live;
        for n in 6..=20 {
            batch.push(track("s1", &format!("del{n}"), "Rock", true));
        }
        batch.push(track("s1", "t6", "Jazz", false));
        TrackRepository::new(&store).upsert_batch(&batch).unwrap();

        run_genre_tags_backfill_impl(&store, None).unwrap();

        let inspect = inspect_genre_tags_backfill(&store).unwrap();
        assert!(!inspect.needed, "backfill should complete despite rowid gaps");
    }
}
