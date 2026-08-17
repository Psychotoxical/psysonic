use std::sync::{Arc, Mutex, OnceLock};

use psysonic_core::server_http::ServerHttpRegistry;
use psysonic_core::user_agent::subsonic_wire_user_agent;
use tauri::Manager;

use crate::analysis_cache;

use super::super::cpu_seed::analysis_revision_in_cpu_pipeline;
use super::super::trusted_revision::{
    canonical_activation_key, next_trusted_generation, register_trusted_revision_generation,
    reserve_trusted_analysis_fetch, TrustedActivationState, TrustedAnalysisFetchPermit,
    TRUSTED_ACTIVATIONS,
};
use super::super::types::{TrustedAnalysisRevision, ANALYSIS_PIPELINE_PARALLELISM_MAX};

fn analysis_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(subsonic_wire_user_agent())
            .timeout(std::time::Duration::from_secs(120))
            .pool_max_idle_per_host(ANALYSIS_PIPELINE_PARALLELISM_MAX)
            .build()
            .expect("analysis HTTP client")
    })
}

pub(in crate::analysis_runtime) const ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES: usize =
    64 * 1024 * 1024;
pub(in crate::analysis_runtime) const ANALYSIS_SOURCE_UNAVAILABLE_REVISION: &str =
    "source-unavailable";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::analysis_runtime) enum AnalysisBackfillJobError {
    Terminal(String),
    Retryable(String),
    Superseded,
}

impl std::fmt::Display for AnalysisBackfillJobError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Terminal(message) | Self::Retryable(message) => formatter.write_str(message),
            Self::Superseded => formatter.write_str("superseded by newer analysis work"),
        }
    }
}

impl AnalysisBackfillJobError {
    pub(in crate::analysis_runtime) fn is_retryable(&self) -> bool {
        matches!(self, Self::Retryable(_))
    }

    pub(in crate::analysis_runtime) fn is_superseded(&self) -> bool {
        matches!(self, Self::Superseded)
    }
}

pub(in crate::analysis_runtime) fn source_unavailable_failure<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    server_id: &str,
    track_id: &str,
    error: &crate::raw_probe::SubsonicStreamError,
    generation: u64,
) -> AnalysisBackfillJobError {
    crate::app_deprintln!(
        "[analysis][backfill] source unavailable track_id={track_id} code={} reason={}",
        error.code,
        error.diagnostic_reason(),
    );
    let activation_key = canonical_activation_key(server_id, track_id);
    let mut activation_state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let effective_generation = activation_state.register(
        activation_key.clone(),
        ANALYSIS_SOURCE_UNAVAILABLE_REVISION,
        generation,
    );
    let is_current = activation_state
        .current_by_track
        .get(&activation_key)
        .is_some_and(|current| {
            current.revision == ANALYSIS_SOURCE_UNAVAILABLE_REVISION
                && current.generation == effective_generation
        });
    if !is_current {
        return AnalysisBackfillJobError::Superseded;
    }
    let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() else {
        return AnalysisBackfillJobError::Retryable(format!(
            "analysis source unavailable (Subsonic code {}), but analysis cache is unavailable",
            error.code
        ));
    };
    let key = analysis_cache::TrackKey {
        server_id: server_id.to_string(),
        track_id: track_id.to_string(),
        md5_16kb: ANALYSIS_SOURCE_UNAVAILABLE_REVISION.to_string(),
    };
    match cache.touch_track_status(&key, "failed") {
        Ok(()) => AnalysisBackfillJobError::Terminal(format!(
            "analysis source unavailable (Subsonic code {}, reason={})",
            error.code,
            error.diagnostic_reason(),
        )),
        Err(cache_error) => AnalysisBackfillJobError::Retryable(format!(
            "analysis source unavailable (Subsonic code {}), but failed to record it: {cache_error}",
            error.code
        )),
    }
}

async fn probe_backfill_trusted_identity<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    registry: Option<&ServerHttpRegistry>,
    server_id: &str,
    track_id: &str,
    url: &str,
    generation: u64,
) -> Result<Option<String>, AnalysisBackfillJobError> {
    match crate::raw_probe::probe_trusted_original_md5(
        analysis_http_client(),
        registry,
        Some(server_id),
        url,
    )
    .await
    {
        crate::raw_probe::TrustedOriginalProbeResult::Trusted(hash) => Ok(Some(hash)),
        crate::raw_probe::TrustedOriginalProbeResult::SubsonicError(error)
            if error.is_source_unavailable() =>
        {
            Err(source_unavailable_failure(
                app, server_id, track_id, &error, generation,
            ))
        }
        crate::raw_probe::TrustedOriginalProbeResult::SubsonicError(error) => {
            crate::app_deprintln!(
                "[analysis][backfill] raw identity probe rejected track_id={track_id} code={} reason={}",
                error.code,
                error.diagnostic_reason(),
            );
            Ok(None)
        }
        crate::raw_probe::TrustedOriginalProbeResult::Unavailable => Ok(None),
    }
}

