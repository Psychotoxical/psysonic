use crate::analysis_cache;

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WaveformCachePayload {
    pub bins: Vec<u8>,
    pub bin_count: i64,
    pub is_partial: bool,
    pub known_until_sec: f64,
    pub duration_sec: f64,
    pub updated_at: i64,
}

impl From<analysis_cache::WaveformEntry> for WaveformCachePayload {
    fn from(v: analysis_cache::WaveformEntry) -> Self {
        Self {
            bins: v.bins,
            bin_count: v.bin_count,
            is_partial: v.is_partial,
            known_until_sec: v.known_until_sec,
            duration_sec: v.duration_sec,
            updated_at: v.updated_at,
        }
    }
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessCachePayload {
    pub integrated_lufs: f64,
    pub true_peak: f64,
    pub recommended_gain_db: f64,
    pub target_lufs: f64,
    pub updated_at: i64,
}

/// AppHandle-free helper: looks up a waveform by exact `(server_id, track_id,
/// md5_16kb)` key. Converts the `WaveformEntry` into the JSON-serialisable
/// `WaveformCachePayload`. Pulled out of [`super::analysis_get_waveform`] so it
/// can be tested with `AnalysisCache::open_in_memory()` and direct upserts.
pub fn get_waveform_payload(
    cache: &analysis_cache::AnalysisCache,
    server_id: &str,
    track_id: &str,
    md5_16kb: &str,
) -> Result<Option<WaveformCachePayload>, String> {
    let exact = analysis_cache::TrackKey {
        server_id: server_id.to_string(),
        track_id: track_id.to_string(),
        md5_16kb: md5_16kb.to_string(),
    };
    Ok(cache.get_waveform(&exact)?.map(WaveformCachePayload::from))
}

/// AppHandle-free helper: looks up the latest waveform for `(server_id, track_id)`
/// across all id variants (bare ↔ `stream:` prefix). See [`get_waveform_payload`].
pub fn get_waveform_payload_for_track(
    cache: &analysis_cache::AnalysisCache,
    server_id: &str,
    track_id: &str,
) -> Result<Option<WaveformCachePayload>, String> {
    Ok(cache
        .get_latest_waveform_for_track(server_id, track_id)?
        .map(WaveformCachePayload::from))
}

/// AppHandle-free helper: looks up the latest loudness row for `(server_id,
/// track_id)` and recomputes `recommended_gain_db`
/// against the optional requested target (clamped to [-30, -8]). When
/// `target_lufs` is `None`, the cached row's own target is used.
pub fn get_loudness_payload_for_track(
    cache: &analysis_cache::AnalysisCache,
    server_id: &str,
    track_id: &str,
    target_lufs: Option<f64>,
) -> Result<Option<LoudnessCachePayload>, String> {
    Ok(cache
        .get_latest_loudness_for_track(server_id, track_id)?
        .map(|v| {
            let requested_target = target_lufs.unwrap_or(v.target_lufs).clamp(-30.0, -8.0);
            let recommended_gain_db = analysis_cache::recommended_gain_for_target(
                v.integrated_lufs,
                v.true_peak,
                requested_target,
            );
            LoudnessCachePayload {
                integrated_lufs: v.integrated_lufs,
                true_peak: v.true_peak,
                recommended_gain_db,
                target_lufs: requested_target,
                updated_at: v.updated_at,
            }
        }))
}
