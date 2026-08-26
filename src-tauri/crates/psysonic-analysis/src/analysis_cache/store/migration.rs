use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::AnalysisCache;

const MAX_BATCH_LIMIT: u32 = 5_000;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize, specta::Type,
)]
#[serde(rename_all = "kebab-case")]
pub enum AnalysisMigrationStep {
    AnalysisTrack,
    WaveformCache,
    LoudnessCache,
}

impl AnalysisMigrationStep {
    fn table(self) -> &'static str {
        match self {
            Self::AnalysisTrack => "analysis_track",
            Self::WaveformCache => "waveform_cache",
            Self::LoudnessCache => "loudness_cache",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisMigrationBatchDto {
    pub step: AnalysisMigrationStep,
    pub cursor_rowid: i64,
    pub upper_rowid: i64,
    pub processed: u32,
    pub rewritten: u32,
    pub collisions: u32,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisMigrationFinalizeDto {
    pub ownerless_analysis_tracks_removed: u64,
    pub ownerless_waveforms_removed: u64,
    pub ownerless_loudness_removed: u64,
}

#[derive(Debug, Default)]
struct BatchStats {
    processed: u32,
    rewritten: u32,
    collisions: u32,
    last_rowid: i64,
}

impl AnalysisCache {
    pub fn migration_upper_rowid(
        &self,
        server_id: &str,
        step: AnalysisMigrationStep,
    ) -> Result<i64, String> {
        validate_server_id(server_id)?;
        let sql = format!(
            "SELECT COALESCE(MAX(rowid), 0) FROM {} WHERE server_id = ?1",
            step.table()
        );
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        conn.query_row(&sql, params![server_id], |row| row.get(0))
            .map_err(|error| error.to_string())
    }

    pub fn migration_run_batch(
        &self,
        server_id: &str,
        step: AnalysisMigrationStep,
        cursor_rowid: i64,
        upper_rowid: i64,
        limit: u32,
    ) -> Result<AnalysisMigrationBatchDto, String> {
        validate_server_id(server_id)?;
        if cursor_rowid < 0 || upper_rowid < 0 || cursor_rowid > upper_rowid {
            return Err(format!(
                "invalid analysis migration rowid range {cursor_rowid}..={upper_rowid}"
            ));
        }
        if limit == 0 || limit > MAX_BATCH_LIMIT {
            return Err(format!(
                "analysis migration batch limit must be between 1 and {MAX_BATCH_LIMIT}"
            ));
        }

        let mut conn = self.lock_write_conn()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let stats = match step {
            AnalysisMigrationStep::AnalysisTrack => {
                migrate_analysis_track(&tx, server_id, cursor_rowid, upper_rowid, limit)
            }
            AnalysisMigrationStep::WaveformCache => {
                migrate_waveform(&tx, server_id, cursor_rowid, upper_rowid, limit)
            }
            AnalysisMigrationStep::LoudnessCache => {
                migrate_loudness(&tx, server_id, cursor_rowid, upper_rowid, limit)
            }
        }
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;

        let cursor_rowid = if stats.processed < limit {
            upper_rowid
        } else {
            stats.last_rowid
        };
        Ok(AnalysisMigrationBatchDto {
            step,
            cursor_rowid,
            upper_rowid,
            processed: stats.processed,
            rewritten: stats.rewritten,
            collisions: stats.collisions,
            done: cursor_rowid >= upper_rowid,
        })
    }

    pub fn migration_finalize(&self, server_id: &str) -> Result<AnalysisMigrationFinalizeDto, String> {
        validate_server_id(server_id)?;
        let mut conn = self.lock_write_conn()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let ownerless_waveforms_removed = tx
            .execute("DELETE FROM waveform_cache WHERE server_id = ''", [])
            .map_err(|error| error.to_string())? as u64;
        let ownerless_loudness_removed = tx
            .execute("DELETE FROM loudness_cache WHERE server_id = ''", [])
            .map_err(|error| error.to_string())? as u64;
        let ownerless_analysis_tracks_removed = tx
            .execute("DELETE FROM analysis_track WHERE server_id = ''", [])
            .map_err(|error| error.to_string())? as u64;
        verify_no_legacy_analysis_ids(&tx, server_id).map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(AnalysisMigrationFinalizeDto {
            ownerless_analysis_tracks_removed,
            ownerless_waveforms_removed,
            ownerless_loudness_removed,
        })
    }

    pub fn migration_verify(&self, server_id: &str) -> Result<(), String> {
        validate_server_id(server_id)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        verify_no_legacy_analysis_ids(&conn, server_id).map_err(|error| error.to_string())
    }
}

fn validate_server_id(server_id: &str) -> Result<(), String> {
    if server_id.trim().is_empty() {
        Err("analysis migration server id must not be empty".to_string())
    } else {
        Ok(())
    }
}

fn canonical_analysis_track_id(track_id: &str) -> String {
    if let Some(track_id) = track_id.strip_prefix("stream:") {
        return format!(
            "stream:{}",
            psysonic_core::navidrome_id_codec::canonical_id(track_id)
        );
    }
    if track_id.contains(':') {
        return track_id.to_string();
    }
    psysonic_core::navidrome_id_codec::canonical_id(track_id)
}

#[derive(Debug)]
struct AnalysisTrackRow {
    rowid: i64,
    track_id: String,
    md5_16kb: String,
    status: String,
    waveform_algo_version: i64,
    loudness_algo_version: i64,
    updated_at: i64,
}

fn migrate_analysis_track(
    tx: &Transaction<'_>,
    server_id: &str,
    cursor_rowid: i64,
    upper_rowid: i64,
    limit: u32,
) -> rusqlite::Result<BatchStats> {
    let rowids = select_rowids(tx, "analysis_track", server_id, cursor_rowid, upper_rowid, limit)?;
    let mut stats = BatchStats::default();
    for rowid in rowids {
        stats.processed += 1;
        stats.last_rowid = rowid;
        let Some(source) = load_analysis_track(tx, rowid)? else {
            continue;
        };
        let new_id = canonical_analysis_track_id(&source.track_id);
        if new_id == source.track_id {
            continue;
        }
        let destination = tx
            .query_row(
                "SELECT rowid, track_id, md5_16kb, status, waveform_algo_version, \
                        loudness_algo_version, updated_at \
                 FROM analysis_track WHERE server_id = ?1 AND track_id = ?2 AND md5_16kb = ?3",
                params![server_id, new_id, source.md5_16kb],
                analysis_track_from_row,
            )
            .optional()?;
        match destination {
            None => {
                tx.execute(
                    "UPDATE analysis_track SET track_id = ?1 WHERE rowid = ?2",
                    params![new_id, rowid],
                )?;
                stats.rewritten += 1;
            }
            Some(destination) => {
                let equivalent = destination.waveform_algo_version == source.waveform_algo_version
                    && destination.loudness_algo_version == source.loudness_algo_version;
                if equivalent && source.updated_at > destination.updated_at {
                    tx.execute(
                        "UPDATE analysis_track SET status = ?1, waveform_algo_version = ?2, \
                           loudness_algo_version = ?3, updated_at = ?4 WHERE rowid = ?5",
                        params![
                            source.status,
                            source.waveform_algo_version,
                            source.loudness_algo_version,
                            source.updated_at,
                            destination.rowid
                        ],
                    )?;
                }
                tx.execute("DELETE FROM analysis_track WHERE rowid = ?1", params![rowid])?;
                stats.collisions += 1;
            }
        }
    }
    Ok(stats)
}

fn load_analysis_track(
    tx: &Transaction<'_>,
    rowid: i64,
) -> rusqlite::Result<Option<AnalysisTrackRow>> {
    tx.query_row(
        "SELECT rowid, track_id, md5_16kb, status, waveform_algo_version, \
                loudness_algo_version, updated_at FROM analysis_track WHERE rowid = ?1",
        params![rowid],
        analysis_track_from_row,
    )
    .optional()
}

fn analysis_track_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnalysisTrackRow> {
    Ok(AnalysisTrackRow {
        rowid: row.get(0)?,
        track_id: row.get(1)?,
        md5_16kb: row.get(2)?,
        status: row.get(3)?,
        waveform_algo_version: row.get(4)?,
        loudness_algo_version: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

#[derive(Debug)]
struct WaveformRow {
    rowid: i64,
    track_id: String,
    md5_16kb: String,
    bins: Vec<u8>,
    bin_count: i64,
    is_partial: i64,
    known_until_sec: f64,
    duration_sec: f64,
    updated_at: i64,
}

fn migrate_waveform(
    tx: &Transaction<'_>,
    server_id: &str,
    cursor_rowid: i64,
    upper_rowid: i64,
    limit: u32,
) -> rusqlite::Result<BatchStats> {
    let rowids = select_rowids(tx, "waveform_cache", server_id, cursor_rowid, upper_rowid, limit)?;
    let mut stats = BatchStats::default();
    for rowid in rowids {
        stats.processed += 1;
        stats.last_rowid = rowid;
        let Some(source) = load_waveform(tx, rowid)? else {
            continue;
        };
        let new_id = canonical_analysis_track_id(&source.track_id);
        if new_id == source.track_id {
            continue;
        }
        let destination = tx
            .query_row(
                "SELECT rowid, track_id, md5_16kb, bins, bin_count, is_partial, \
                        known_until_sec, duration_sec, updated_at \
                 FROM waveform_cache WHERE server_id = ?1 AND track_id = ?2 AND md5_16kb = ?3",
                params![server_id, new_id, source.md5_16kb],
                waveform_from_row,
            )
            .optional()?;
        match destination {
            None => {
                tx.execute(
                    "UPDATE waveform_cache SET track_id = ?1 WHERE rowid = ?2",
                    params![new_id, rowid],
                )?;
                stats.rewritten += 1;
            }
            Some(destination) => {
                if waveform_preferred(&source, &destination) {
                    tx.execute(
                        "UPDATE waveform_cache SET bins = ?1, bin_count = ?2, is_partial = ?3, \
                           known_until_sec = ?4, duration_sec = ?5, updated_at = ?6 WHERE rowid = ?7",
                        params![
                            source.bins,
                            source.bin_count,
                            source.is_partial,
                            source.known_until_sec,
                            source.duration_sec,
                            source.updated_at,
                            destination.rowid
                        ],
                    )?;
                }
                tx.execute("DELETE FROM waveform_cache WHERE rowid = ?1", params![rowid])?;
                stats.collisions += 1;
            }
        }
    }
    Ok(stats)
}

fn load_waveform(tx: &Transaction<'_>, rowid: i64) -> rusqlite::Result<Option<WaveformRow>> {
    tx.query_row(
        "SELECT rowid, track_id, md5_16kb, bins, bin_count, is_partial, known_until_sec, \
                duration_sec, updated_at FROM waveform_cache WHERE rowid = ?1",
        params![rowid],
        waveform_from_row,
    )
    .optional()
}

fn waveform_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WaveformRow> {
    Ok(WaveformRow {
        rowid: row.get(0)?,
        track_id: row.get(1)?,
        md5_16kb: row.get(2)?,
        bins: row.get(3)?,
        bin_count: row.get(4)?,
        is_partial: row.get(5)?,
        known_until_sec: row.get(6)?,
        duration_sec: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn waveform_preferred(source: &WaveformRow, destination: &WaveformRow) -> bool {
    let source_valid = source.bin_count > 0
        && source.bins.len() == (source.bin_count as usize).saturating_mul(2);
    let destination_valid = destination.bin_count > 0
        && destination.bins.len() == (destination.bin_count as usize).saturating_mul(2);
    (source_valid && !destination_valid)
        || (source_valid == destination_valid && source.updated_at > destination.updated_at)
}

#[derive(Debug)]
struct LoudnessRow {
    rowid: i64,
    track_id: String,
    md5_16kb: String,
    integrated_lufs: f64,
    true_peak: f64,
    recommended_gain_db: f64,
    target_lufs: f64,
    updated_at: i64,
}

fn migrate_loudness(
    tx: &Transaction<'_>,
    server_id: &str,
    cursor_rowid: i64,
    upper_rowid: i64,
    limit: u32,
) -> rusqlite::Result<BatchStats> {
    let rowids = select_rowids(tx, "loudness_cache", server_id, cursor_rowid, upper_rowid, limit)?;
    let mut stats = BatchStats::default();
    for rowid in rowids {
        stats.processed += 1;
        stats.last_rowid = rowid;
        let Some(source) = load_loudness(tx, rowid)? else {
            continue;
        };
        let new_id = canonical_analysis_track_id(&source.track_id);
        if new_id == source.track_id {
            continue;
        }
        let destination = tx
            .query_row(
                "SELECT rowid, track_id, md5_16kb, integrated_lufs, true_peak, \
                        recommended_gain_db, target_lufs, updated_at \
                 FROM loudness_cache WHERE server_id = ?1 AND track_id = ?2 \
                   AND md5_16kb = ?3 AND target_lufs = ?4",
                params![server_id, new_id, source.md5_16kb, source.target_lufs],
                loudness_from_row,
            )
            .optional()?;
        match destination {
            None => {
                tx.execute(
                    "UPDATE loudness_cache SET track_id = ?1 WHERE rowid = ?2",
                    params![new_id, rowid],
                )?;
                stats.rewritten += 1;
            }
            Some(destination) => {
                if loudness_preferred(&source, &destination) {
                    tx.execute(
                        "UPDATE loudness_cache SET integrated_lufs = ?1, true_peak = ?2, \
                           recommended_gain_db = ?3, updated_at = ?4 WHERE rowid = ?5",
                        params![
                            source.integrated_lufs,
                            source.true_peak,
                            source.recommended_gain_db,
                            source.updated_at,
                            destination.rowid
                        ],
                    )?;
                }
                tx.execute("DELETE FROM loudness_cache WHERE rowid = ?1", params![rowid])?;
                stats.collisions += 1;
            }
        }
    }
    Ok(stats)
}

fn load_loudness(tx: &Transaction<'_>, rowid: i64) -> rusqlite::Result<Option<LoudnessRow>> {
    tx.query_row(
        "SELECT rowid, track_id, md5_16kb, integrated_lufs, true_peak, \
                recommended_gain_db, target_lufs, updated_at \
         FROM loudness_cache WHERE rowid = ?1",
        params![rowid],
        loudness_from_row,
    )
    .optional()
}

fn loudness_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LoudnessRow> {
    Ok(LoudnessRow {
        rowid: row.get(0)?,
        track_id: row.get(1)?,
        md5_16kb: row.get(2)?,
        integrated_lufs: row.get(3)?,
        true_peak: row.get(4)?,
        recommended_gain_db: row.get(5)?,
        target_lufs: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn loudness_preferred(source: &LoudnessRow, destination: &LoudnessRow) -> bool {
    let source_valid = source.integrated_lufs.is_finite()
        && source.true_peak.is_finite()
        && source.recommended_gain_db.is_finite()
        && source.target_lufs.is_finite();
    let destination_valid = destination.integrated_lufs.is_finite()
        && destination.true_peak.is_finite()
        && destination.recommended_gain_db.is_finite()
        && destination.target_lufs.is_finite();
    (source_valid && !destination_valid)
        || (source_valid == destination_valid && source.updated_at > destination.updated_at)
}

fn select_rowids(
    tx: &Transaction<'_>,
    table: &str,
    server_id: &str,
    cursor_rowid: i64,
    upper_rowid: i64,
    limit: u32,
) -> rusqlite::Result<Vec<i64>> {
    let sql = format!(
        "SELECT rowid FROM {table} WHERE server_id = ?1 AND rowid > ?2 AND rowid <= ?3 \
         ORDER BY rowid LIMIT ?4"
    );
    let mut statement = tx.prepare(&sql)?;
    let rows = statement
        .query_map(
            params![server_id, cursor_rowid, upper_rowid, i64::from(limit)],
            |row| row.get(0),
        )?
        .collect();
    rows
}

fn verify_no_legacy_analysis_ids(
    tx: &Connection,
    server_id: &str,
) -> rusqlite::Result<()> {
    for table in ["analysis_track", "waveform_cache", "loudness_cache"] {
        let sql = format!("SELECT track_id FROM {table} WHERE server_id = ?1");
        let mut statement = tx.prepare(&sql)?;
        let track_ids = statement
            .query_map(params![server_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if let Some(track_id) = track_ids
            .into_iter()
            .find(|track_id| canonical_analysis_track_id(track_id) != *track_id)
        {
            return Err(rusqlite::Error::UserFunctionError(Box::new(
                AnalysisMigrationResidue(format!(
                    "analysis migration residue in {table}: `{track_id}`"
                )),
            )));
        }
    }
    Ok(())
}

#[derive(Debug)]
struct AnalysisMigrationResidue(String);

impl std::fmt::Display for AnalysisMigrationResidue {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for AnalysisMigrationResidue {}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    const LEGACY: &str = "e3b7fc2ae9447bbec37a13bf916e3cf6";

    #[test]
    fn rewrites_bare_and_stream_ids_and_merges_newer_waveform() {
        let cache = AnalysisCache::open_in_memory();
        let canonical = psysonic_core::navidrome_id_codec::canonical_id(LEGACY);
        {
            let conn = cache.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO waveform_cache \
                   (server_id, track_id, md5_16kb, bins, bin_count, is_partial, \
                    known_until_sec, duration_sec, updated_at) \
                 VALUES ('s1', ?1, 'hash', X'01020304', 2, 0, 10, 10, 20), \
                        ('s1', ?2, 'hash', X'0102', 1, 1, 5, 10, 10), \
                        ('s1', ?3, 'stream-hash', X'0102', 1, 0, 5, 5, 10)",
                params![LEGACY, canonical, format!("stream:{LEGACY}")],
            )
            .unwrap();
        }
        let upper = cache
            .migration_upper_rowid("s1", AnalysisMigrationStep::WaveformCache)
            .unwrap();
        let result = cache
            .migration_run_batch("s1", AnalysisMigrationStep::WaveformCache, 0, upper, 20)
            .unwrap();
        assert!(result.done);
        assert_eq!(result.rewritten, 1);
        assert_eq!(result.collisions, 1);

        let rows: Vec<(String, Vec<u8>)> = {
            let conn = cache.conn.lock().unwrap();
            let mut statement = conn
                .prepare("SELECT track_id, bins FROM waveform_cache ORDER BY track_id")
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(rows.len(), 2);
        assert!(rows.contains(&(canonical.clone(), vec![1, 2, 3, 4])));
        assert!(rows.contains(&(format!("stream:{canonical}"), vec![1, 2])));
    }

    #[test]
    fn opaque_prefixed_ids_are_not_rewritten() {
        assert_eq!(canonical_analysis_track_id("radio:abc"), "radio:abc");
    }

    #[test]
    fn shared_generation_blocks_ordinary_analysis_writes() {
        let barrier = Arc::new(
            psysonic_core::migration_write_barrier::MigrationWriteBarrier::default(),
        );
        let cache = AnalysisCache::open_in_memory_with_migration_barrier(Arc::clone(&barrier));
        let key = super::super::TrackKey {
            server_id: "s1".to_string(),
            track_id: "track-1".to_string(),
            md5_16kb: "hash".to_string(),
        };
        barrier.activate(7).unwrap();
        assert!(cache.touch_track_status(&key, "pending").is_err());
        AnalysisCache::scope_migration_write_generation_sync(7, || {
            cache.touch_track_status(&key, "pending").unwrap();
        });
        barrier.deactivate(7).unwrap();
        cache.touch_track_status(&key, "ready").unwrap();
    }

    #[test]
    fn finalize_removes_ownerless_rows_and_rejects_server_residue() {
        let cache = AnalysisCache::open_in_memory();
        {
            let conn = cache.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO analysis_track \
                   (server_id, track_id, md5_16kb, status, waveform_algo_version, \
                    loudness_algo_version, updated_at) \
                 VALUES ('', 'legacy-ownerless', 'h1', 'ready', 1, 1, 1), \
                        ('s1', ?1, 'h2', 'ready', 1, 1, 1)",
                params![LEGACY],
            )
            .unwrap();
        }
        assert!(cache.migration_finalize("s1").is_err());

        let upper = cache
            .migration_upper_rowid("s1", AnalysisMigrationStep::AnalysisTrack)
            .unwrap();
        cache
            .migration_run_batch("s1", AnalysisMigrationStep::AnalysisTrack, 0, upper, 20)
            .unwrap();
        let report = cache.migration_finalize("s1").unwrap();
        assert_eq!(report.ownerless_analysis_tracks_removed, 1);
    }
}
