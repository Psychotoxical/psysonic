use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs, io};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::Manager;

pub(super) const WAVEFORM_ALGO_VERSION: i64 = 4;
pub(super) const LOUDNESS_ALGO_VERSION: i64 = 1;

/// Current head of the embedded migrations. Bump for each new
/// `migrations/NNN_*.sql`.
pub const ANALYSIS_DB_SCHEMA_VERSION: i64 = 2;

const MIGRATION_001_BASELINE: &str = include_str!("../../migrations/001_baseline.sql");
const MIGRATION_002_SERVER_ID: &str = include_str!("../../migrations/002_server_id.sql");

/// Embedded migrations, ascending by version. The runner sorts defensively and
/// applies each missing one in its own transaction (schema change + version
/// marker commit together — see [`run_migrations_with`]).
const MIGRATIONS: &[(i64, &str)] = &[
    (1, MIGRATION_001_BASELINE),
    (2, MIGRATION_002_SERVER_ID),
];

/// Bins in waveform BLOB: `2 * bin_count` bytes (peak u8, then mean-abs u8 per time bin).
fn waveform_cache_blob_len_ok(bins: &[u8], bin_count: i64) -> bool {
    if bin_count <= 0 {
        return false;
    }
    let n = bin_count as usize;
    bins.len() == n.saturating_mul(2)
}

#[derive(Debug, Clone)]
pub struct TrackKey {
    /// App server id this analysis belongs to (scheme-less host/path key).
    pub server_id: String,
    pub track_id: String,
    pub md5_16kb: String,
}

/// Waveform / loudness rows present for a specific content fingerprint
/// (`md5_16kb`), after track-id variant checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContentCacheCoverage {
    pub has_waveform: bool,
    pub has_loudness: bool,
}

impl ContentCacheCoverage {
    pub fn complete(self) -> bool {
        self.has_waveform && self.has_loudness
    }
}