pub(in crate::analysis_runtime) fn analysis_stream_format_hint(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()?
        .query_pairs()
        .find_map(|(key, value)| (key == "format" && value != "raw").then(|| value.into_owned()))
}

#[derive(Debug)]
pub(in crate::analysis_runtime) struct AnalysisBackfillDownload {
    pub(in crate::analysis_runtime) bytes: Vec<u8>,
    pub(in crate::analysis_runtime) fetch_ms: u64,
    pub(in crate::analysis_runtime) format_hint: Option<String>,
    pub(in crate::analysis_runtime) trusted_revision: Option<TrustedAnalysisRevision>,
    pub(in crate::analysis_runtime) trusted_fetch_permit: Option<TrustedAnalysisFetchPermit>,
}

fn record_oversized_trusted_analysis<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    server_id: &str,
    track_id: &str,
    trusted_md5_16kb: &str,
    generation: u64,
) -> Result<(), AnalysisBackfillJobError> {
    let activation_key = canonical_activation_key(server_id, track_id);
    let state = TRUSTED_ACTIVATIONS
        .get_or_init(|| Mutex::new(TrustedActivationState::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !state
        .current_by_track
        .get(&activation_key)
        .is_some_and(|current| {
            current.revision == trusted_md5_16kb && current.generation == generation
        })
    {
        return Ok(());
    }
    let cache = app
        .try_state::<analysis_cache::AnalysisCache>()
        .ok_or_else(|| {
            AnalysisBackfillJobError::Retryable(
                "analysis cache unavailable while recording oversized analysis input".to_string(),
            )
        })?;
    let key = analysis_cache::TrackKey {
        server_id: server_id.to_string(),
        track_id: track_id.to_string(),
        md5_16kb: trusted_md5_16kb.to_string(),
    };
    cache.touch_track_status(&key, "failed").map_err(|error| {
        AnalysisBackfillJobError::Retryable(format!(
            "failed to record oversized analysis input: {error}"
        ))
    })
}

pub(in crate::analysis_runtime) async fn analysis_backfill_download<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    server_id: &str,
    track_id: &str,
    url: &str,
    max_bytes: usize,
) -> Result<AnalysisBackfillDownload, AnalysisBackfillJobError> {
    let operation_generation = next_trusted_generation();
    let mut effective_generation = operation_generation;
    let registry = app
        .try_state::<Arc<ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));
    let raw_supported =
        crate::raw_probe::raw_stream_supported(registry.as_deref(), Some(server_id), url);
    let mut trusted = if raw_supported {
        match probe_backfill_trusted_identity(
            app,
            registry.as_deref(),
            server_id,
            track_id,
            url,
            operation_generation,
        )
        .await
        {
            Ok(Some(hash)) => {
                effective_generation = register_trusted_revision_generation(
                    server_id,
                    track_id,
                    &hash,
                    operation_generation,
                );
                Some(hash)
            }
            Ok(None) => {
                crate::app_deprintln!(
                    "[analysis] raw identity probe unavailable track_id={track_id}; falling back to original download"
                );
                None
            }
            Err(error) => return Err(error),
        }
    } else {
        None
    };

    let fetch_started = std::time::Instant::now();
    if let Some(initial_trusted_md5_16kb) = trusted.clone() {
        let transcode_result = crate::raw_probe::fetch_bounded_stream_bytes(
            analysis_http_client(),
            registry.as_deref(),
            Some(server_id),
            url,
            max_bytes,
        )
        .await;
        let revalidated = probe_backfill_trusted_identity(
            app,
            registry.as_deref(),
            server_id,
            track_id,
            url,
            operation_generation,
        )
        .await;
        match revalidated {
            Ok(Some(hash)) => {
                effective_generation = register_trusted_revision_generation(
                    server_id,
                    track_id,
                    &hash,
                    operation_generation,
                );
                let unchanged = hash == initial_trusted_md5_16kb;
                trusted = Some(hash.clone());
                if unchanged {
                    match transcode_result {
                        Ok(bytes) => {
                            return Ok(AnalysisBackfillDownload {
                                bytes,
                                fetch_ms: fetch_started.elapsed().as_millis() as u64,
                                format_hint: analysis_stream_format_hint(url),
                                trusted_revision: Some(TrustedAnalysisRevision {
                                    md5_16kb: hash,
                                    generation: effective_generation,
                                    analysis_bytes_transcoded: true,
                                    content_hash_server_id: None,
                                }),
                                trusted_fetch_permit: None,
                            });
                        }
                        Err(crate::raw_probe::BoundedStreamFetchError::TooLarge { .. }) => {
                            record_oversized_trusted_analysis(
                                app,
                                server_id,
                                track_id,
                                &hash,
                                effective_generation,
                            )?;
                            return Err(AnalysisBackfillJobError::Terminal(format!(
                                "analysis transcode exceeds cap of {max_bytes} bytes"
                            )));
                        }
                        Err(error) => {
                            crate::app_deprintln!(
                                "[analysis] transcode unavailable track_id={track_id}: {error}; falling back to original download"
                            );
                        }
                    }
                } else {
                    crate::app_deprintln!(
                        "[analysis] original changed during transcode fetch track_id={track_id}; falling back to original download"
                    );
                }
            }
            Ok(None) => {
                trusted = None;
                crate::app_deprintln!(
                    "[analysis] raw identity revalidation unavailable track_id={track_id}; falling back to original download"
                );
            }
            Err(error) => return Err(error),
        }
    }

    let download_url = crate::raw_probe::build_original_download_url(url).ok_or_else(|| {
        AnalysisBackfillJobError::Retryable(
            "original download endpoint unavailable for analysis fallback".to_string(),
        )
    })?;
    let trusted_fetch_permit = if let Some(revision) = trusted.as_deref() {
        let permit = reserve_trusted_analysis_fetch(server_id, track_id, revision).await;
        if permit.waited()
            && (analysis_revision_in_cpu_pipeline(server_id, track_id, revision)
                || !crate::track_analysis_plan::plan_track_analysis(
                    app, server_id, track_id, revision,
                )
                .any())
        {
            return Err(AnalysisBackfillJobError::Superseded);
        }
        Some(permit)
    } else {
        None
    };
    let bytes = match crate::raw_probe::fetch_bounded_stream_bytes(
        analysis_http_client(),
        registry.as_deref(),
        Some(server_id),
        &download_url,
        max_bytes,
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(crate::raw_probe::BoundedStreamFetchError::TooLarge { md5_16kb }) => {
            if trusted
                .as_deref()
                .is_some_and(|trusted_md5_16kb| trusted_md5_16kb != md5_16kb)
            {
                return Err(AnalysisBackfillJobError::Retryable(
                    "oversized original download does not match raw-probed identity".to_string(),
                ));
            }
            let original_md5_16kb = trusted.as_deref().unwrap_or(&md5_16kb);
            if trusted.is_none() {
                effective_generation = register_trusted_revision_generation(
                    server_id,
                    track_id,
                    original_md5_16kb,
                    operation_generation,
                );
            }
            record_oversized_trusted_analysis(
                app,
                server_id,
                track_id,
                original_md5_16kb,
                effective_generation,
            )?;
            return Err(AnalysisBackfillJobError::Terminal(format!(
                "original download exceeds analysis cap of {max_bytes} bytes"
            )));
        }
        Err(crate::raw_probe::BoundedStreamFetchError::SubsonicApi(error))
            if error.is_source_unavailable() =>
        {
            return Err(source_unavailable_failure(
                app,
                server_id,
                track_id,
                &error,
                operation_generation,
            ));
        }
        Err(error) => {
            let message = format!("original download unavailable: {error}");
            return Err(if error.is_permanent_http() {
                AnalysisBackfillJobError::Terminal(message)
            } else {
                AnalysisBackfillJobError::Retryable(message)
            });
        }
    };
    if let Some(trusted_md5_16kb) = trusted.as_deref() {
        if !crate::raw_probe::bytes_match_trusted(&bytes, trusted_md5_16kb) {
            return Err(AnalysisBackfillJobError::Retryable(
                "original download does not match raw-probed identity".to_string(),
            ));
        }
    }
    let md5_16kb = trusted.unwrap_or_else(|| analysis_cache::md5_first_16kb(&bytes));
    effective_generation =
        register_trusted_revision_generation(server_id, track_id, &md5_16kb, operation_generation);
    let trusted_revision = Some(TrustedAnalysisRevision {
        generation: effective_generation,
        md5_16kb,
        analysis_bytes_transcoded: false,
        content_hash_server_id: None,
    });
    Ok(AnalysisBackfillDownload {
        bytes,
        fetch_ms: fetch_started.elapsed().as_millis() as u64,
        format_hint: None,
        trusted_revision,
        trusted_fetch_permit,
    })
}
