use std::time::Instant;

use psysonic_core::track_enrichment::TrackEnrichmentOutcome;
use tauri::{Manager, Runtime};

use crate::analysis_perf::AnalysisSeedTimings;

use super::super::store::{now_unix_ts, AnalysisCache, LoudnessEntry, TrackKey, WaveformEntry};
use super::waveform::{analyze_loudness_and_waveform, derive_waveform_bins};

/// Result of [`seed_from_bytes_execute`] / CPU seed queue: callers use it to avoid redundant UI events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedFromBytesOutcome {
    /// Wrote waveform (and loudness when PCM decode succeeded).
    Upserted,
    /// Same `track_id` + `md5_16kb` already had a non-empty waveform for this algo version.
    SkippedWaveformCacheHit,
    /// `AnalysisCache` was not registered on the app handle.
    SkippedNoAnalysisCache,
}

/// Full Symphonia + (optional) EBU decode for waveform + loudness. Call only from the
/// single CPU-seed worker in `lib.rs` (`spawn_blocking`) so at most one heavy decode runs.
#[allow(clippy::too_many_arguments)]
pub fn seed_from_bytes_execute<R: Runtime>(
    app: &tauri::AppHandle<R>,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    format_hint: Option<&str>,
    trusted_md5_16kb: Option<&str>,
    trusted_generation: Option<u64>,
    notify_ui: bool,
) -> Result<(SeedFromBytesOutcome, AnalysisSeedTimings), String> {
    seed_from_bytes_execute_with_policy(
        app,
        server_id,
        track_id,
        bytes,
        format_hint,
        trusted_md5_16kb,
        trusted_generation,
        true,
        notify_ui,
    )
}

/// Analyse a server-generated transcode while storing the result under a
/// separately verified fingerprint of the original file.
#[allow(clippy::too_many_arguments)]
pub(crate) fn seed_transcoded_bytes_execute<R: Runtime>(
    app: &tauri::AppHandle<R>,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    format_hint: Option<&str>,
    trusted_md5_16kb: &str,
    trusted_generation: u64,
    notify_ui: bool,
) -> Result<(SeedFromBytesOutcome, AnalysisSeedTimings), String> {
    seed_from_bytes_execute_with_policy(
        app,
        server_id,
        track_id,
        bytes,
        format_hint,
        Some(trusted_md5_16kb),
        Some(trusted_generation),
        false,
        notify_ui,
    )
}

#[allow(clippy::too_many_arguments)]
fn seed_from_bytes_execute_with_policy<R: Runtime>(
    app: &tauri::AppHandle<R>,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    format_hint: Option<&str>,
    trusted_md5_16kb: Option<&str>,
    trusted_generation: Option<u64>,
    verify_trusted_prefix: bool,
    notify_ui: bool,
) -> Result<(SeedFromBytesOutcome, AnalysisSeedTimings), String> {
    let seed_started = Instant::now();
    let Some(cache) = app.try_state::<AnalysisCache>() else {
        crate::app_deprintln!(
            "[analysis][waveform] build skip track_id={} reason=no_analysis_cache bytes={}",
            track_id,
            bytes.len()
        );
        return Ok((
            SeedFromBytesOutcome::SkippedNoAnalysisCache,
            AnalysisSeedTimings::default(),
        ));
    };
    let (outcome, md5_16kb) = seed_from_bytes_into_cache_with_policy(
        &cache,
        server_id,
        track_id,
        bytes,
        format_hint,
        trusted_md5_16kb,
        verify_trusted_prefix,
    )?;
    let seed_ms = seed_started.elapsed().as_millis() as u64;
    // E2 bridge for byte-owned originals (local/offline paths). Trusted HTTP
    // revisions activate in `analysis_runtime` after its per-track generation
    // guard approves the completion, so an older decode cannot overwrite or
    // purge a newer trusted result.
    if !server_id.is_empty()
        && trusted_md5_16kb.is_none()
        && matches!(
            outcome,
            SeedFromBytesOutcome::Upserted | SeedFromBytesOutcome::SkippedWaveformCacheHit
        )
    {
        if let Some(sink) = app.try_state::<psysonic_core::ports::ContentHashSink>() {
            sink.record_content_hash(server_id, track_id, &md5_16kb);
        }
    }
    let bpm_ms = if !server_id.is_empty() {
        let bpm_started = Instant::now();
        let enrichment_outcome = crate::track_enrichment::run_track_enrichment_if_needed(
            app,
            server_id,
            track_id,
            bytes,
            trusted_md5_16kb,
            trusted_generation.map(|generation| (server_id, generation)),
            notify_ui,
        );
        if matches!(enrichment_outcome, TrackEnrichmentOutcome::Failed) {
            let key = TrackKey {
                server_id: server_id.to_string(),
                track_id: track_id.to_string(),
                md5_16kb: md5_16kb.clone(),
            };
            let _ = cache.touch_track_status(&key, "failed");
        }
        if matches!(outcome, SeedFromBytesOutcome::Upserted) {
            if let Ok(coverage) = cache.content_cache_coverage(server_id, track_id, &md5_16kb) {
                if !coverage.has_loudness {
                    let key = TrackKey {
                        server_id: server_id.to_string(),
                        track_id: track_id.to_string(),
                        md5_16kb: md5_16kb.clone(),
                    };
                    let _ = cache.touch_track_status(&key, "failed");
                }
            }
        }
        bpm_started.elapsed().as_millis() as u64
    } else {
        0
    };
    Ok((outcome, AnalysisSeedTimings { seed_ms, bpm_ms }))
}