#[derive(Debug, Clone)]
pub struct WaveformEntry {
    pub bins: Vec<u8>,
    pub bin_count: i64,
    pub is_partial: bool,
    pub known_until_sec: f64,
    pub duration_sec: f64,
    pub updated_at: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct LoudnessEntry {
    pub integrated_lufs: f64,
    pub true_peak: f64,
    pub recommended_gain_db: f64,
    pub target_lufs: f64,
    pub updated_at: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct LoudnessSnapshot {
    pub integrated_lufs: f64,
    pub true_peak: f64,
    pub recommended_gain_db: f64,
    pub target_lufs: f64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct AnalysisDeleteServerReport {
    pub analysis_tracks: u64,
    pub waveforms: u64,
    pub loudness: u64,
}

#[derive(Debug, Clone)]
pub struct FailedTrackEntry {
    pub track_id: String,
    pub md5_16kb: String,
    pub updated_at: i64,
}

pub struct AnalysisCache {
    conn: Mutex<Connection>,
}

/// Ranged HTTP seeding uses `stream:<subsonicId>` (see `playback_identity`); backfill
/// and IPC often use the bare `<subsonicId>`. Rows may exist under either key.
fn track_id_cache_variants(id: &str) -> Vec<String> {
    let mut out = vec![id.to_string()];
    if let Some(bare) = id.strip_prefix("stream:") {
        if !bare.is_empty() {
            out.push(bare.to_string());
        }
    } else {
        out.push(format!("stream:{id}"));
    }
    out
}

fn normalize_track_id(id: &str) -> String {
    id.strip_prefix("stream:").unwrap_or(id).to_string()
}

pub(super) fn now_unix_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl AnalysisCache {
    pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, String> {
        let db_path = analysis_db_path(app)?;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        backup_before_pending_migration(&db_path)?;
        let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        configure_connection(&conn).map_err(|e| e.to_string())?;
        run_migrations(&mut conn).map_err(|e| e.to_string())?;
        checkpoint_wal_conn(&conn, "open").map_err(|e| e.to_string())?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Builds an in-memory SQLite database with the production schema applied.
    /// Intended for tests in this crate and any downstream crate that needs an
    /// `AnalysisCache` without an `AppHandle`. WAL pragma is skipped — `:memory:`
    /// databases don't support journal-mode changes; the test surface doesn't
    /// need durability.
    ///
    /// Lives outside `#[cfg(test)]` so cross-crate test harnesses can call it
    /// without a `test-support` Cargo feature dance. Production code does not
    /// use it.
    pub fn open_in_memory() -> Self {
        let mut conn = Connection::open_in_memory().expect("in-memory connection");
        conn.pragma_update(None, "foreign_keys", "ON").expect("pragma foreign_keys");
        run_migrations(&mut conn).expect("schema migration");
        let _ = checkpoint_wal_conn(&conn, "open");
        Self { conn: Mutex::new(conn) }
    }

    /// Remove `loudness_cache` rows for this logical track (bare id and `stream:`
    /// variant) scoped to one server. A reseed on server A must not delete
    /// server B's analysis for the same bare `track_id`.
    pub fn delete_loudness_for_track_id(&self, server_id: &str, track_id: &str) -> Result<u64, String> {
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
    pub fn delete_waveform_for_track_id(&self, server_id: &str, track_id: &str) -> Result<u64, String> {
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
            .execute("DELETE FROM waveform_cache WHERE server_id = ?1", params![server_id])
            .map_err(|e| e.to_string())?;
        let loudness = tx
            .execute("DELETE FROM loudness_cache WHERE server_id = ?1", params![server_id])
            .map_err(|e| e.to_string())?;
        let analysis_tracks = tx
            .execute("DELETE FROM analysis_track WHERE server_id = ?1", params![server_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(AnalysisDeleteServerReport {
            analysis_tracks: analysis_tracks as u64,
            waveforms: waveforms as u64,
            loudness: loudness as u64,
        })
    }

    pub fn checkpoint_wal(&self, op: &'static str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        checkpoint_wal_conn(&conn, op).map_err(|e| e.to_string())
    }

    /// Atomically switch analysis sqlite file while replacing the held
    /// connection so runtime writers cannot continue on the old inode.
    pub fn swap_database_file(
        &self,
        active_path: &Path,
        destination_path: &Path,
    ) -> Result<Option<PathBuf>, String> {
        if !destination_path.exists() {
            return Ok(None);
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let old_conn = std::mem::replace(&mut *conn, tmp);
        drop(old_conn);

        let backup = active_path.with_file_name(format!(
            "{}.backup-pre-indexkey",
            active_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("audio-analysis.sqlite")
        ));
        remove_db_with_sidecars(&backup).ok();
        if active_path.exists() {
            fs::rename(active_path, &backup).map_err(|e| e.to_string())?;
            move_sidecar(active_path, &backup, "-wal")?;
            move_sidecar(active_path, &backup, "-shm")?;
        }
        if let Err(err) = fs::rename(destination_path, active_path) {
            if backup.exists() {
                let _ = fs::rename(&backup, active_path);
                let _ = move_sidecar(&backup, active_path, "-wal");
                let _ = move_sidecar(&backup, active_path, "-shm");
            }
            return Err(err.to_string());
        }
        let mut reopened = Connection::open(active_path).map_err(|e| e.to_string())?;
        configure_connection(&reopened).map_err(|e| e.to_string())?;
        run_migrations(&mut reopened).map_err(|e| e.to_string())?;
        *conn = reopened;
        Ok(Some(backup))
    }

    pub fn restore_database_backup(&self, backup_path: &Path, active_path: &Path) -> Result<(), String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let old_conn = std::mem::replace(&mut *conn, tmp);
        drop(old_conn);

        if active_path.exists() {
            remove_db_with_sidecars(active_path)?;
        }
        if backup_path.exists() {
            fs::rename(backup_path, active_path).map_err(|e| e.to_string())?;
            move_sidecar(backup_path, active_path, "-wal")?;
            move_sidecar(backup_path, active_path, "-shm")?;
        }
        let mut reopened = Connection::open(active_path).map_err(|e| e.to_string())?;
        configure_connection(&reopened).map_err(|e| e.to_string())?;
        run_migrations(&mut reopened).map_err(|e| e.to_string())?;
        *conn = reopened;
        Ok(())
    }

    /// Drop analysis rows written under legacy server ids (profile UUIDs).
    pub fn migrate_server_keys(
        &self,
        mappings: &[(String, String)],
    ) -> Result<(), String> {
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
            tx.execute("DELETE FROM waveform_cache WHERE server_id = ?1", params![legacy])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM loudness_cache WHERE server_id = ?1", params![legacy])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM analysis_track WHERE server_id = ?1", params![legacy])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn touch_track_status(&self, key: &TrackKey, status: &str) -> Result<(), String> {
        let now = now_unix_ts();
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
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
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
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
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
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

    pub fn get_waveform(&self, key: &TrackKey) -> Result<Option<WaveformEntry>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
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
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
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
                params![key.server_id, key.track_id, key.md5_16kb, LOUDNESS_ALGO_VERSION],
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
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        query_latest_waveform_scoped(&conn, server_id, track_id)
    }

    /// Latest `md5_16kb` fingerprint for `(server_id, track_id)`.
    pub fn get_latest_md5_16kb_for_track(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
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
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        query_latest_status_scoped(&conn, server_id, track_id)
    }

    pub fn count_failed_tracks(&self, server_id: &str) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        query_failed_tracks_count_scoped(&conn, server_id)
    }

    pub fn list_failed_tracks(
        &self,
        server_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<FailedTrackEntry>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        query_failed_tracks_scoped(&conn, server_id, limit)
    }

    pub fn clear_failed_tracks(
        &self,
        server_id: &str,
        track_ids: &[String],
    ) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
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

    /// Both waveform and loudness rows exist for this `(server_id, track_id)` —
    /// a CPU seed from bytes/file would only decode the file to immediately skip
    /// with `SkippedWaveformCacheHit`.
    pub fn cpu_seed_redundant_for_track(&self, server_id: &str, track_id: &str) -> Result<bool, String> {
        Ok(
            self.get_latest_waveform_for_track(server_id, track_id)?.is_some()
                && self.get_latest_loudness_for_track(server_id, track_id)?.is_some(),
        )
    }

    /// Latest loudness for `(server_id, track_id)`.
    pub fn get_latest_loudness_for_track(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<Option<LoudnessSnapshot>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
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
            let take = latest
                .as_ref()
                .is_none_or(|(_, ts)| candidate.1 > *ts);
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
    let mut seen = std::collections::HashSet::<String>::new();
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

fn analysis_db_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let db_dir = base.join("databases").join("analysis");
    let db_path = db_dir.join("audio-analysis.sqlite");
    let legacy_data = base.join("audio-analysis.sqlite");
    let legacy_config = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("audio-analysis.sqlite");
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if db_path.exists() {
        cleanup_legacy_db_if_present(&legacy_data, &db_path)?;
        cleanup_legacy_db_if_present(&legacy_config, &db_path)?;
        return Ok(db_path);
    }

    if legacy_data.exists() {
        migrate_db_file(&legacy_data, &db_path).map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy_data, &db_path, "-wal").map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy_data, &db_path, "-shm").map_err(|e| e.to_string())?;
    } else if legacy_config.exists() {
        migrate_db_file(&legacy_config, &db_path).map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy_config, &db_path, "-wal").map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy_config, &db_path, "-shm").map_err(|e| e.to_string())?;
    }
    cleanup_legacy_db_if_present(&legacy_data, &db_path)?;
    cleanup_legacy_db_if_present(&legacy_config, &db_path)?;

    Ok(db_path)
}

fn cleanup_legacy_db_if_present(legacy_path: &Path, active_path: &Path) -> Result<(), String> {
    if legacy_path == active_path {
        return Ok(());
    }
    remove_db_with_sidecars(legacy_path)
}

fn checkpoint_wal_conn(conn: &Connection, op: &str) -> rusqlite::Result<()> {
    let (busy, log, checkpointed): (i32, i32, i32) =
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    if busy != 0 {
        crate::app_eprintln!(
            "[analysis-db] wal checkpoint busy op={op} busy={busy} log={log} checkpointed={checkpointed}"
        );
    }
    Ok(())
}

fn migrate_db_file(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(from, to)?;
            fs::remove_file(from)?;
            Ok(())
        }
    }
}

fn migrate_db_sidecar(from: &Path, to: &Path, suffix: &str) -> io::Result<()> {
    let from_path = PathBuf::from(format!("{}{}", from.display(), suffix));
    if !from_path.exists() {
        return Ok(());
    }
    let to_path = PathBuf::from(format!("{}{}", to.display(), suffix));
    if let Some(parent) = to_path.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(&from_path, &to_path) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(&from_path, &to_path)?;
            fs::remove_file(&from_path)?;
            Ok(())
        }
    }
}

