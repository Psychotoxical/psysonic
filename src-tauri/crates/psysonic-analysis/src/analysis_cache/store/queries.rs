use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use super::{
    normalize_track_id, track_id_cache_variants, waveform_cache_blob_len_ok, AnalysisCache,
    ContentCacheCoverage, FailedTrackEntry, LoudnessSnapshot, TrackKey, WaveformEntry,
    LOUDNESS_ALGO_VERSION, WAVEFORM_ALGO_VERSION,
};

impl AnalysisCache {
    pub fn get_waveform(&self, key: &TrackKey) -> Result<Option<WaveformEntry>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let row = conn
            .query_row(
                r#"
            SELECT w.bins, w.bin_count, w.is_partial, w.known_until_sec, w.duration_sec, w.updated_at
            FROM waveform_cache w
            JOIN analysis_track a
              ON a.server_id = w.server_id
             AND a.track_id = w.track_id
             AND a.md5_16kb = w.md5_16kb
            WHERE w.server_id = ?1
              AND w.track_id = ?2
              AND w.md5_16kb = ?3
              AND a.waveform_algo_version = ?4
            "#,
                params![key.server_id, key.track_id, key.md5_16kb, WAVEFORM_ALGO_VERSION],
                |row| {
                    Ok(WaveformEntry {
                        bins: row.get(0)?,
                        bin_count: row.get(1)?,
                        is_partial: row.get::<_, i64>(2)? != 0,
                        known_until_sec: row.get(3)?,
                        duration_sec: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row.filter(|e| waveform_cache_blob_len_ok(&e.bins, e.bin_count)))
    }

    /// Lookup waveform + loudness for an exact content fingerprint, trying bare /
    /// `stream:` track-id variants.
    pub fn content_cache_coverage(
        &self,
        server_id: &str,
        track_id: &str,
        md5_16kb: &str,
    ) -> Result<ContentCacheCoverage, String> {
        let mut has_waveform = false;
        let mut has_loudness = false;
        for tid in track_id_cache_variants(track_id) {
            if !server_id.is_empty() {
                let key = TrackKey {
                    server_id: server_id.to_string(),
                    track_id: tid.clone(),
                    md5_16kb: md5_16kb.to_string(),
                };
                if self.get_waveform(&key)?.is_some() {
                    has_waveform = true;
                }
                if self.loudness_row_exists_for_key(&key)? {
                    has_loudness = true;
                }
            }
        }
        Ok(ContentCacheCoverage {
            has_waveform,
            has_loudness,
        })
    }

    /// True when this exact `(track_id, md5_16kb)` has a loudness row for the current algo version.
    /// Used after `delete_loudness_for_track_id`: waveform may still be cached, but EBU data was removed.
    pub fn loudness_row_exists_for_key(&self, key: &TrackKey) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let exists: i64 = conn
            .query_row(
                r#"
            SELECT EXISTS (
              SELECT 1
              FROM loudness_cache l
              JOIN analysis_track a
                ON a.server_id = l.server_id
               AND a.track_id = l.track_id
               AND a.md5_16kb = l.md5_16kb
              WHERE l.server_id = ?1
                AND l.track_id = ?2
                AND l.md5_16kb = ?3
                AND a.loudness_algo_version = ?4
            )
            "#,
                params![
                    key.server_id,
                    key.track_id,
                    key.md5_16kb,
                    LOUDNESS_ALGO_VERSION
                ],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(exists != 0)
    }

    /// Latest waveform for `(server_id, track_id)` (tries both id variants).
    pub fn get_latest_waveform_for_track(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<Option<WaveformEntry>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        query_latest_waveform_scoped(&conn, server_id, track_id)
    }

    /// Latest `md5_16kb` fingerprint for `(server_id, track_id)`.
    pub fn get_latest_md5_16kb_for_track(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        query_latest_md5_16kb_scoped(&conn, server_id, track_id)
    }

    /// Latest analysis status row for `(server_id, track_id)` (tries bare and
    /// `stream:` variants). Used to suppress infinite retries for tracks that
    /// repeatedly fail decode/enrichment.
    pub fn get_latest_status_for_track(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<Option<(String, i64)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        query_latest_status_scoped(&conn, server_id, track_id)
    }

    pub fn count_failed_tracks(&self, server_id: &str) -> Result<i64, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        query_failed_tracks_count_scoped(&conn, server_id)
    }

    pub fn list_failed_tracks(
        &self,
        server_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<FailedTrackEntry>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        query_failed_tracks_scoped(&conn, server_id, limit)
    }

    /// Both waveform and loudness rows exist for this `(server_id, track_id)` —
    /// a CPU seed from bytes/file would only decode the file to immediately skip
    /// with `SkippedWaveformCacheHit`.
    pub fn cpu_seed_redundant_for_track(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<bool, String> {
        Ok(self
            .get_latest_waveform_for_track(server_id, track_id)?
            .is_some()
            && self
                .get_latest_loudness_for_track(server_id, track_id)?
                .is_some())
    }

    /// Latest loudness for `(server_id, track_id)`.
    pub fn get_latest_loudness_for_track(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<Option<LoudnessSnapshot>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        query_latest_loudness_scoped(&conn, server_id, track_id)
    }
}

/// Server-scoped variant of the "latest waveform for this track" lookup: filters
/// `waveform_cache` to `server_id` and tries both id variants (bare ↔ `stream:`).
fn query_latest_waveform_scoped(
    conn: &Connection,
    server_id: &str,
    track_id: &str,
) -> Result<Option<WaveformEntry>, String> {
    const SQL: &str = r#"
        SELECT w.bins, w.bin_count, w.is_partial, w.known_until_sec, w.duration_sec, w.updated_at
        FROM waveform_cache w
        JOIN analysis_track a
          ON a.server_id = w.server_id
         AND a.track_id = w.track_id
         AND a.md5_16kb = w.md5_16kb
        WHERE w.server_id = ?1
          AND w.track_id = ?2
          AND a.waveform_algo_version = ?3
        ORDER BY w.updated_at DESC
        LIMIT 1
        "#;
    for tid in track_id_cache_variants(track_id) {
        let row = conn
            .query_row(SQL, params![server_id, tid, WAVEFORM_ALGO_VERSION], |row| {
                Ok(WaveformEntry {
                    bins: row.get(0)?,
                    bin_count: row.get(1)?,
                    is_partial: row.get::<_, i64>(2)? != 0,
                    known_until_sec: row.get(3)?,
                    duration_sec: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(e) = row {
            if waveform_cache_blob_len_ok(&e.bins, e.bin_count) {
                return Ok(Some(e));
            }
        }
    }
    Ok(None)
}

fn query_latest_md5_16kb_scoped(
    conn: &Connection,
    server_id: &str,
    track_id: &str,
) -> Result<Option<String>, String> {
    const SQL: &str = r#"
        SELECT w.md5_16kb
        FROM waveform_cache w
        JOIN analysis_track a
          ON a.server_id = w.server_id
         AND a.track_id = w.track_id
         AND a.md5_16kb = w.md5_16kb
        WHERE w.server_id = ?1
          AND w.track_id = ?2
          AND a.waveform_algo_version = ?3
        ORDER BY w.updated_at DESC
        LIMIT 1
        "#;
    for tid in track_id_cache_variants(track_id) {
        let row: Option<String> = conn
            .query_row(SQL, params![server_id, tid, WAVEFORM_ALGO_VERSION], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(md5) = row {
            if !md5.is_empty() {
                return Ok(Some(md5));
            }
        }
    }
    Ok(None)
}

fn query_latest_status_scoped(
    conn: &Connection,
    server_id: &str,
    track_id: &str,
) -> Result<Option<(String, i64)>, String> {
    const SQL: &str = r#"
        SELECT status, updated_at
        FROM analysis_track
        WHERE server_id = ?1
          AND track_id = ?2
        ORDER BY updated_at DESC
        LIMIT 1
        "#;
    let mut latest: Option<(String, i64)> = None;
    for tid in track_id_cache_variants(track_id) {
        let row = conn
            .query_row(SQL, params![server_id, tid], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(candidate) = row {
            let take = latest.as_ref().is_none_or(|(_, ts)| candidate.1 > *ts);
            if take {
                latest = Some(candidate);
            }
        }
    }
    Ok(latest)
}

fn query_failed_tracks_count_scoped(conn: &Connection, server_id: &str) -> Result<i64, String> {
    conn.query_row(
        r#"
        SELECT COUNT(DISTINCT normalized_track_id)
        FROM (
          SELECT CASE
                   WHEN track_id LIKE 'stream:%' THEN SUBSTR(track_id, 8)
                   ELSE track_id
                 END AS normalized_track_id
          FROM analysis_track
          WHERE server_id = ?1
            AND status = 'failed'
        )
        WHERE normalized_track_id IS NOT NULL
          AND normalized_track_id != ''
        "#,
        params![server_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn query_failed_tracks_scoped(
    conn: &Connection,
    server_id: &str,
    limit: Option<usize>,
) -> Result<Vec<FailedTrackEntry>, String> {
    const SQL: &str = r#"
        SELECT track_id, md5_16kb, updated_at
        FROM analysis_track
        WHERE server_id = ?1
          AND status = 'failed'
        ORDER BY updated_at DESC
        "#;
    let mut stmt = conn.prepare(SQL).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![server_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out: Vec<FailedTrackEntry> = Vec::new();
    let mut seen = HashSet::<String>::new();
    for row in rows {
        let (track_id_raw, md5_16kb, updated_at) = row.map_err(|e| e.to_string())?;
        let normalized = normalize_track_id(track_id_raw.trim());
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }
        out.push(FailedTrackEntry {
            track_id: normalized,
            md5_16kb,
            updated_at,
        });
        if limit.is_some_and(|n| out.len() >= n) {
            break;
        }
    }
    Ok(out)
}

/// Server-scoped variant of the "latest loudness for this track" lookup.
fn query_latest_loudness_scoped(
    conn: &Connection,
    server_id: &str,
    track_id: &str,
) -> Result<Option<LoudnessSnapshot>, String> {
    const SQL: &str = r#"
        SELECT l.integrated_lufs, l.true_peak, l.recommended_gain_db, l.target_lufs, l.updated_at
        FROM loudness_cache l
        JOIN analysis_track a
          ON a.server_id = l.server_id
         AND a.track_id = l.track_id
         AND a.md5_16kb = l.md5_16kb
        WHERE l.server_id = ?1
          AND l.track_id = ?2
          AND a.loudness_algo_version = ?3
        ORDER BY l.updated_at DESC
        LIMIT 1
        "#;
    for tid in track_id_cache_variants(track_id) {
        let row = conn
            .query_row(SQL, params![server_id, tid, LOUDNESS_ALGO_VERSION], |row| {
                Ok(LoudnessSnapshot {
                    integrated_lufs: row.get(0)?,
                    true_peak: row.get(1)?,
                    recommended_gain_db: row.get(2)?,
                    target_lufs: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if row.is_some() {
            return Ok(row);
        }
    }
    Ok(None)
}
