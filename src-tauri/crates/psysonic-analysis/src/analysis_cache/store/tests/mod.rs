use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use super::lifecycle::{
    cleanup_legacy_db_if_present, configure_connection, migrate_db_file, migrate_db_sidecar,
    move_sidecar, remove_db_with_sidecars, SwapDatabaseStage,
};
use super::migrations::{
    backup_before_pending_migration, run_migrations, MIGRATIONS, MIGRATION_001_BASELINE,
};
use super::schema::verify_operational_schema_conn;
use super::*;

mod crud;
mod lifecycle;
mod migrations;
mod queries;
mod schema;

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

fn unique_temp_dir(tag: &str) -> PathBuf {
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
    dir.join(format!(
        "audio-analysis.sqlite.pre-v{ANALYSIS_DB_SCHEMA_VERSION}.bak"
    ))
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
    verify_operational_schema_conn(&conn).unwrap();
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
