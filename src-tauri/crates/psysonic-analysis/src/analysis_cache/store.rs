use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::Manager;

pub(super) const WAVEFORM_ALGO_VERSION: i64 = 4;
pub(super) const LOUDNESS_ALGO_VERSION: i64 = 1;

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
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        configure_connection(&conn).map_err(|e| e.to_string())?;
        migrate_schema(&conn).map_err(|e| e.to_string())?;
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
        let conn = Connection::open_in_memory().expect("in-memory connection");
        conn.pragma_update(None, "foreign_keys", "ON").expect("pragma foreign_keys");
        migrate_schema(&conn).expect("schema migration");
        Self { conn: Mutex::new(conn) }
    }

    /// Remove all `loudness_cache` rows for this logical track (bare id and `stream:` variant).
    pub fn delete_loudness_for_track_id(&self, track_id: &str) -> Result<u64, String> {
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
                .execute("DELETE FROM loudness_cache WHERE track_id = ?1", params![tid])
                .map_err(|e| e.to_string())?;
            total = total.saturating_add(n as u64);
        }
        Ok(total)
    }

    /// Remove all `waveform_cache` rows for this logical track (bare id and `stream:` variant).
    pub fn delete_waveform_for_track_id(&self, track_id: &str) -> Result<u64, String> {
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
                .execute("DELETE FROM waveform_cache WHERE track_id = ?1", params![tid])
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
                track_id, md5_16kb, status, waveform_algo_version, loudness_algo_version, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(track_id, md5_16kb) DO UPDATE SET
                status = excluded.status,
                waveform_algo_version = excluded.waveform_algo_version,
                loudness_algo_version = excluded.loudness_algo_version,
                updated_at = excluded.updated_at
            "#,
            params![
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
                track_id, md5_16kb, bins, bin_count, is_partial, known_until_sec, duration_sec, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(track_id, md5_16kb) DO UPDATE SET
                bins = excluded.bins,
                bin_count = excluded.bin_count,
                is_partial = excluded.is_partial,
                known_until_sec = excluded.known_until_sec,
                duration_sec = excluded.duration_sec,
                updated_at = excluded.updated_at
            "#,
            params![
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
                track_id, md5_16kb, integrated_lufs, true_peak, recommended_gain_db, target_lufs, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(track_id, md5_16kb, target_lufs) DO UPDATE SET
                integrated_lufs = excluded.integrated_lufs,
                true_peak = excluded.true_peak,
                recommended_gain_db = excluded.recommended_gain_db,
                updated_at = excluded.updated_at
            "#,
            params![
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
              ON a.track_id = w.track_id
             AND a.md5_16kb = w.md5_16kb
            WHERE w.track_id = ?1
              AND w.md5_16kb = ?2
              AND a.waveform_algo_version = ?3
            "#,
                params![key.track_id, key.md5_16kb, WAVEFORM_ALGO_VERSION],
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
                ON a.track_id = l.track_id
               AND a.md5_16kb = l.md5_16kb
              WHERE l.track_id = ?1
                AND l.md5_16kb = ?2
                AND a.loudness_algo_version = ?3
            )
            "#,
                params![key.track_id, key.md5_16kb, LOUDNESS_ALGO_VERSION],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(exists != 0)
    }

    pub fn get_latest_waveform_for_track(&self, track_id: &str) -> Result<Option<WaveformEntry>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        const SQL: &str = r#"
            SELECT w.bins, w.bin_count, w.is_partial, w.known_until_sec, w.duration_sec, w.updated_at
            FROM waveform_cache w
            JOIN analysis_track a
              ON a.track_id = w.track_id
             AND a.md5_16kb = w.md5_16kb
            WHERE w.track_id = ?1
              AND a.waveform_algo_version = ?2
            ORDER BY w.updated_at DESC
            LIMIT 1
            "#;
        for tid in track_id_cache_variants(track_id) {
            let row = conn
                .query_row(
                    SQL,
                    params![tid, WAVEFORM_ALGO_VERSION],
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
            if let Some(e) = row {
                if waveform_cache_blob_len_ok(&e.bins, e.bin_count) {
                    return Ok(Some(e));
                }
            }
        }
        Ok(None)
    }

    /// Both waveform and loudness rows exist — a CPU seed from bytes/file would only
    /// decode the file to immediately skip with `SkippedWaveformCacheHit`.
    pub fn cpu_seed_redundant_for_track(&self, track_id: &str) -> Result<bool, String> {
        Ok(
            self.get_latest_waveform_for_track(track_id)?.is_some()
                && self.get_latest_loudness_for_track(track_id)?.is_some(),
        )
    }

    pub fn get_latest_loudness_for_track(&self, track_id: &str) -> Result<Option<LoudnessSnapshot>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        const SQL: &str = r#"
            SELECT l.integrated_lufs, l.true_peak, l.recommended_gain_db, l.target_lufs, l.updated_at
            FROM loudness_cache l
            JOIN analysis_track a
              ON a.track_id = l.track_id
             AND a.md5_16kb = l.md5_16kb
            WHERE l.track_id = ?1
              AND a.loudness_algo_version = ?2
            ORDER BY l.updated_at DESC
            LIMIT 1
            "#;
        for tid in track_id_cache_variants(track_id) {
            let row = conn
                .query_row(
                    SQL,
                    params![tid, LOUDNESS_ALGO_VERSION],
                    |row| {
                        Ok(LoudnessSnapshot {
                            integrated_lufs: row.get(0)?,
                            true_peak: row.get(1)?,
                            recommended_gain_db: row.get(2)?,
                            target_lufs: row.get(3)?,
                            updated_at: row.get(4)?,
                        })
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if row.is_some() {
                return Ok(row);
            }
        }
        Ok(None)
    }
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

fn migrate_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS analysis_track (
            track_id TEXT NOT NULL,
            md5_16kb TEXT NOT NULL,
            status TEXT NOT NULL,
            waveform_algo_version INTEGER NOT NULL,
            loudness_algo_version INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (track_id, md5_16kb)
        );

        CREATE TABLE IF NOT EXISTS waveform_cache (
            track_id TEXT NOT NULL,
            md5_16kb TEXT NOT NULL,
            bins BLOB NOT NULL,
            bin_count INTEGER NOT NULL,
            is_partial INTEGER NOT NULL,
            known_until_sec REAL NOT NULL,
            duration_sec REAL NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (track_id, md5_16kb)
        );

        CREATE TABLE IF NOT EXISTS loudness_cache (
            track_id TEXT NOT NULL,
            md5_16kb TEXT NOT NULL,
            integrated_lufs REAL NOT NULL,
            true_peak REAL NOT NULL,
            recommended_gain_db REAL NOT NULL,
            target_lufs REAL NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (track_id, md5_16kb, target_lufs)
        );

        CREATE INDEX IF NOT EXISTS idx_analysis_track_status
            ON analysis_track(status);
        "#,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(track_id: &str) -> TrackKey {
        TrackKey {
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
        assert_eq!(tables, vec!["analysis_track", "loudness_cache", "waveform_cache"]);
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
        let got = cache.get_latest_waveform_for_track("abc").unwrap();
        assert!(got.is_some(), "bare-id lookup must find stream-prefixed row");
    }

    #[test]
    fn get_latest_loudness_finds_row_under_other_variant() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();
        cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
        let got = cache.get_latest_loudness_for_track("stream:abc").unwrap();
        assert!(got.is_some(), "stream-prefixed lookup must find bare row");
    }

    // ── cpu_seed_redundant_for_track ──────────────────────────────────────────

    #[test]
    fn cpu_seed_redundant_requires_both_waveform_and_loudness() {
        let cache = AnalysisCache::open_in_memory();
        let k = key("abc");
        cache.touch_track_status(&k, "ok").unwrap();

        assert!(!cache.cpu_seed_redundant_for_track("abc").unwrap());

        cache.upsert_waveform(&k, &waveform(4, false)).unwrap();
        assert!(
            !cache.cpu_seed_redundant_for_track("abc").unwrap(),
            "waveform alone is not enough"
        );

        cache.upsert_loudness(&k, &loudness(-14.0)).unwrap();
        assert!(cache.cpu_seed_redundant_for_track("abc").unwrap());
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

        let deleted = cache.delete_loudness_for_track_id("abc").unwrap();
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

        let deleted = cache.delete_waveform_for_track_id("abc").unwrap();
        assert_eq!(deleted, 2);
        assert!(cache.get_waveform(&bare).unwrap().is_none());
        assert!(cache.get_waveform(&prefixed).unwrap().is_none());
    }

    #[test]
    fn delete_with_empty_or_whitespace_track_id_is_noop() {
        let cache = AnalysisCache::open_in_memory();
        assert_eq!(cache.delete_waveform_for_track_id("").unwrap(), 0);
        assert_eq!(cache.delete_waveform_for_track_id("   ").unwrap(), 0);
        assert_eq!(cache.delete_loudness_for_track_id("").unwrap(), 0);
        assert_eq!(cache.delete_loudness_for_track_id("   ").unwrap(), 0);
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
}