fn move_sidecar(from_base: &Path, to_base: &Path, suffix: &str) -> Result<(), String> {
    let from = PathBuf::from(format!("{}{}", from_base.display(), suffix));
    if !from.exists() {
        return Ok(());
    }
    let to = PathBuf::from(format!("{}{}", to_base.display(), suffix));
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

fn remove_db_with_sidecars(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
        if sidecar.exists() {
            fs::remove_file(sidecar).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn configure_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

/// One-shot safety net before the first table-rewriting migration (002
/// `server_id`). Snapshots the existing DB via `VACUUM INTO` — a transactionally
/// consistent copy even with WAL — to `<db>.pre-v<N>.bak`, so a catastrophic
/// failure the migration transaction can't cover (disk full at COMMIT,
/// filesystem corruption, a rebuild bug) still leaves the original recoverable.
/// Skipped for a fresh DB or one already at the target version. The analysis
/// cache is small (~1 KB/track), so the copy is cheap.
fn backup_before_pending_migration(db_path: &Path) -> Result<(), String> {
    if !db_path.exists() {
        return Ok(()); // fresh DB — nothing to protect
    }
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    // `schema_migrations` may not exist yet on a pre-versioning DB → treat the
    // missing table as version 0 so the backup runs before 002 rewrites tables.
    let applied: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if applied >= ANALYSIS_DB_SCHEMA_VERSION {
        return Ok(()); // already at head — no rewrite pending
    }
    let backup_path = db_path.with_file_name(format!(
        "audio-analysis.sqlite.pre-v{ANALYSIS_DB_SCHEMA_VERSION}.bak"
    ));
    // `VACUUM INTO` fails if the target exists; drop a stale backup from an
    // interrupted earlier attempt (the snapshot is re-creatable).
    if backup_path.exists() {
        std::fs::remove_file(&backup_path).map_err(|e| e.to_string())?;
    }
    // Documented literal form `VACUUM INTO '<file>'`; the local path is escaped
    // for the SQL string literal (single-quote doubling) so an apostrophe in a
    // user's home dir can't break or inject the statement.
    let escaped = backup_path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}';"))
        .map_err(|e| format!("analysis pre-migration backup failed: {e}"))?;
    Ok(())
}

fn run_migrations(conn: &mut Connection) -> rusqlite::Result<()> {
    run_migrations_with(conn, MIGRATIONS)
}

/// Applies every embedded migration not yet recorded in `schema_migrations`.
/// Each migration runs in its own transaction that commits the schema change
/// *and* its version marker together — a failure or crash rolls the whole
/// migration back, and the next start retries it cleanly. Idempotent across
/// reopens. Forward-only: an unknown future version on the DB is left alone
/// (the analysis cache is a rebuildable derived store, so there is no
/// breaking-bump drop/resync like the library DB).
///
/// Split out (test-friendly) so the migration set can be exercised against an
/// in-memory connection.
pub(crate) fn run_migrations_with(
    conn: &mut Connection,
    migrations: &[(i64, &str)],
) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version    INTEGER PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );",
    )?;

    let mut ordered: Vec<(i64, &str)> = migrations.to_vec();
    ordered.sort_by_key(|(v, _)| *v);
    for (version, sql) in ordered {
        let already: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
            params![version],
            |row| row.get(0),
        )?;
        if already > 0 {
            continue;
        }
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
            params![version],
        )?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn key(track_id: &str) -> TrackKey {
        TrackKey {
            server_id: "server-a".to_string(),
            track_id: track_id.to_string(),
            md5_16kb: "deadbeef".to_string(),
        }
    }

    fn key_on(server_id: &str, track_id: &str) -> TrackKey {
        TrackKey {
            server_id: server_id.to_string(),
            track_id: track_id.to_string(),
            md5_16kb: "deadbeef".to_string(),
        }
    }

    fn waveform(bin_count: i64, is_partial: bool) -> WaveformEntry {
        WaveformEntry {
            bins: vec![0u8; (bin_count as usize) * 2],
            bin_count,
            is_partial,
            known_until_sec: 12.5,
            duration_sec: 60.0,
            updated_at: 1_700_000_000,
        }
    }

    fn loudness(target_lufs: f64) -> LoudnessEntry {
        LoudnessEntry {
            integrated_lufs: -14.2,
            true_peak: -1.0,
            recommended_gain_db: -0.8,
            target_lufs,
            updated_at: 1_700_000_000,
        }
    }

    // ── track_id_cache_variants (private helper) ──────────────────────────────

    #[test]
    fn variants_for_bare_id_includes_stream_prefix() {
        let v = track_id_cache_variants("abc");
        assert_eq!(v, vec!["abc".to_string(), "stream:abc".to_string()]);
    }

    #[test]
    fn variants_for_stream_prefixed_id_includes_bare() {
        let v = track_id_cache_variants("stream:abc");
        assert_eq!(v, vec!["stream:abc".to_string(), "abc".to_string()]);
    }

    #[test]
    fn variants_for_empty_bare_after_stream_drops_extra_entry() {
        let v = track_id_cache_variants("stream:");
        assert_eq!(v, vec!["stream:".to_string()]);
    }

    // ── waveform_cache_blob_len_ok (private helper) ───────────────────────────

    #[test]
    fn blob_len_ok_rejects_non_positive_bin_count() {
        assert!(!waveform_cache_blob_len_ok(&[], 0));
        assert!(!waveform_cache_blob_len_ok(&[], -1));
    }

    #[test]
    fn blob_len_ok_requires_exactly_two_bytes_per_bin() {
        assert!(waveform_cache_blob_len_ok(&[0u8; 8], 4));
        assert!(!waveform_cache_blob_len_ok(&[0u8; 7], 4));
        assert!(!waveform_cache_blob_len_ok(&[0u8; 9], 4));
    }

    // ── schema initialisation ─────────────────────────────────────────────────

    #[test]
    fn open_in_memory_creates_all_tables() {
        let cache = AnalysisCache::open_in_memory();
        let conn = cache.conn.lock().unwrap();
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(
            tables,
            vec![
                "analysis_track",
                "loudness_cache",
                "schema_migrations",
                "waveform_cache"
            ]
        );
    }

    // ── waveform roundtrip ────────────────────────────────────────────────────

    #[test]
    fn get_waveform_returns_none_without_analysis_track_row() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
        // The JOIN against `analysis_track` requires a matching row; without
        // `touch_track_status` first, the lookup must miss.
        assert!(cache.get_waveform(&k).unwrap().is_none());
    }

    #[test]
    fn waveform_roundtrip_preserves_all_fields() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();
        let entry = WaveformEntry {
            bins: (0u8..16).collect(),
            bin_count: 8,
            is_partial: true,
            known_until_sec: 4.5,
            duration_sec: 33.0,
            updated_at: 1_700_000_001,
        };
        cache.upsert_waveform(&k, &entry).unwrap();
        let got = cache.get_waveform(&k).unwrap().expect("waveform present");
        assert_eq!(got.bins, entry.bins);
        assert_eq!(got.bin_count, 8);
        assert!(got.is_partial);
        assert_eq!(got.known_until_sec, 4.5);
        assert_eq!(got.duration_sec, 33.0);
        assert_eq!(got.updated_at, 1_700_000_001);
    }

    #[test]
    fn waveform_upsert_overwrites_existing_row() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();
        cache.upsert_waveform(&k, &waveform(4, true)).unwrap();
        let updated = WaveformEntry {
            bins: vec![0xAAu8; 8],
            bin_count: 4,
            is_partial: false,
            known_until_sec: 60.0,
            duration_sec: 60.0,
            updated_at: 1_700_000_999,
        };
        cache.upsert_waveform(&k, &updated).unwrap();
        let got = cache.get_waveform(&k).unwrap().expect("waveform present");
        assert!(!got.is_partial, "second upsert should overwrite is_partial");
        assert_eq!(got.bins, vec![0xAAu8; 8]);
        assert_eq!(got.updated_at, 1_700_000_999);
    }

    #[test]
    fn waveform_with_inconsistent_blob_length_is_filtered_out() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();
        // Manually upsert an entry where bins.len() doesn't match 2 * bin_count.
        let bad = WaveformEntry {
            bins: vec![0u8; 5], // expected 2*4 = 8
            bin_count: 4,
            is_partial: false,
            known_until_sec: 0.0,
            duration_sec: 0.0,
            updated_at: 1_700_000_000,
        };
        cache.upsert_waveform(&k, &bad).unwrap();
        // Direct JOIN finds the row, but get_waveform filters by length.
        assert!(cache.get_waveform(&k).unwrap().is_none());
    }

    // ── loudness roundtrip ────────────────────────────────────────────────────

    #[test]
    fn loudness_roundtrip_records_existence() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();
        assert!(!cache.loudness_row_exists_for_key(&k).unwrap());
        cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
        assert!(cache.loudness_row_exists_for_key(&k).unwrap());
    }

    #[test]
    fn loudness_primary_key_includes_target_lufs() {
        // Two rows with same (track_id, md5_16kb) but different target_lufs must coexist.
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();
        cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
        cache.upsert_loudness(&k, &loudness(-10.0)).unwrap();
        let conn = cache.conn.lock().unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM loudness_cache WHERE track_id = ?1",
                params!["abc"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    // ── id-variant lookups ────────────────────────────────────────────────────

    #[test]
    fn get_latest_waveform_finds_row_under_other_variant() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("stream:abc");
        cache.touch_track_status(&k, "ok").unwrap();
        cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
        // Insert under stream:abc, look up with bare abc.
        let got = cache.get_latest_waveform_for_track("server-a", "abc").unwrap();
        assert!(got.is_some(), "bare-id lookup must find stream-prefixed row");
    }

    #[test]
    fn get_latest_loudness_finds_row_under_other_variant() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();
        cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
        let got = cache
            .get_latest_loudness_for_track("server-a", "stream:abc")
            .unwrap();
        assert!(got.is_some(), "stream-prefixed lookup must find bare row");
    }

    // ── cpu_seed_redundant_for_track ──────────────────────────────────────────

    #[test]
    fn cpu_seed_redundant_requires_both_waveform_and_loudness() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();

        assert!(!cache.cpu_seed_redundant_for_track("server-a", "abc").unwrap());

        cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
        assert!(
            !cache
                .cpu_seed_redundant_for_track("server-a", "abc")
                .unwrap(),
            "waveform alone is not enough"
        );

        cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
        assert!(cache
            .cpu_seed_redundant_for_track("server-a", "abc")
            .unwrap());
    }

    // ── deletes ───────────────────────────────────────────────────────────────

    #[test]
    fn delete_loudness_clears_both_id_variants() {
        let cache = AnalysisCache::open_in_memory();
        let bare = key("abc");
        let prefixed = key("stream:abc");
        cache.touch_track_status(&bare, "ok").unwrap();
        cache.touch_track_status(&prefixed, "ok").unwrap();
        cache.upsert_loudness(&bare, &loudness(-14.0)).unwrap();
        cache.upsert_loudness(&prefixed, &loudness(-14.0)).unwrap();

        let deleted = cache
            .delete_loudness_for_track_id("server-a", "abc")
            .unwrap();
        assert_eq!(deleted, 2, "delete must remove both bare and stream:abc rows");
        assert!(!cache.loudness_row_exists_for_key(&bare).unwrap());
        assert!(!cache.loudness_row_exists_for_key(&prefixed).unwrap());
    }

    #[test]
    fn delete_waveform_clears_both_id_variants() {
        let cache = AnalysisCache::open_in_memory();
        let bare = key("abc");
        let prefixed = key("stream:abc");
        cache.touch_track_status(&bare, "ok").unwrap();
        cache.touch_track_status(&prefixed, "ok").unwrap();
        cache.upsert_waveform(&bare, &waveform(4, false)).unwrap();
        cache.upsert_waveform(&prefixed, &waveform(4, false)).unwrap();

        let deleted = cache.delete_waveform_for_track_id("server-a", "abc").unwrap();
        assert_eq!(deleted, 2);
        assert!(cache.get_waveform(&bare).unwrap().is_none());
        assert!(cache.get_waveform(&prefixed).unwrap().is_none());
    }

    #[test]
    fn delete_with_empty_or_whitespace_track_id_is_noop() {
        let cache = AnalysisCache::open_in_memory();
        assert_eq!(cache.delete_waveform_for_track_id("", "").unwrap(), 0);
        assert_eq!(cache.delete_waveform_for_track_id("", "   ").unwrap(), 0);
        assert_eq!(cache.delete_loudness_for_track_id("", "").unwrap(), 0);
        assert_eq!(cache.delete_loudness_for_track_id("", "   ").unwrap(), 0);
    }

    #[test]
    fn delete_scoped_to_server_keeps_other_servers_rows() {
        // A reseed on server-a must not wipe server-b's analysis for the same
        // bare track_id.
        let cache = AnalysisCache::open_in_memory();
        let on_a = key_on("server-a", "t");
        let on_b = key_on("server-b", "t");
        for k in [&on_a, &on_b] {
            cache.touch_track_status(k, "ok").unwrap();
            cache.upsert_waveform(k, &waveform(4, false)).unwrap();
            cache.upsert_loudness(k, &loudness(-14.0)).unwrap();
        }

        let deleted = cache.delete_waveform_for_track_id("server-a", "t").unwrap();
        assert_eq!(deleted, 1, "server-a waveform rows removed");
        assert!(cache.get_waveform(&on_a).unwrap().is_none());
        assert!(
            cache.get_waveform(&on_b).unwrap().is_some(),
            "another server's waveform must survive a scoped reseed"
        );

        let deleted_l = cache.delete_loudness_for_track_id("server-a", "t").unwrap();
        assert_eq!(deleted_l, 1);
        assert!(cache.loudness_row_exists_for_key(&on_b).unwrap());
    }

    #[test]
    fn delete_all_waveforms_removes_every_row() {
        let cache = AnalysisCache::open_in_memory();
        for tid in ["a", "b", "c"] {
            let k = key(tid);
            cache.touch_track_status(&k, "ok").unwrap();
            cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
        }
        let deleted = cache.delete_all_waveforms().unwrap();
        assert_eq!(deleted, 3);
        for tid in ["a", "b", "c"] {
            assert!(cache.get_waveform(&key(tid)).unwrap().is_none());
        }
    }

    #[test]
    fn touch_track_status_upserts_status_field() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "queued").unwrap();
        cache.touch_track_status(&k, "done").unwrap();
        let conn = cache.conn.lock().unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM analysis_track WHERE track_id = ?1 AND md5_16kb = ?2",
                params!["abc", "deadbeef"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(status, "done");
    }

    // ── schema migrations (002 server_id) ─────────────────────────────────────

    #[test]
    fn run_migrations_records_all_versions_and_is_idempotent() {
        let mut conn = Connection::open_in_memory().unwrap();
        run_migrations_with(&mut conn, MIGRATIONS).unwrap();
        // Second run is a no-op (every version already recorded).
        run_migrations_with(&mut conn, MIGRATIONS).unwrap();
        let versions: Vec<i64> = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(versions, (1..=ANALYSIS_DB_SCHEMA_VERSION).collect::<Vec<_>>());
    }

    #[test]
    fn server_id_scopes_exact_key_lookups() {
        let cache = AnalysisCache::open_in_memory();
        let on_a = key_on("server-a", "t");
        let on_b = key_on("server-b", "t");
        cache.touch_track_status(&on_a, "ready").unwrap();
        cache.touch_track_status(&on_b, "ready").unwrap();
        // Only server-a has a waveform.
        cache.upsert_waveform(&on_a, &waveform(4, false)).unwrap();

        assert!(cache.get_waveform(&on_a).unwrap().is_some());
        assert!(
            cache.get_waveform(&on_b).unwrap().is_none(),
            "exact lookup must not return another server's analysis"
        );

        // Same (track_id, md5_16kb) under two server ids are independent rows.
        let conn = cache.conn.lock().unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM analysis_track WHERE track_id='t'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2);
    }

    // ── pre-migration backup (on-disk; VACUUM INTO snapshot) ──────────────────

    fn unique_temp_dir(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static CTR: AtomicU64 = AtomicU64::new(0);
        let n = CTR.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("psysonic-analysis-{tag}-{nanos}-{n}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn backup_file(dir: &Path) -> PathBuf {
        dir.join(format!("audio-analysis.sqlite.pre-v{ANALYSIS_DB_SCHEMA_VERSION}.bak"))
    }

    fn sqlite_sidecar(path: &Path, suffix: &str) -> PathBuf {
        PathBuf::from(format!("{}{}", path.display(), suffix))
    }

    fn open_file_cache(db_path: &Path) -> AnalysisCache {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut conn = Connection::open(db_path).unwrap();
        configure_connection(&conn).unwrap();
        run_migrations(&mut conn).unwrap();
        AnalysisCache {
            conn: Mutex::new(conn),
        }
    }

    fn unique_temp_file(tag: &str) -> PathBuf {
        static CTR: AtomicU64 = AtomicU64::new(0);
        let n = CTR.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("psysonic-analysis-{tag}-{nanos}-{n}.sqlite"))
    }

    #[test]
    fn backup_snapshots_pre_v2_db_and_overwrites_stale() {
        let dir = unique_temp_dir("bkp-create");
        let db_path = dir.join("audio-analysis.sqlite");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(MIGRATION_001_BASELINE).unwrap();
            conn.execute(
                "INSERT INTO analysis_track (track_id, md5_16kb, status, waveform_algo_version, loudness_algo_version, updated_at)
                 VALUES ('t','m','ready',?1,?2,1)",
                params![WAVEFORM_ALGO_VERSION, LOUDNESS_ALGO_VERSION],
            )
            .unwrap();
        }

        backup_before_pending_migration(&db_path).unwrap();

        let backup = backup_file(&dir);
        assert!(backup.exists(), "backup snapshot must be written");
        // The snapshot is a valid DB carrying the original row.
        let bconn = Connection::open(&backup).unwrap();
        let rows: i64 = bconn
            .query_row("SELECT COUNT(*) FROM analysis_track", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
        drop(bconn);

        // A second call overwrites the stale snapshot (VACUUM INTO needs a free
        // target) instead of failing.
        backup_before_pending_migration(&db_path).unwrap();
        assert!(backup.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_skips_when_db_absent() {
        let dir = unique_temp_dir("bkp-absent");
        let db_path = dir.join("audio-analysis.sqlite");
        backup_before_pending_migration(&db_path).unwrap();
        assert!(!backup_file(&dir).exists(), "no backup for a fresh (absent) DB");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_skips_when_already_at_head() {
        let dir = unique_temp_dir("bkp-head");
        let db_path = dir.join("audio-analysis.sqlite");
        {
            let mut conn = Connection::open(&db_path).unwrap();
            run_migrations_with(&mut conn, MIGRATIONS).unwrap();
        }
        backup_before_pending_migration(&db_path).unwrap();
        assert!(
            !backup_file(&dir).exists(),
            "no backup when the DB is already at the target version"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_cache_coverage_tracks_partial_and_complete_state() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "queued").unwrap();

        let none = cache.content_cache_coverage("server-a", "abc", "deadbeef").unwrap();
        assert!(!none.has_waveform);
        assert!(!none.has_loudness);
        assert!(!none.complete());

        cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
        let only_waveform = cache
            .content_cache_coverage("server-a", "stream:abc", "deadbeef")
            .unwrap();
        assert!(only_waveform.has_waveform);
        assert!(!only_waveform.has_loudness);
        assert!(!only_waveform.complete());

        cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
        let full = cache.content_cache_coverage("server-a", "abc", "deadbeef").unwrap();
        assert!(full.complete());
    }

    #[test]
    fn get_latest_md5_uses_variant_and_filters_empty_values() {
        let cache = AnalysisCache::open_in_memory();
        let ok = key("stream:t1");
        cache.touch_track_status(&ok, "ready").unwrap();
        cache.upsert_waveform(&ok, &waveform(4, false)).unwrap();

        assert_eq!(
            cache
                .get_latest_md5_16kb_for_track("server-a", "t1")
                .unwrap()
                .as_deref(),
            Some("deadbeef")
        );

        let empty_md5 = TrackKey {
            server_id: "server-a".to_string(),
            track_id: "t2".to_string(),
            md5_16kb: "".to_string(),
        };
        cache.touch_track_status(&empty_md5, "ready").unwrap();
        cache.upsert_waveform(&empty_md5, &waveform(4, false)).unwrap();
        assert!(
            cache
                .get_latest_md5_16kb_for_track("server-a", "t2")
                .unwrap()
                .is_none(),
            "empty md5 rows must be ignored by latest-md5 lookup"
        );
    }

    #[test]
    fn delete_all_for_server_removes_only_targeted_server_rows() {
        let cache = AnalysisCache::open_in_memory();
        let a = key_on("server-a", "t");
        let b = key_on("server-b", "t");
        for k in [&a, &b] {
            cache.touch_track_status(k, "ready").unwrap();
            cache.upsert_waveform(k, &waveform(4, false)).unwrap();
            cache.upsert_loudness(k, &loudness(-14.0)).unwrap();
        }

        let report = cache.delete_all_for_server("server-a").unwrap();
        assert_eq!(report.analysis_tracks, 1);
        assert_eq!(report.waveforms, 1);
        assert_eq!(report.loudness, 1);
        assert!(cache.get_waveform(&a).unwrap().is_none());
        assert!(cache.get_waveform(&b).unwrap().is_some());
        assert!(cache.loudness_row_exists_for_key(&b).unwrap());
    }

    #[test]
    fn migrate_server_keys_drops_only_legacy_rows() {
        let cache = AnalysisCache::open_in_memory();
        let legacy = key_on("legacy-uuid", "t");
        let modern = key_on("modern-index-key", "t");
        for k in [&legacy, &modern] {
            cache.touch_track_status(k, "ready").unwrap();
            cache.upsert_waveform(k, &waveform(4, false)).unwrap();
            cache.upsert_loudness(k, &loudness(-14.0)).unwrap();
        }

        cache
            .migrate_server_keys(&[
                ("legacy-uuid".to_string(), "modern-index-key".to_string()),
                ("".to_string(), "skip".to_string()),
                ("same".to_string(), "same".to_string()),
            ])
            .unwrap();

        assert!(cache.get_waveform(&legacy).unwrap().is_none());
        assert!(cache.get_waveform(&modern).unwrap().is_some());
    }

    #[test]
    fn swap_database_file_and_restore_backup_roundtrip() {
        let active_path = unique_temp_file("swap-active");
        let destination_path = unique_temp_file("swap-dst");
        let backup_path = active_path.with_file_name(format!(
            "{}.backup-pre-indexkey",
            active_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("audio-analysis.sqlite")
        ));

        let cache = open_file_cache(&active_path);
        let old_key = key_on("server-a", "old");
        cache.touch_track_status(&old_key, "ready").unwrap();
        cache.upsert_waveform(&old_key, &waveform(4, false)).unwrap();

        {
            let dst = open_file_cache(&destination_path);
            let new_key = key_on("server-a", "new");
            dst.touch_track_status(&new_key, "ready").unwrap();
            dst.upsert_waveform(&new_key, &waveform(4, false)).unwrap();
            dst.checkpoint_wal("dst").unwrap();
        }

        let backup = cache
            .swap_database_file(&active_path, &destination_path)
            .unwrap()
            .expect("backup path must be returned");
        assert_eq!(backup, backup_path);
        assert!(
            cache
                .get_waveform(&key_on("server-a", "new"))
                .unwrap()
                .is_some(),
            "cache must reopen on swapped destination DB"
        );
        assert!(!destination_path.exists(), "destination DB must be moved into active path");
        assert!(backup_path.exists(), "previous active DB must be moved to backup path");

        cache
            .restore_database_backup(&backup_path, &active_path)
            .unwrap();
        assert!(
            cache
                .get_waveform(&key_on("server-a", "old"))
                .unwrap()
                .is_some(),
            "restore must bring old DB back"
        );
        assert!(
            cache
                .get_waveform(&key_on("server-a", "new"))
                .unwrap()
                .is_none(),
            "restored DB must not contain swapped-in rows"
        );

        let _ = remove_db_with_sidecars(&active_path);
        let _ = remove_db_with_sidecars(&backup_path);
    }

    #[test]
    fn swap_database_file_returns_none_when_destination_missing() {
        let active_path = unique_temp_file("swap-none-active");
        let missing_destination = unique_temp_file("swap-none-dst");
        let cache = open_file_cache(&active_path);
        let backup = cache
            .swap_database_file(&active_path, &missing_destination)
            .unwrap();
        assert!(backup.is_none());
        let _ = remove_db_with_sidecars(&active_path);
    }

    #[test]
    fn migrate_db_helpers_move_and_cleanup_sidecars() {
        let from = unique_temp_file("migrate-from");
        let to = unique_temp_file("migrate-to");
        std::fs::write(&from, b"sqlite-bytes").unwrap();
        std::fs::write(sqlite_sidecar(&from, "-wal"), b"wal").unwrap();
        std::fs::write(sqlite_sidecar(&from, "-shm"), b"shm").unwrap();

        migrate_db_file(&from, &to).unwrap();
        assert!(to.exists());
        assert!(!from.exists());

        migrate_db_sidecar(&from, &to, "-wal").unwrap();
        migrate_db_sidecar(&from, &to, "-shm").unwrap();
        assert!(sqlite_sidecar(&to, "-wal").exists());
        assert!(sqlite_sidecar(&to, "-shm").exists());

        let moved_to = unique_temp_file("migrate-moved");
        std::fs::write(&moved_to, b"sqlite-bytes-2").unwrap();
        std::fs::write(sqlite_sidecar(&moved_to, "-wal"), b"wal2").unwrap();
        move_sidecar(&moved_to, &to, "-wal").unwrap();
        assert!(!sqlite_sidecar(&moved_to, "-wal").exists());
        assert!(sqlite_sidecar(&to, "-wal").exists());

        cleanup_legacy_db_if_present(&to, &to).unwrap();
        cleanup_legacy_db_if_present(&to, &moved_to).unwrap();
        assert!(!to.exists());
        assert!(!sqlite_sidecar(&to, "-wal").exists());
        assert!(!sqlite_sidecar(&to, "-shm").exists());
    }

    #[test]
    fn run_migrations_with_applies_unsorted_versions_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        let migrations = [
            (
                3,
                "CREATE TABLE IF NOT EXISTS m3 (id INTEGER PRIMARY KEY);",
            ),
            (
                1,
                "CREATE TABLE IF NOT EXISTS m1 (id INTEGER PRIMARY KEY);",
            ),
            (
                2,
                "CREATE TABLE IF NOT EXISTS m2 (id INTEGER PRIMARY KEY);",
            ),
        ];
        run_migrations_with(&mut conn, &migrations).unwrap();
        run_migrations_with(&mut conn, &migrations).unwrap();

        let versions: Vec<i64> = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(versions, vec![1, 2, 3]);
    }

    #[test]
    fn checkpoint_wal_smoke_test() {
        let cache = AnalysisCache::open_in_memory();
        cache.checkpoint_wal("test").unwrap();
    }

    #[test]
    fn sidecar_helpers_are_noop_when_source_is_missing() {
        let from = unique_temp_file("sidecar-missing-from");
        let to = unique_temp_file("sidecar-missing-to");
        std::fs::write(&to, b"db").unwrap();

        migrate_db_sidecar(&from, &to, "-wal").unwrap();
        migrate_db_sidecar(&from, &to, "-shm").unwrap();
        move_sidecar(&from, &to, "-wal").unwrap();
        move_sidecar(&from, &to, "-shm").unwrap();
        remove_db_with_sidecars(&from).unwrap();

        assert!(to.exists(), "destination DB stays intact");
        let _ = remove_db_with_sidecars(&to);
    }

    #[test]
    fn restore_database_backup_keeps_active_when_backup_missing() {
        let active_path = unique_temp_file("restore-active");
        let backup_path = unique_temp_file("restore-missing-backup");
        let cache = open_file_cache(&active_path);
        let k = key_on("server-a", "active-track");
        cache.touch_track_status(&k, "ready").unwrap();
        cache.upsert_waveform(&k, &waveform(4, false)).unwrap();

        cache
            .restore_database_backup(&backup_path, &active_path)
            .unwrap();
        assert!(cache.get_waveform(&k).unwrap().is_none());

        let _ = remove_db_with_sidecars(&active_path);
    }

    #[test]
    fn init_opens_app_scoped_database_path() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let cache = AnalysisCache::init(&handle).expect("analysis cache init with mock app");
        cache.checkpoint_wal("init-test").unwrap();
    }

    #[test]
    fn latest_status_for_track_prefers_newest_variant_timestamp() {
        let cache = AnalysisCache::open_in_memory();
        let base = key_on("server-a", "track-1");
        let prefixed = key_on("server-a", "stream:track-1");

        cache.touch_track_status(&base, "queued").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1200));
        cache.touch_track_status(&prefixed, "failed").unwrap();

        let row = cache
            .get_latest_status_for_track("server-a", "track-1")
            .unwrap()
            .expect("latest status row");
        assert_eq!(row.0, "failed");
    }

    #[test]
    fn failed_track_queries_deduplicate_stream_variants() {
        let cache = AnalysisCache::open_in_memory();
        let base = key_on("server-a", "track-2");
        let prefixed = key_on("server-a", "stream:track-2");
        let other = key_on("server-a", "track-3");

        cache.touch_track_status(&base, "failed").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1200));
        cache.touch_track_status(&prefixed, "failed").unwrap();
        cache.touch_track_status(&other, "failed").unwrap();

        let count = cache.count_failed_tracks("server-a").unwrap();
        assert_eq!(count, 2);

        let listed = cache.list_failed_tracks("server-a", None).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|r| r.track_id == "track-2"));
        assert!(listed.iter().any(|r| r.track_id == "track-3"));
    }

    #[test]
    fn clear_failed_tracks_removes_only_failed_rows() {
        let cache = AnalysisCache::open_in_memory();
        let failed = key_on("server-a", "track-failed");
        let ready = key_on("server-a", "track-ready");
        cache.touch_track_status(&failed, "failed").unwrap();
        cache.touch_track_status(&ready, "ready").unwrap();

        let deleted = cache
            .clear_failed_tracks("server-a", &["track-failed".to_string()])
            .unwrap();
        assert_eq!(deleted, 1);
        assert_eq!(cache.count_failed_tracks("server-a").unwrap(), 0);
        let ready_latest = cache
            .get_latest_status_for_track("server-a", "track-ready")
            .unwrap()
            .expect("ready row stays");
        assert_eq!(ready_latest.0, "ready");
    }
}
