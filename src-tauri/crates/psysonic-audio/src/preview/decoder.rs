use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::AppHandle;

use crate::decode::SizedDecoder;
use crate::engine::{audio_http_client, AudioEngine, PlaybackHttpHeaders};
use crate::helpers::{
    content_type_to_hint, format_hint_from_content_disposition, normalize_stream_suffix_for_hint,
    resolve_playback_format_hint, sniff_stream_format_extension, STREAM_FORMAT_SNIFF_PROBE_BYTES,
};
use crate::play_input::url_format_hint;
use crate::stream::{
    mp4_needs_tail_prefetch, ranged_download_task, wait_for_ranged_mp4_probe_ready,
    RangedHttpSource, RangedMp4ProbeGate,
};

/// `format=` query param on Subsonic stream URLs (transcode targets).
pub(crate) fn preview_format_hint_from_url(url: &str) -> Option<String> {
    url.split('?').nth(1)?.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k.eq_ignore_ascii_case("format") {
            Some(v.to_string())
        } else {
            None
        }
    })
}

/// Symphonia container hint for preview downloads — mirrors main playback:
/// Content-Type / Content-Disposition, URL tail, Subsonic suffix, magic-byte sniff.
pub(crate) fn resolve_preview_format_hint(
    url: &str,
    content_type: Option<&str>,
    content_disposition: Option<&str>,
    stream_suffix: Option<&str>,
    bytes: &[u8],
) -> Option<String> {
    let media_hint = content_type
        .and_then(content_type_to_hint)
        .or_else(|| content_disposition.and_then(format_hint_from_content_disposition));
    let url_hint = preview_format_hint_from_url(url).or_else(|| url_format_hint(url));
    resolve_playback_format_hint(
        url_hint.as_deref(),
        stream_suffix,
        media_hint.as_deref(),
        Some(bytes),
    )
}

fn preview_http_client(state: &AudioEngine) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .use_rustls_tls()
        .user_agent(psysonic_core::user_agent::subsonic_wire_user_agent())
        .build()
        .unwrap_or_else(|_| audio_http_client(state))
}

