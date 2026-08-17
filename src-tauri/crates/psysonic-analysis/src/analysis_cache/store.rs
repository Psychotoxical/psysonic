mod crud;
mod lifecycle;
mod migrations;
mod queries;
mod schema;

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

#[allow(unused_imports)]
pub(crate) use migrations::run_migrations_with;

pub(super) const WAVEFORM_ALGO_VERSION: i64 = 4;
pub(super) const LOUDNESS_ALGO_VERSION: i64 = 1;

/// Current head of the embedded migrations. Bump for each new
/// `migrations/NNN_*.sql`.
pub const ANALYSIS_DB_SCHEMA_VERSION: i64 = 2;

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

#[cfg(test)]
mod tests;
