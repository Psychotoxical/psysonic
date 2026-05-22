//! Append-only player listening sessions (`play_session`).

mod cluster;
mod completion;

#[cfg(test)]
mod tests;

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension};

use crate::dto::{
    PlaySessionDayDetailDto, PlaySessionDayTrackDto, PlaySessionDayTotalsDto,
    PlaySessionHeatmapDayDto, PlaySessionInputDto, PlaySessionRecentDayDto,
    PlaySessionYearBoundsDto, PlaySessionYearSummaryDto,
};
use crate::store::LibraryStore;

use cluster::{count_listening_sessions, PlaySpan};
use completion::{
    completion_from_position, effective_duration_sec, MIN_LISTENED_SEC,
};

struct DayAgg {
    total_listened_sec: f64,
    track_play_count: u32,
    full_count: u32,
    partial_count: u32,
    plays: Vec<PlaySpan>,
}

fn validate_date_iso(date_iso: &str) -> Result<(), String> {
    if date_iso.len() != 10 || date_iso.as_bytes()[4] != b'-' || date_iso.as_bytes()[7] != b'-' {
        return Err("dateIso must be YYYY-MM-DD".into());
    }
    let year: i32 = date_iso[0..4]
        .parse()
        .map_err(|_| "dateIso must be YYYY-MM-DD".to_string())?;
    let month: u32 = date_iso[5..7]
        .parse()
        .map_err(|_| "dateIso must be YYYY-MM-DD".to_string())?;
    let day: u32 = date_iso[8..10]
        .parse()
        .map_err(|_| "dateIso must be YYYY-MM-DD".to_string())?;
    if year < 1970 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err("dateIso must be YYYY-MM-DD".into());
    }
    Ok(())
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
                let completion =
                    completion_from_position(input.position_max_sec, duration_for_completion);
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
            .map_err(|e| e.to_string())
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
        validate_date_iso(date_iso)?;
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