/// Open a preview decoder — ranged HTTP when the server supports it (starts
/// after ~384 KiB buffered), otherwise falls back to a full in-memory download.
pub(super) async fn open_preview_decoder(
    url: &str,
    format_suffix: Option<&str>,
    gen: u64,
    state: &AudioEngine,
    app: &AppHandle,
) -> Result<Option<SizedDecoder>, String> {
    let http_headers = PlaybackHttpHeaders::from_app(app, None);
    let preview_http = preview_http_client(state);
    let response = http_headers
        .apply(url, preview_http.get(url))
        .send()
        .await
        .map_err(|e| format!("preview: connection failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("preview: HTTP {e}"))?;

    let mut stream_hint = content_type_to_hint(
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    )
    .or_else(|| {
        response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(format_hint_from_content_disposition)
    })
    .or_else(|| normalize_stream_suffix_for_hint(format_suffix))
    .or_else(|| preview_format_hint_from_url(url))
    .or_else(|| url_format_hint(url));

    let supports_range = response
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("bytes"));
    let total_size = response.content_length();

    if stream_hint.is_none() && supports_range {
        if let Some(total_u64) = total_size.filter(|&t| t > 0) {
            let last = total_u64
                .saturating_sub(1)
                .min((STREAM_FORMAT_SNIFF_PROBE_BYTES - 1) as u64);
            if let Ok(pr) = http_headers
                .apply(url, preview_http.get(url))
                .header(reqwest::header::RANGE, format!("bytes=0-{last}"))
                .send()
                .await
            {
                let stat = pr.status();
                let ok =
                    stat == reqwest::StatusCode::PARTIAL_CONTENT || stat == reqwest::StatusCode::OK;
                if ok {
                    if let Ok(bytes) = pr.bytes().await {
                        if !bytes.is_empty() {
                            stream_hint = sniff_stream_format_extension(&bytes).or(stream_hint);
                        }
                    }
                }
            }
        }
    }

    if let (true, Some(total), true) = (supports_range, total_size, stream_hint.is_some()) {
        if state.preview_gen.load(Ordering::SeqCst) != gen {
            return Ok(None);
        }
        let total_usize = total as usize;
        crate::app_deprintln!(
            "[preview] ranged open — total={} KB, hint={:?}",
            total_usize / 1024,
            stream_hint
        );
        let buf = Arc::new(Mutex::new(vec![0u8; total_usize]));
        let downloaded_to = Arc::new(AtomicUsize::new(0));
        let download_control = crate::stream::StreamDownloadControl::new();
        let done = download_control.done.clone();
        let playback_armed = Arc::new(AtomicBool::new(false));
        let tail_ready = Arc::new(AtomicBool::new(false));
        let tail_filled_from = Arc::new(AtomicU64::new(0));
        let tail_prefetch = mp4_needs_tail_prefetch(&[], stream_hint.as_deref());
        let mp4_probe_gate = tail_prefetch.then(|| RangedMp4ProbeGate {
            tail_ready: tail_ready.clone(),
            buf: buf.clone(),
            downloaded_to: downloaded_to.clone(),
            gen_arc: state.preview_gen.clone(),
            gen,
            format_hint: stream_hint.clone(),
        });
        tokio::spawn(ranged_download_task(
            gen,
            state.preview_gen.clone(),
            preview_http,
            app.clone(),
            0.0,
            url.to_string(),
            response,
            buf.clone(),
            downloaded_to.clone(),
            download_control,
            state.stream_completed_cache.clone(),
            state.stream_completed_spill.clone(),
            state.normalization_engine.clone(),
            state.normalization_target_lufs.clone(),
            state.loudness_pre_analysis_attenuation_db.clone(),
            None,
            None,
            false,
            http_headers.clone(),
            None,
            playback_armed,
            stream_hint.clone(),
            tail_ready.clone(),
            tail_filled_from.clone(),
        ));
        if let Some(ref gate) = mp4_probe_gate {
            wait_for_ranged_mp4_probe_ready(gate).await?;
            if state.preview_gen.load(Ordering::SeqCst) != gen {
                return Ok(None);
            }
        }
        let reader = RangedHttpSource {
            buf,
            downloaded_to,
            tail_ready,
            tail_filled_from,
            total_size: total,
            pos: 0,
            done,
            gen_arc: state.preview_gen.clone(),
            gen,
            // Preview plays a fixed short segment; no user seeking → no need for
            // the on-demand random-access fetcher.
            on_demand: None,
        };
        let hint = stream_hint.clone();
        // Preview runs on its own generation: hovering away bumps `preview_gen`
        // and the reader answers `Ok(0)`, which must stay a quiet abandon.
        let preview_guard = crate::stream::GenerationGuard {
            gen,
            gen_arc: state.preview_gen.clone(),
        };
        let decoder = tokio::task::spawn_blocking(move || {
            SizedDecoder::new_streaming(
                Box::new(reader),
                hint.as_deref(),
                "preview-stream",
                false,
                Some(preview_guard),
            )
        })
        .await
        .map_err(|e| format!("preview: decoder thread: {e}"))??;
        return Ok(Some(decoder));
    }

    crate::app_deprintln!(
        "[preview] buffered download — accept-ranges={}, content-length={:?}, hint={:?}",
        supports_range,
        total_size,
        stream_hint
    );
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let content_disposition = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("preview: read body: {e}"))?
        .to_vec();
    if state.preview_gen.load(Ordering::SeqCst) != gen {
        return Ok(None);
    }
    let hint = resolve_preview_format_hint(
        url,
        content_type.as_deref(),
        content_disposition.as_deref(),
        format_suffix,
        &bytes,
    );
    let bytes_for_blocking = bytes;
    let hint_for_blocking = hint.clone();
    let decoder = tokio::task::spawn_blocking(move || {
        SizedDecoder::new(bytes_for_blocking, hint_for_blocking.as_deref(), false)
    })
    .await
    .map_err(|e| format!("preview: decoder thread: {e}"))??;
    Ok(Some(decoder))
}
