use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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
const MIGRATIONS: &[(i64, &str)] = &[(1, MIGRATION_001_BASELINE), (2, MIGRATION_002_SERVER_ID)];

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
    /// App server id this analysis belongs to. Empty string is the legacy
    /// (pre-002) value: rows migrated from the unscoped schema and any caller
    /// that does not yet know the server (filled in by 6c-2).
    pub server_id: String,
    pub track_id: String,
    pub md5_16kb: String,
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

pub(super) fn now_unix_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl AnalysisCache {
    pub fn init(app: &tauri::AppHandle) -> Result<Self, String> {
        let db_path = analysis_db_path(app)?;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        backup_before_pending_migration(&db_path)?;
        let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        configure_connection(&conn).map_err(|e| e.to_string())?;
        run_migrations(&mut conn).map_err(|e| e.to_string())?;
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
        Self { conn: Mutex::new(conn) }
    }

    /// Remove `loudness_cache` rows for this logical track (bare id and `stream:`
    /// variant) **scoped to one server plus the legacy `''` pool**. A reseed on
    /// server A must not delete server B's analysis for the same bare `track_id`;
    /// the legacy `''` rows are cleared too so a stale pre-002 blob can't shadow
    /// the fresh re-analysis via the read fallback (and so it isn't seen as
    /// redundant). Pass `server_id = ""` to target only the legacy pool.
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
                    "DELETE FROM loudness_cache WHERE track_id = ?1 AND server_id IN (?2, '')",
                    params![tid, server_id],
                )
                .map_err(|e| e.to_string())?;
            total = total.saturating_add(n as u64);
        }
        Ok(total)
    }

    /// Remove `waveform_cache` rows for this logical track (bare id and `stream:`
    /// variant) scoped to one server plus the legacy `''` pool. See
    /// [`Self::delete_loudness_for_track_id`] for the scoping rationale.
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
                    "DELETE FROM waveform_cache WHERE track_id = ?1 AND server_id IN (?2, '')",
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

    /// Latest waveform for `(server_id, track_id)` with legacy fallback. Tries the
    /// server-scoped rows first (both id variants), then the legacy `server_id=''`
    /// pool. On a legacy hit while a real `server_id` is known, the matching rows
    /// are re-tagged under the server-scoped key (best-effort) so subsequent reads
    /// hit the exact key and other servers can't shadow each other via `''`.
    pub fn get_latest_waveform_for_track(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<Option<WaveformEntry>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        if let Some(e) = query_latest_waveform_scoped(&conn, server_id, track_id)? {
            return Ok(Some(e));
        }
        if !server_id.is_empty() {
            if let Some(e) = query_latest_waveform_scoped(&conn, "", track_id)? {
                let _ = relabel_legacy_to_server(&conn, server_id, track_id);
                return Ok(Some(e));
            }
        }
        Ok(None)
    }

    /// Both waveform and loudness rows exist for this `(server_id, track_id)`
    /// (including the legacy `''` fallback) — a CPU seed from bytes/file would
    /// only decode the file to immediately skip with `SkippedWaveformCacheHit`.
    /// A legacy hit is re-tagged onto the server scope as a side effect (see
    /// [`Self::get_latest_waveform_for_track`]), so skipping the seed still leaves
    /// the track resolvable under its real `server_id`.
    pub fn cpu_seed_redundant_for_track(&self, server_id: &str, track_id: &str) -> Result<bool, String> {
        Ok(
            self.get_latest_waveform_for_track(server_id, track_id)?.is_some()
                && self.get_latest_loudness_for_track(server_id, track_id)?.is_some(),
        )
    }

    /// Latest loudness for `(server_id, track_id)` with the same legacy fallback +
    /// lazy re-tag behaviour as [`Self::get_latest_waveform_for_track`].
    pub fn get_latest_loudness_for_track(
        &self,
        server_id: &str,
        track_id: &str,
    ) -> Result<Option<LoudnessSnapshot>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        if let Some(s) = query_latest_loudness_scoped(&conn, server_id, track_id)? {
            return Ok(Some(s));
        }
        if !server_id.is_empty() {
            if let Some(s) = query_latest_loudness_scoped(&conn, "", track_id)? {
                let _ = relabel_legacy_to_server(&conn, server_id, track_id);
                return Ok(Some(s));
            }
        }
        Ok(None)
    }

    /// Copy any legacy (`server_id=''`) analysis rows for `track_id` (both id
    /// variants) onto `server_id` via `INSERT OR IGNORE` — best-effort, never
    /// clobbers an existing server-scoped row. Exposed for the exact-key read
    /// command, which re-tags after a legacy hit. No-op when `server_id` is empty.
    pub fn relabel_legacy_to_server(&self, server_id: &str, track_id: &str) -> Result<(), String> {
        if server_id.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        relabel_legacy_to_server(&conn, server_id, track_id).map_err(|e| e.to_string())
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

/// Lazy re-tag: copy legacy (`server_id=''`) `analysis_track` + `waveform_cache` +
/// `loudness_cache` rows for every id variant of `track_id` onto `server_id`.
/// `INSERT OR IGNORE` so an already-present server-scoped row (e.g. a precise
/// playback-derived analysis) is never overwritten. Best-effort, no transaction:
/// the rows are individually consistent and a partial copy still leaves the
/// legacy rows readable via fallback.
fn relabel_legacy_to_server(
    conn: &Connection,
    server_id: &str,
    track_id: &str,
) -> rusqlite::Result<()> {
    for tid in track_id_cache_variants(track_id) {
        conn.execute(
            r#"
            INSERT OR IGNORE INTO analysis_track
                (server_id, track_id, md5_16kb, status, waveform_algo_version, loudness_algo_version, updated_at)
            SELECT ?1, track_id, md5_16kb, status, waveform_algo_version, loudness_algo_version, updated_at
            FROM analysis_track WHERE server_id = '' AND track_id = ?2
            "#,
            params![server_id, tid],
        )?;
        conn.execute(
            r#"
            INSERT OR IGNORE INTO waveform_cache
                (server_id, track_id, md5_16kb, bins, bin_count, is_partial, known_until_sec, duration_sec, updated_at)
            SELECT ?1, track_id, md5_16kb, bins, bin_count, is_partial, known_until_sec, duration_sec, updated_at
            FROM waveform_cache WHERE server_id = '' AND track_id = ?2
            "#,
            params![server_id, tid],
        )?;
        conn.execute(
            r#"
            INSERT OR IGNORE INTO loudness_cache
                (server_id, track_id, md5_16kb, integrated_lufs, true_peak, recommended_gain_db, target_lufs, updated_at)
            SELECT ?1, track_id, md5_16kb, integrated_lufs, true_peak, recommended_gain_db, target_lufs, updated_at
            FROM loudness_cache WHERE server_id = '' AND track_id = ?2
            "#,
            params![server_id, tid],
        )?;
    }
    Ok(())
}

fn analysis_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    Ok(base.join("audio-analysis.sqlite"))
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

    fn key(track_id: &str) -> TrackKey {
        TrackKey {
            server_id: String::new(),
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
        let got = cache.get_latest_waveform_for_track("", "abc").unwrap();
        assert!(got.is_some(), "bare-id lookup must find stream-prefixed row");
    }

    #[test]
    fn get_latest_loudness_finds_row_under_other_variant() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();
        cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
        let got = cache.get_latest_loudness_for_track("", "stream:abc").unwrap();
        assert!(got.is_some(), "stream-prefixed lookup must find bare row");
    }

    // ── cpu_seed_redundant_for_track ──────────────────────────────────────────

    #[test]
    fn cpu_seed_redundant_requires_both_waveform_and_loudness() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();

        assert!(!cache.cpu_seed_redundant_for_track("", "abc").unwrap());

        cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
        assert!(
            !cache.cpu_seed_redundant_for_track("", "abc").unwrap(),
            "waveform alone is not enough"
        );

        cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
        assert!(cache.cpu_seed_redundant_for_track("", "abc").unwrap());
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

        let deleted = cache.delete_loudness_for_track_id("", "abc").unwrap();
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

        let deleted = cache.delete_waveform_for_track_id("", "abc").unwrap();
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
        // bare track_id; the legacy '' pool is cleared alongside server-a.
        let cache = AnalysisCache::open_in_memory();
        let on_a = key_on("server-a", "t");
        let on_b = key_on("server-b", "t");
        let legacy = key_on("", "t");
        for k in [&on_a, &on_b, &legacy] {
            cache.touch_track_status(k, "ok").unwrap();
            cache.upsert_waveform(k, &waveform(4, false)).unwrap();
            cache.upsert_loudness(k, &loudness(-14.0)).unwrap();
        }

        let deleted = cache.delete_waveform_for_track_id("server-a", "t").unwrap();
        assert_eq!(deleted, 2, "server-a + legacy '' waveform rows removed");
        assert!(cache.get_waveform(&on_a).unwrap().is_none());
        assert!(cache.get_waveform(&legacy).unwrap().is_none());
        assert!(
            cache.get_waveform(&on_b).unwrap().is_some(),
            "another server's waveform must survive a scoped reseed"
        );

        let deleted_l = cache.delete_loudness_for_track_id("server-a", "t").unwrap();
        assert_eq!(deleted_l, 2);
        assert!(cache.loudness_row_exists_for_key(&on_b).unwrap());
    }

    // ── server scope: read fallback + lazy re-tag ─────────────────────────────

    #[test]
    fn get_latest_waveform_falls_back_to_legacy_and_retags() {
        // A pre-002 blob lives under server_id=''. A read for a real server must
        // find it via fallback and re-tag it under the server-scoped key.
        let cache = AnalysisCache::open_in_memory();
        let legacy = key_on("", "t");
        cache.touch_track_status(&legacy, "ready").unwrap();
        cache.upsert_waveform(&legacy, &waveform(4, false)).unwrap();
        cache.upsert_loudness(&legacy, &loudness(-14.0)).unwrap();

        // server-a has no scoped row yet → fallback returns the legacy blob.
        assert!(cache.get_waveform(&key_on("server-a", "t")).unwrap().is_none());
        assert!(cache.get_latest_waveform_for_track("server-a", "t").unwrap().is_some());

        // Re-tag side effect: the exact server-scoped key now resolves directly.
        assert!(
            cache.get_waveform(&key_on("server-a", "t")).unwrap().is_some(),
            "legacy hit must be re-tagged under the server scope"
        );
        // Legacy row is preserved (copy, not move).
        assert!(cache.get_waveform(&legacy).unwrap().is_some());
    }

    #[test]
    fn retag_does_not_clobber_existing_server_scoped_row() {
        // server-a already has a precise (playback-derived) row; a legacy hit must
        // not overwrite it via INSERT OR IGNORE.
        let cache = AnalysisCache::open_in_memory();
        let legacy = key_on("", "t");
        cache.touch_track_status(&legacy, "ready").unwrap();
        cache.upsert_waveform(&legacy, &waveform(4, true)).unwrap();
        cache.upsert_loudness(&legacy, &loudness(-14.0)).unwrap();

        let on_a = key_on("server-a", "t");
        cache.touch_track_status(&on_a, "ready").unwrap();
        let precise = WaveformEntry { is_partial: false, ..waveform(4, false) };
        cache.upsert_waveform(&on_a, &precise).unwrap();
        cache.upsert_loudness(&on_a, &loudness(-14.0)).unwrap();

        cache.relabel_legacy_to_server("server-a", "t").unwrap();
        let got = cache.get_waveform(&on_a).unwrap().expect("server row present");
        assert!(!got.is_partial, "precise server-scoped row must be preserved");
    }

    #[test]
    fn get_latest_loudness_legacy_fallback_scopes_to_requested_server() {
        let cache = AnalysisCache::open_in_memory();
        let legacy = key_on("", "t");
        cache.touch_track_status(&legacy, "ready").unwrap();
        cache.upsert_loudness(&legacy, &loudness(-12.0)).unwrap();

        // server-b has its own distinct loudness → exact hit, no fallback.
        let on_b = key_on("server-b", "t");
        cache.touch_track_status(&on_b, "ready").unwrap();
        cache.upsert_loudness(&on_b, &loudness(-20.0)).unwrap();

        let a = cache.get_latest_loudness_for_track("server-a", "t").unwrap().unwrap();
        assert_eq!(a.target_lufs, -12.0, "server-a falls back to legacy blob");
        let b = cache.get_latest_loudness_for_track("server-b", "t").unwrap().unwrap();
        assert_eq!(b.target_lufs, -20.0, "server-b uses its own scoped blob, not legacy");
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
    fn migration_002_preserves_legacy_rows_under_empty_server_id() {
        // Simulate a real pre-002 user DB: old schema + one row per table, no
        // schema_migrations.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_001_BASELINE).unwrap();
        conn.execute(
            "INSERT INTO analysis_track (track_id, md5_16kb, status, waveform_algo_version, loudness_algo_version, updated_at)
             VALUES ('t1','m1','ready',?1,?2,123)",
            params![WAVEFORM_ALGO_VERSION, LOUDNESS_ALGO_VERSION],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO waveform_cache (track_id, md5_16kb, bins, bin_count, is_partial, known_until_sec, duration_sec, updated_at)
             VALUES ('t1','m1',?1,4,0,0.0,60.0,123)",
            params![vec![0u8; 8]],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO loudness_cache (track_id, md5_16kb, integrated_lufs, true_peak, recommended_gain_db, target_lufs, updated_at)
             VALUES ('t1','m1',-14.0,-1.0,0.0,-14.0,123)",
            [],
        )
        .unwrap();

        run_migrations_with(&mut conn, MIGRATIONS).unwrap();

        // No data lost; legacy rows now carry server_id = ''.
        let track_sid: String = conn
            .query_row("SELECT server_id FROM analysis_track WHERE track_id='t1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(track_sid, "");
        let waveforms: i64 = conn
            .query_row("SELECT COUNT(*) FROM waveform_cache WHERE server_id=''", [], |r| r.get(0))
            .unwrap();
        assert_eq!(waveforms, 1);
        let loudness: i64 = conn
            .query_row("SELECT COUNT(*) FROM loudness_cache WHERE server_id=''", [], |r| r.get(0))
            .unwrap();
        assert_eq!(loudness, 1);

        // The legacy blob is readable through the cache API under the '' key.
        let cache = AnalysisCache { conn: Mutex::new(conn) };
        let legacy_key = TrackKey {
            server_id: String::new(),
            track_id: "t1".to_string(),
            md5_16kb: "m1".to_string(),
        };
        assert!(cache.get_waveform(&legacy_key).unwrap().is_some());
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
}
