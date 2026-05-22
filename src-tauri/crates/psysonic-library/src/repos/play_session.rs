//! Append-only player listening sessions (`play_session`).

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension};

use crate::dto::{
    PlaySessionDayDetailDto, PlaySessionDayTrackDto, PlaySessionDayTotalsDto,
    PlaySessionHeatmapDayDto, PlaySessionInputDto, PlaySessionRecentDayDto,
    PlaySessionYearBoundsDto, PlaySessionYearSummaryDto,
};
use crate::store::LibraryStore;

const MIN_LISTENED_SEC: f64 = 10.0;
const FULL_COMPLETION_RATIO: f64 = 0.70;
/// Idle gap after which the next play starts a new listening session.
const LISTENING_SESSION_GAP_MS: i64 = 30 * 60 * 1000;

#[derive(Clone, Copy)]
struct PlaySpan {
    started_at_ms: i64,
    listened_sec: f64,
}

fn play_end_ms(span: PlaySpan) -> i64 {
    span.started_at_ms + (span.listened_sec * 1000.0) as i64
}

fn count_listening_sessions(plays: &[PlaySpan]) -> u32 {
    if plays.is_empty() {
        return 0;
    }
    let mut sorted = plays.to_vec();
    sorted.sort_by_key(|p| p.started_at_ms);
    let mut sessions = 1u32;
    let mut prev_end = play_end_ms(sorted[0]);
    for span in sorted.iter().skip(1) {
        if span.started_at_ms - prev_end > LISTENING_SESSION_GAP_MS {
            sessions += 1;
        }
        prev_end = prev_end.max(play_end_ms(*span));
    }
    sessions
}

struct DayAgg {
    total_listened_sec: f64,
    track_play_count: u32,
    full_count: u32,
    partial_count: u32,
    plays: Vec<PlaySpan>,
}

pub struct PlaySessionRepository<'a> {
    store: &'a LibraryStore,
}

impl<'a> PlaySessionRepository<'a> {
    pub fn new(store: &'a LibraryStore) -> Self {
        Self { store }
    }

