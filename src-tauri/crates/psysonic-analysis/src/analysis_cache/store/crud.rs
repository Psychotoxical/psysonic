use rusqlite::params;

use super::{
    now_unix_ts, track_id_cache_variants, AnalysisCache, AnalysisDeleteServerReport, LoudnessEntry,
    TrackKey, WaveformEntry, LOUDNESS_ALGO_VERSION, WAVEFORM_ALGO_VERSION,
};

impl AnalysisCache {
    /// Remove `loudness_cache` rows for this logical track (bare id and `stream:`
    /// variant) scoped to one server. A reseed on server A must not delete
    /// server B's analysis for the same bare `track_id`.
    pub fn delete_loudness_for_track_id(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<u64, String> {
        if track_id.trim().is_empty() {
            return Ok(0);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let mut total: u64 = 0;
        for tid in track_id_cache_variants(track_id) {
            let n = conn
                .execute(
                    "DELETE FROM loudness_cache WHERE track_id = ?1 AND server_id = ?2",
                    params![tid, server_id],
                )
                .map_err(|e| e.to_string())?;
            total = total.saturating_add(n as u64);
        }
        Ok(total)
    }

    /// Remove `waveform_cache` rows for this logical track (bare id and `stream:`
    /// variant) scoped to one server. See [`Self::delete_loudness_for_track_id`]
    /// for the scoping rationale.
    pub fn delete_waveform_for_track_id(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<u64, String> {
        if track_id.trim().is_empty() {
            return Ok(0);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let mut total: u64 = 0;
        for tid in track_id_cache_variants(track_id) {
            let n = conn
                .execute(
                    "DELETE FROM waveform_cache WHERE track_id = ?1 AND server_id = ?2",
                    params![tid, server_id],
                )
                .map_err(|e| e.to_string())?;
            total = total.saturating_add(n as u64);
        }
        Ok(total)
    }

    /// Remove all cached waveform rows across all tracks/variants.
    pub fn delete_all_waveforms(&self) -> Result<u64, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let n = conn
            .execute("DELETE FROM waveform_cache", [])
            .map_err(|e| e.to_string())?;
        Ok(n as u64)
    }

    /// Remove all analysis cache entries for a specific server id.
    pub fn delete_all_for_server(
        &self,
        server_id: &str,
    ) -> Result<AnalysisDeleteServerReport, String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let waveforms = tx
            .execute(
                "DELETE FROM waveform_cache WHERE server_id = ?1",
                params![server_id],
            )
            .map_err(|e| e.to_string())?;
        let loudness = tx
            .execute(
                "DELETE FROM loudness_cache WHERE server_id = ?1",
                params![server_id],
            )
            .map_err(|e| e.to_string())?;
        let analysis_tracks = tx
            .execute(
                "DELETE FROM analysis_track WHERE server_id = ?1",
                params![server_id],
            )
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(AnalysisDeleteServerReport {
            analysis_tracks: analysis_tracks as u64,
            waveforms: waveforms as u64,
            loudness: loudness as u64,
        })
    }

    /// Drop analysis rows written under legacy server ids (profile UUIDs).
    pub fn migrate_server_keys(&self, mappings: &[(String, String)]) -> Result<(), String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (legacy, key) in mappings {
            let legacy = legacy.trim();
            let key = key.trim();
            if legacy.is_empty() || key.is_empty() || legacy == key {
                continue;
            }
            tx.execute(
                "DELETE FROM waveform_cache WHERE server_id = ?1",
                params![legacy],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM loudness_cache WHERE server_id = ?1",
                params![legacy],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM analysis_track WHERE server_id = ?1",
                params![legacy],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Delete every row for `(server_id, track_id)` whose fingerprint differs
    /// from `key.md5_16kb`. Called once a VERIFIED (trusted-original) analysis
    /// row is active, so `get_latest_*` reads can never surface a stale
    /// variant (e.g. a pre-fix transcode-derived row) for the track.
    pub fn delete_other_fingerprints(&self, key: &TrackKey) -> Result<usize, String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut removed = 0usize;
        for track_id in track_id_cache_variants(&key.track_id) {
            for table in ["waveform_cache", "loudness_cache", "analysis_track"] {
                removed += tx
                    .execute(
                        &format!(
                            "DELETE FROM {table} WHERE server_id = ?1 AND track_id = ?2 AND md5_16kb != ?3"
                        ),
                        rusqlite::params![key.server_id, track_id, key.md5_16kb],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(removed)
    }

    /// Delete one exact `(server, track, fingerprint)` variant. Used when a
    /// trusted revision finishes after a newer revision already superseded it.
    pub fn delete_fingerprint(&self, key: &TrackKey) -> Result<usize, String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut removed = 0usize;
        for track_id in track_id_cache_variants(&key.track_id) {
            for table in ["waveform_cache", "loudness_cache", "analysis_track"] {
                removed += tx
                    .execute(
                        &format!(
                            "DELETE FROM {table} WHERE server_id = ?1 AND track_id = ?2 AND md5_16kb = ?3"
                        ),
                        rusqlite::params![key.server_id, track_id, key.md5_16kb],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(removed)
    }

    pub fn touch_track_status(&self, key: &TrackKey, status: &str) -> Result<(), String> {
        let now = now_unix_ts();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        conn.execute(
            r#"
            INSERT INTO analysis_track (
                server_id, track_id, md5_16kb, status, waveform_algo_version, loudness_algo_version, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(server_id, track_id, md5_16kb) DO UPDATE SET
                status = excluded.status,
                waveform_algo_version = excluded.waveform_algo_version,
                loudness_algo_version = excluded.loudness_algo_version,
                updated_at = excluded.updated_at
            "#,
            params![
                key.server_id,
                key.track_id,
                key.md5_16kb,
                status,
                WAVEFORM_ALGO_VERSION,
                LOUDNESS_ALGO_VERSION,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn upsert_waveform(&self, key: &TrackKey, entry: &WaveformEntry) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        conn.execute(
            r#"
            INSERT INTO waveform_cache (
                server_id, track_id, md5_16kb, bins, bin_count, is_partial, known_until_sec, duration_sec, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(server_id, track_id, md5_16kb) DO UPDATE SET
                bins = excluded.bins,
                bin_count = excluded.bin_count,
                is_partial = excluded.is_partial,
                known_until_sec = excluded.known_until_sec,
                duration_sec = excluded.duration_sec,
                updated_at = excluded.updated_at
            "#,
            params![
                key.server_id,
                key.track_id,
                key.md5_16kb,
                entry.bins,
                entry.bin_count,
                if entry.is_partial { 1 } else { 0 },
                entry.known_until_sec,
                entry.duration_sec,
                entry.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn upsert_loudness(&self, key: &TrackKey, entry: &LoudnessEntry) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        conn.execute(
            r#"
            INSERT INTO loudness_cache (
                server_id, track_id, md5_16kb, integrated_lufs, true_peak, recommended_gain_db, target_lufs, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(server_id, track_id, md5_16kb, target_lufs) DO UPDATE SET
                integrated_lufs = excluded.integrated_lufs,
                true_peak = excluded.true_peak,
                recommended_gain_db = excluded.recommended_gain_db,
                updated_at = excluded.updated_at
            "#,
            params![
                key.server_id,
                key.track_id,
                key.md5_16kb,
                entry.integrated_lufs,
                entry.true_peak,
                entry.recommended_gain_db,
                entry.target_lufs,
                entry.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_failed_tracks(
        &self,
        server_id: &str,
        track_ids: &[String],
    ) -> Result<u64, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        if track_ids.is_empty() {
            let deleted = conn
                .execute(
                    "DELETE FROM analysis_track WHERE server_id = ?1 AND status = 'failed'",
                    params![server_id],
                )
                .map_err(|e| e.to_string())?;
            return Ok(deleted as u64);
        }
        let mut total = 0u64;
        for id in track_ids {
            let tid = id.trim();
            if tid.is_empty() {
                continue;
            }
            for variant in track_id_cache_variants(tid) {
                let deleted = conn
                    .execute(
                        "DELETE FROM analysis_track WHERE server_id = ?1 AND track_id = ?2 AND status = 'failed'",
                        params![server_id, variant],
                    )
                    .map_err(|e| e.to_string())?;
                total = total.saturating_add(deleted as u64);
            }
        }
        Ok(total)
    }
}