/// AppHandle-free entry point for [`seed_from_bytes_execute`]: takes the cache
/// directly, runs the same Symphonia → waveform → EBU R128 pipeline, and
/// upserts the rows. Called from `seed_from_bytes_execute` in production and
/// from tests against an in-memory cache.
/// Returns the outcome plus the computed `md5_16kb` (the content fingerprint),
/// so the AppHandle-aware caller can bridge it to the library `content_hash`
/// (E2) without re-reading the bytes.
pub fn seed_from_bytes_into_cache(
    cache: &AnalysisCache,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    format_hint: Option<&str>,
    trusted_md5_16kb: Option<&str>,
) -> Result<(SeedFromBytesOutcome, String), String> {
    seed_from_bytes_into_cache_with_policy(
        cache,
        server_id,
        track_id,
        bytes,
        format_hint,
        trusted_md5_16kb,
        true,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn seed_from_bytes_into_cache_with_policy(
    cache: &AnalysisCache,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    format_hint: Option<&str>,
    trusted_md5_16kb: Option<&str>,
    verify_trusted_prefix: bool,
) -> Result<(SeedFromBytesOutcome, String), String> {
    let started = Instant::now();
    if let Some(trusted) = trusted_md5_16kb.filter(|_| verify_trusted_prefix) {
        if md5_first_16kb(bytes) != trusted {
            return Err("trusted original fingerprint does not match analysis bytes".to_string());
        }
    }
    // Write under the playback server's scope. Ordinary trusted callers must
    // carry the original prefix; the narrow transcode entry point establishes
    // that identity separately with a raw-original probe.
    let key = TrackKey {
        server_id: server_id.to_string(),
        track_id: track_id.to_string(),
        md5_16kb: trusted_md5_16kb
            .map(str::to_string)
            .unwrap_or_else(|| md5_first_16kb(bytes)),
    };
    let coverage = cache.content_cache_coverage(server_id, track_id, &key.md5_16kb)?;
    if coverage.complete() {
        crate::app_deprintln!(
            "[analysis][waveform] build skip track_id={} reason=waveform_cache_hit md5_16kb={} elapsed_ms={}",
            track_id,
            key.md5_16kb,
            started.elapsed().as_millis()
        );
        return Ok((
            SeedFromBytesOutcome::SkippedWaveformCacheHit,
            key.md5_16kb.clone(),
        ));
    }
    if coverage.has_waveform && !coverage.has_loudness {
        crate::app_deprintln!(
            "[analysis][waveform] waveform cache hit but loudness missing — full re-analysis track_id={} md5_16kb={}",
            track_id,
            key.md5_16kb
        );
    }
    let mib = bytes.len() as f64 / (1024.0 * 1024.0);
    crate::app_deprintln!(
        "[analysis] full-track analysis start track_id={} input_mib={:.2} md5_16kb={}",
        track_id,
        mib,
        key.md5_16kb
    );
    crate::app_deprintln!(
        "[analysis] full-track analysis work: Symphonia decodes the entire buffer twice (frame timeline, then PCM peak bins), then EBU R128 integrated loudness + true-peak when that succeeds — CPU-bound; large lossless files often take minutes"
    );

    let build = (|| -> Result<(bool, usize), String> {
        cache.touch_track_status(&key, "queued")?;

        let (wf_bins, loudness_opt, used_pcm_decode) =
            match analyze_loudness_and_waveform(bytes, -16.0, 500, format_hint) {
                Some((integrated_lufs, true_peak, recommended_gain_db, target_lufs, bins)) => (
                    bins,
                    Some((integrated_lufs, true_peak, recommended_gain_db, target_lufs)),
                    true,
                ),
                None => (derive_waveform_bins(bytes, 500), None, false),
            };
        let bins_len = wf_bins.len();
        let waveform = WaveformEntry {
            bins: wf_bins,
            bin_count: 500,
            is_partial: false,
            known_until_sec: 0.0,
            duration_sec: 0.0,
            updated_at: now_unix_ts(),
        };
        cache.upsert_waveform(&key, &waveform)?;

        if let Some((integrated_lufs, true_peak, recommended_gain_db, target_lufs)) = loudness_opt {
            let loudness = LoudnessEntry {
                integrated_lufs,
                true_peak,
                recommended_gain_db,
                target_lufs,
                updated_at: now_unix_ts(),
            };
            cache.upsert_loudness(&key, &loudness)?;
        }

        cache.touch_track_status(&key, "ready")?;
        let _ = cache.checkpoint_wal("analysis.seed");
        Ok((used_pcm_decode, bins_len))
    })();

    let elapsed_ms = started.elapsed().as_millis();
    match &build {
        Ok((used_pcm_decode, bins_len)) => {
            crate::app_deprintln!(
                "[analysis] full-track analysis done track_id={} elapsed_ms={} decode_path={} bins_len={} ebu_loudness_cached={}",
                track_id,
                elapsed_ms,
                if *used_pcm_decode {
                    "pcm_ebur128"
                } else {
                    "byte_envelope_no_ebu"
                },
                bins_len,
                *used_pcm_decode
            );
        }
        Err(e) => {
            let _ = cache.touch_track_status(&key, "failed");
            crate::app_deprintln!(
                "[analysis] full-track analysis failed track_id={} elapsed_ms={} err={}",
                track_id,
                elapsed_ms,
                e
            );
        }
    }

    match build {
        Ok(_) => Ok((SeedFromBytesOutcome::Upserted, key.md5_16kb.clone())),
        Err(e) => Err(e),
    }
}

pub fn md5_first_16kb(bytes: &[u8]) -> String {
    let n = bytes.len().min(16 * 1024);
    format!("{:x}", md5::compute(&bytes[..n]))
}