    /// Insert one finalized session. Rejects `listened_sec <= 10` and missing tracks.
    pub fn insert(&self, input: &PlaySessionInputDto) -> Result<(), String> {
        if !input.listened_sec.is_finite() || input.listened_sec <= MIN_LISTENED_SEC {
            return Err(format!(
                "listened_sec must be > {} (got {})",
                MIN_LISTENED_SEC, input.listened_sec
            ));
        }
        if !input.position_max_sec.is_finite() || input.position_max_sec < 0.0 {
            return Err("position_max_sec must be finite and >= 0".into());
        }
        if input.server_id.is_empty() || input.track_id.is_empty() {
            return Err("server_id and track_id are required".into());
        }

        self.store
            .with_conn("play_session.insert", |conn| {
                let duration_sec: i64 = conn
                    .query_row(
                        "SELECT duration_sec FROM track \
                         WHERE server_id = ?1 AND id = ?2 AND deleted = 0",
                        params![input.server_id, input.track_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

                let duration_for_completion =
                    effective_duration_sec(duration_sec, input.duration_sec_hint);
                let completion = completion_from_position(input.position_max_sec, duration_for_completion);
                conn.execute(
                    "INSERT INTO play_session \
                     (server_id, track_id, started_at_ms, listened_sec, position_max_sec, \
                      completion, end_reason) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        input.server_id,
                        input.track_id,
                        input.started_at_ms,
                        input.listened_sec,
                        input.position_max_sec,
                        completion,
                        input.end_reason,
                    ],
                )?;
                Ok(())
            })
    }

    pub fn year_summary(&self, year: i32) -> Result<PlaySessionYearSummaryDto, String> {
        let year_str = year.to_string();
        self.store
            .with_read_conn(|conn| {
                let totals = conn.query_row(
                    "SELECT \
                       COALESCE(SUM(listened_sec), 0.0), \
                       COUNT(*), \
                       COUNT(DISTINCT server_id || ':' || track_id), \
                       COUNT(DISTINCT date(started_at_ms / 1000, 'unixepoch', 'localtime')), \
                       COALESCE(SUM(CASE WHEN completion = 'full' THEN 1 ELSE 0 END), 0), \
                       COALESCE(SUM(CASE WHEN completion = 'partial' THEN 1 ELSE 0 END), 0) \
                     FROM play_session \
                     WHERE strftime('%Y', started_at_ms / 1000, 'unixepoch', 'localtime') = ?1",
                    params![year_str],
                    |row| {
                        Ok((
                            row.get::<_, f64>(0)?,
                            row.get::<_, i64>(1)? as u32,
                            row.get::<_, i64>(2)? as u32,
                            row.get::<_, i64>(3)? as u32,
                            row.get::<_, i64>(4)? as u32,
                            row.get::<_, i64>(5)? as u32,
                        ))
                    },
                )?;

                let mut stmt = conn.prepare(
                    "SELECT started_at_ms, listened_sec \
                     FROM play_session \
                     WHERE strftime('%Y', started_at_ms / 1000, 'unixepoch', 'localtime') = ?1 \
                     ORDER BY started_at_ms ASC",
                )?;
                let plays = stmt
                    .query_map(params![year_str], |row| {
                        Ok(PlaySpan {
                            started_at_ms: row.get(0)?,
                            listened_sec: row.get(1)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;

                let (
                    total_listened_sec,
                    track_play_count,
                    unique_track_count,
                    listening_day_count,
                    full_count,
                    partial_count,
                ) = totals;
                Ok(PlaySessionYearSummaryDto {
                    total_listened_sec,
                    session_count: count_listening_sessions(&plays),
                    track_play_count,
                    unique_track_count,
                    listening_day_count,
                    full_count,
                    partial_count,
                })
            })
            .map_err(|e| e.to_string())
    }

    pub fn heatmap(&self, year: i32) -> Result<Vec<PlaySessionHeatmapDayDto>, String> {
        let year_str = year.to_string();
        self.store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT \
                       date(started_at_ms / 1000, 'unixepoch', 'localtime') AS d, \
                       COUNT(*) AS n \
                     FROM play_session \
                     WHERE strftime('%Y', started_at_ms / 1000, 'unixepoch', 'localtime') = ?1 \
                     GROUP BY d \
                     ORDER BY d ASC",
                )?;
                let rows = stmt
                    .query_map(params![year_str], |row| {
                        Ok(PlaySessionHeatmapDayDto {
                            date: row.get(0)?,
                            track_play_count: row.get::<_, i64>(1)? as u32,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .map_err(|e| e.to_string())
    }

    pub fn day_detail(&self, date_iso: &str) -> Result<PlaySessionDayDetailDto, String> {
        if date_iso.len() != 10 || date_iso.as_bytes()[4] != b'-' || date_iso.as_bytes()[7] != b'-' {
            return Err("dateIso must be YYYY-MM-DD".into());
        }
        self.store
            .with_read_conn(|conn| {
                let totals_row = conn.query_row(
                    "SELECT \
                       COALESCE(SUM(listened_sec), 0.0), \
                       COUNT(*), \
                       COALESCE(SUM(CASE WHEN completion = 'full' THEN 1 ELSE 0 END), 0), \
                       COALESCE(SUM(CASE WHEN completion = 'partial' THEN 1 ELSE 0 END), 0) \
                     FROM play_session \
                     WHERE date(started_at_ms / 1000, 'unixepoch', 'localtime') = ?1",
                    params![date_iso],
                    |row| {
                        Ok((
                            row.get::<_, f64>(0)?,
                            row.get::<_, i64>(1)? as u32,
                            row.get::<_, i64>(2)? as u32,
                            row.get::<_, i64>(3)? as u32,
                        ))
                    },
                )?;

                let mut stmt = conn.prepare(
                    "SELECT ps.server_id, ps.track_id, t.title, t.artist, \
                            ps.listened_sec, ps.completion, ps.started_at_ms \
                     FROM play_session ps \
                     JOIN track t ON t.server_id = ps.server_id AND t.id = ps.track_id \
                     WHERE date(ps.started_at_ms / 1000, 'unixepoch', 'localtime') = ?1 \
                     ORDER BY ps.started_at_ms DESC",
                )?;
                let tracks = stmt
                    .query_map(params![date_iso], |row| {
                        Ok(PlaySessionDayTrackDto {
                            server_id: row.get(0)?,
                            track_id: row.get(1)?,
                            title: row.get(2)?,
                            artist: row.get(3)?,
                            listened_sec: row.get(4)?,
                            completion: row.get(5)?,
                            started_at_ms: row.get(6)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;

                let plays: Vec<PlaySpan> = tracks
                    .iter()
                    .map(|t| PlaySpan {
                        started_at_ms: t.started_at_ms,
                        listened_sec: t.listened_sec,
                    })
                    .collect();
                let (total_listened_sec, track_play_count, full_count, partial_count) = totals_row;
                let totals = PlaySessionDayTotalsDto {
                    total_listened_sec,
                    session_count: count_listening_sessions(&plays),
                    track_play_count,
                    full_count,
                    partial_count,
                };

                Ok(PlaySessionDayDetailDto { totals, tracks })
            })
            .map_err(|e| e.to_string())
    }

    /// Calendar years that contain at least one session (local TZ).
    pub fn year_bounds(&self) -> Result<PlaySessionYearBoundsDto, String> {
        self.store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT \
                       MIN(CAST(strftime('%Y', started_at_ms / 1000, 'unixepoch', 'localtime') AS INTEGER)), \
                       MAX(CAST(strftime('%Y', started_at_ms / 1000, 'unixepoch', 'localtime') AS INTEGER)) \
                     FROM play_session",
                    [],
                    |row| {
                        Ok(PlaySessionYearBoundsDto {
                            min_year: row.get::<_, Option<i64>>(0)?.map(|y| y as i32),
                            max_year: row.get::<_, Option<i64>>(1)?.map(|y| y as i32),
                        })
                    },
                )
            })
            .map_err(|e| e.to_string())
    }

    /// Most recent calendar days with sessions (newest first).
    pub fn recent_days(&self, limit: u32) -> Result<Vec<PlaySessionRecentDayDto>, String> {
        let limit = limit.clamp(1, 90);
        self.store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT \
                       date(started_at_ms / 1000, 'unixepoch', 'localtime') AS d, \
                       started_at_ms, listened_sec, completion \
                     FROM play_session \
                     ORDER BY d DESC, started_at_ms ASC",
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, f64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?;

                let mut by_day: HashMap<String, DayAgg> = HashMap::new();
                for row in rows {
                    let (date, started_at_ms, listened_sec, completion) = row?;
                    let agg = by_day.entry(date).or_insert_with(|| DayAgg {
                        total_listened_sec: 0.0,
                        track_play_count: 0,
                        full_count: 0,
                        partial_count: 0,
                        plays: Vec::new(),
                    });
                    agg.total_listened_sec += listened_sec;
                    agg.track_play_count += 1;
                    if completion == "full" {
                        agg.full_count += 1;
                    } else {
                        agg.partial_count += 1;
                    }
                    agg.plays.push(PlaySpan {
                        started_at_ms,
                        listened_sec,
                    });
                }

                let mut out: Vec<PlaySessionRecentDayDto> = by_day
                    .into_iter()
                    .map(|(date, agg)| PlaySessionRecentDayDto {
                        date,
                        total_listened_sec: agg.total_listened_sec,
                        session_count: count_listening_sessions(&agg.plays),
                        track_play_count: agg.track_play_count,
                        full_count: agg.full_count,
                        partial_count: agg.partial_count,
                    })
                    .collect();
                out.sort_by(|a, b| b.date.cmp(&a.date));
                out.truncate(limit as usize);
                Ok(out)
            })
            .map_err(|e| e.to_string())
    }
}

fn effective_duration_sec(db_duration_sec: i64, hint: Option<i64>) -> i64 {
    let hint = hint.filter(|d| *d > 0).unwrap_or(0);
    if db_duration_sec > 0 && hint > 0 {
        return db_duration_sec.max(hint);
    }
    if db_duration_sec > 0 {
        return db_duration_sec;
    }
    hint
}

fn completion_from_position(position_max_sec: f64, duration_sec: i64) -> &'static str {
    if duration_sec <= 0 {
        return "partial";
    }
    if position_max_sec / duration_sec as f64 >= FULL_COMPLETION_RATIO {
        "full"
    } else {
        "partial"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};

    fn seed_track(store: &LibraryStore, server_id: &str, track_id: &str, duration_sec: i64) {
        TrackRepository::new(store)
            .upsert_batch(&[TrackRow {
                server_id: server_id.into(),
                id: track_id.into(),
                title: "Test".into(),
                title_sort: None,
                artist: Some("Artist".into()),
                artist_id: None,
                album: "Album".into(),
                album_id: None,
                album_artist: None,
                duration_sec,
                track_number: None,
                disc_number: None,
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
                content_hash: None,
                server_updated_at: None,
                server_created_at: None,
                deleted: false,
                synced_at: 1,
                raw_json: "{}".into(),
            }])
            .expect("seed track");
    }

    #[test]
    fn insert_rejects_short_sessions() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1", 200);
        let repo = PlaySessionRepository::new(&store);
        let input = PlaySessionInputDto {
            server_id: "s1".into(),
            track_id: "t1".into(),
            started_at_ms: 1_000,
            listened_sec: 10.0,
            position_max_sec: 50.0,
            end_reason: "ended".into(),
            duration_sec_hint: None,
        };
        assert!(repo.insert(&input).is_err());
    }

    #[test]
    fn insert_full_vs_partial_completion() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1", 100);
        let repo = PlaySessionRepository::new(&store);

        repo.insert(&PlaySessionInputDto {
            server_id: "s1".into(),
            track_id: "t1".into(),
            started_at_ms: 1_000,
            listened_sec: 80.0,
            position_max_sec: 75.0,
            end_reason: "ended".into(),
            duration_sec_hint: None,
        })
        .expect("insert full");

        repo.insert(&PlaySessionInputDto {
            server_id: "s1".into(),
            track_id: "t1".into(),
            started_at_ms: 2_000,
            listened_sec: 30.0,
            position_max_sec: 40.0,
            end_reason: "skip".into(),
            duration_sec_hint: None,
        })
        .expect("insert partial");

        let summary = repo.year_summary(1970).expect("summary");
        assert_eq!(summary.track_play_count, 2);
        assert_eq!(summary.session_count, 1);
        assert_eq!(summary.unique_track_count, 1);
        assert_eq!(summary.listening_day_count, 1);
        assert_eq!(summary.full_count, 1);
        assert_eq!(summary.partial_count, 1);
    }

    #[test]
    fn listening_sessions_cluster_by_idle_gap() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1", 200);
        seed_track(&store, "s1", "t2", 200);
        seed_track(&store, "s1", "t3", 200);
        let repo = PlaySessionRepository::new(&store);
        let base = 1_700_000_000_000_i64;
        let insert = |offset_ms: i64, track_id: &str| {
            repo.insert(&PlaySessionInputDto {
                server_id: "s1".into(),
                track_id: track_id.into(),
                started_at_ms: base + offset_ms,
                listened_sec: 120.0,
                position_max_sec: 100.0,
                end_reason: "ended".into(),
                duration_sec_hint: None,
            })
            .expect("insert");
        };
        // Three plays within 30 min → one session.
        insert(0, "t1");
        insert(5 * 60 * 1000, "t2");
        insert(10 * 60 * 1000, "t3");
        // Gap > 30 min → second session.
        insert(45 * 60 * 1000, "t1");

        let year = repo
            .year_bounds()
            .expect("bounds")
            .max_year
            .expect("year with data");
        let summary = repo.year_summary(year).expect("summary");
        assert_eq!(summary.track_play_count, 4);
        assert_eq!(summary.session_count, 2);
        assert_eq!(summary.unique_track_count, 3);
        assert_eq!(summary.listening_day_count, 1);

        let heat = repo.heatmap(year).expect("heatmap");
        assert_eq!(heat.len(), 1);
        assert_eq!(heat[0].track_play_count, 4);

        let days = repo.recent_days(10).expect("recent");
        assert_eq!(days[0].track_play_count, 4);
        assert_eq!(days[0].session_count, 2);
    }

    #[test]
    fn year_bounds_empty_and_populated() {
        let store = LibraryStore::open_in_memory();
        let repo = PlaySessionRepository::new(&store);
        let empty = repo.year_bounds().expect("empty bounds");
        assert_eq!(empty.min_year, None);
        assert_eq!(empty.max_year, None);

        seed_track(&store, "s1", "t1", 200);
        seed_track(&store, "s1", "t2", 200);
        let insert = |started_at_ms: i64, track_id: &str| {
            repo.insert(&PlaySessionInputDto {
                server_id: "s1".into(),
                track_id: track_id.into(),
                started_at_ms,
                listened_sec: 20.0,
                position_max_sec: 15.0,
                end_reason: "ended".into(),
                duration_sec_hint: None,
            })
            .expect("insert");
        };
        // 2020-01-01 and 2021-01-01 UTC — stable across TZ for year extraction.
        insert(1_577_836_800_000, "t1");
        insert(1_609_459_200_000, "t2");

        let bounds = repo.year_bounds().expect("bounds");
        assert_eq!(bounds.min_year, Some(2020));
        assert_eq!(bounds.max_year, Some(2021));
    }

    #[test]
    fn recent_days_newest_first_with_limit() {
        let store = LibraryStore::open_in_memory();
        let repo = PlaySessionRepository::new(&store);
        seed_track(&store, "s1", "t1", 200);
        seed_track(&store, "s1", "t2", 200);
        let insert = |started_at_ms: i64, track_id: &str| {
            repo.insert(&PlaySessionInputDto {
                server_id: "s1".into(),
                track_id: track_id.into(),
                started_at_ms,
                listened_sec: 20.0,
                position_max_sec: 15.0,
                end_reason: "ended".into(),
                duration_sec_hint: None,
            })
            .expect("insert");
        };
        insert(1_577_836_800_000, "t1"); // 2020-01-01
        insert(1_609_459_200_000, "t2"); // 2021-01-01

        let days = repo.recent_days(30).expect("recent");
        assert_eq!(days.len(), 2);
        assert_eq!(days[0].date, "2021-01-01");
        assert_eq!(days[1].date, "2020-01-01");
        assert_eq!(days[0].session_count, 1);
        assert_eq!(days[0].track_play_count, 1);
    }

    #[test]
    fn zero_index_duration_uses_hint_and_stays_partial() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1", 0);
        let repo = PlaySessionRepository::new(&store);
        repo.insert(&PlaySessionInputDto {
            server_id: "s1".into(),
            track_id: "t1".into(),
            started_at_ms: 1_000,
            listened_sec: 45.0,
            position_max_sec: 40.0,
            end_reason: "skip".into(),
            duration_sec_hint: Some(300),
        })
        .expect("insert");

        let detail = repo.day_detail("1970-01-01").expect("detail");
        assert_eq!(detail.tracks[0].completion, "partial");
    }

    #[test]
    fn zero_duration_without_hint_is_partial_not_full() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1", 0);
        let repo = PlaySessionRepository::new(&store);
        repo.insert(&PlaySessionInputDto {
            server_id: "s1".into(),
            track_id: "t1".into(),
            started_at_ms: 1_000,
            listened_sec: 45.0,
            position_max_sec: 40.0,
            end_reason: "skip".into(),
            duration_sec_hint: None,
        })
        .expect("insert");

        let detail = repo.day_detail("1970-01-01").expect("detail");
        assert_eq!(detail.tracks[0].completion, "partial");
    }

    #[test]
    fn corrupt_short_db_duration_prefers_player_hint() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "s1", "t1", 1);
        let repo = PlaySessionRepository::new(&store);
        repo.insert(&PlaySessionInputDto {
            server_id: "s1".into(),
            track_id: "t1".into(),
            started_at_ms: 1_000,
            listened_sec: 45.0,
            position_max_sec: 40.0,
            end_reason: "skip".into(),
            duration_sec_hint: Some(300),
        })
        .expect("insert");

        let detail = repo.day_detail("1970-01-01").expect("detail");
        assert_eq!(detail.tracks[0].completion, "partial");
    }
}
