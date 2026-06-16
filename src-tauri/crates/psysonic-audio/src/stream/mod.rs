//! HTTP-backed and file-backed `MediaSource` implementations plus their
//! background download tasks.
//!
//! Submodule layout:
//! - `icy`          — Shoutcast/Icecast inline-metadata state machine
//! - `reader`       — `AudioStreamReader` (ringbuf → `std::io::Read` shim)
//! - `local_file`   — `LocalFileSource` (file-backed, seekable)
//! - `ranged_http`  — `RangedHttpSource` (seekable HTTP) + `ranged_download_task`
//! - `radio`        — radio session state + `radio_download_task`
//! - `track_stream` — `track_download_task` (one-shot non-ranged HTTP)

mod icy;
mod local_file;
mod mp4;
mod radio;
mod ranged_http;
mod reader;
mod track_stream;

pub(crate) use mp4::{
    container_hint_is_mp4, isobmff_buffer_looks_complete, log_isobmff_buffer_diagnostic,
    mp4_needs_tail_prefetch, mp4_suspect_zero_holes,
};

/// True when the container hint denotes an Ogg-encapsulated stream (Vorbis,
/// Opus, Speex, FLAC-in-Ogg).
///
/// symphonia 0.6's Ogg demuxer records the physical stream's byte range at
/// construction time, but only when the source reports `is_seekable()` *during
/// the probe*. If seekability is hidden then (see `ProbeSeekGate`),
/// `phys_byte_range_end` stays `None` and the first real seek panics with
/// `Option::unwrap()` on `None` (`demuxer.rs:180`). Sources that can cheaply
/// seek to EOF must therefore stay seekable through the probe for Ogg.
pub(crate) fn container_hint_is_ogg(hint: Option<&str>) -> bool {
    let Some(h) = hint else { return false };
    matches!(
        h.to_ascii_lowercase().as_str(),
        "ogg" | "oga" | "ogx" | "opus" | "spx"
    )
}
pub(crate) use local_file::LocalFileSource;
pub(crate) use radio::{RadioLiveState, RadioSharedFlags, radio_download_task};
pub(crate) use ranged_http::{RangedHttpSource, ranged_download_task};
pub(crate) use reader::AudioStreamReader;
pub(crate) use track_stream::track_download_task;

// ── Shared tuning constants ──────────────────────────────────────────────────

/// 256 KB on the heap — ≈16 s at 128 kbps, ≈6 s at 320 kbps.
/// Small enough that stale audio drains within a few seconds on reconnect;
/// large enough to absorb brief network hiccups without stuttering.
pub(crate) const RADIO_BUF_CAPACITY: usize = 256 * 1024;
/// Minimum ring buffer for on-demand track streaming starts.
pub(crate) const TRACK_STREAM_MIN_BUF_CAPACITY: usize = 1024 * 1024;
/// Cap ring buffer growth when content-length is known.
pub(crate) const TRACK_STREAM_MAX_BUF_CAPACITY: usize = 32 * 1024 * 1024;
/// Max bytes kept in RAM (`stream_completed_cache`) for fast replay; larger completed
/// ranged streams are spilled under app-data `stream-spill/` for hot-cache promote.
pub(crate) const TRACK_STREAM_PROMOTE_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Hot/offline `psysonic-local://` files are read from disk for waveform/LUFS seeding — not the
/// same heap pressure as retaining a full HTTP capture. FLAC/DSD tracks often exceed 64 MiB;
/// using the stream-promote cap here skipped analysis entirely (empty seekbar).
pub(crate) const LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES: usize = 512 * 1024 * 1024;
/// Consecutive body-stream failures tolerated for track streaming before abort.
pub(crate) const TRACK_STREAM_MAX_RECONNECTS: u32 = 3;
/// Seconds at stall threshold while paused before hard-disconnect.
pub(crate) const RADIO_HARD_PAUSE_SECS: u64 = 5;
/// Live radio: if no audio bytes arrive for this long → EOF.
pub(crate) const RADIO_READ_TIMEOUT_SECS: u64 = 15;
/// On-demand tracks (`track-stream`, `RangedHttpSource`): allow long gaps while a
/// large file is still downloading (format probe may read/seek ahead of the filler).
pub(crate) const TRACK_READ_TIMEOUT_SECS: u64 = 120;
/// HTTP track paths (`AudioStreamReader`, `RangedHttpSource`): minimum linear
/// download before audible playback and seekbar progress (demux probe may read
/// far ahead of the play cursor).
pub(crate) const TRACK_STREAM_PLAY_START_BYTES: u64 = 384 * 1024;

/// Arm deferred playback / progress once enough of the file is buffered.
pub(crate) fn maybe_arm_stream_playback(downloaded: u64, playback_armed: &std::sync::atomic::AtomicBool) {
    use std::sync::atomic::Ordering;
    if !playback_armed.load(Ordering::Relaxed) && downloaded >= TRACK_STREAM_PLAY_START_BYTES {
        playback_armed.store(true, Ordering::SeqCst);
        crate::app_deprintln!(
            "[stream] playback armed after {} KiB buffered",
            downloaded / 1024
        );
    }
}

/// Held until `RangedHttpSource` has moov metadata for Symphonia probe (tail prefetch
/// or fast-start moov in the linear prefix).
pub(crate) struct RangedMp4ProbeGate {
    pub(crate) tail_ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub(crate) buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    pub(crate) downloaded_to: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub(crate) gen_arc: std::sync::Arc<std::sync::atomic::AtomicU64>,
    pub(crate) gen: u64,
    pub(crate) format_hint: Option<String>,
}

/// Block until moov is reachable: tail prefetch completed or moov already in the
/// downloaded prefix (fast-start). Avoids Symphonia probing moov-at-end M4A before
/// the tail range is filled (format probe failed: end of stream).
pub(crate) async fn wait_for_ranged_mp4_probe_ready(gate: &RangedMp4ProbeGate) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    const PREFIX_SCAN_MIN: usize = 64 * 1024;
    let deadline = Instant::now() + Duration::from_secs(TRACK_READ_TIMEOUT_SECS);

    loop {
        if gate.gen_arc.load(Ordering::SeqCst) != gate.gen {
            return Err("ranged-stream: superseded before moov metadata ready".into());
        }
        if gate.tail_ready.load(Ordering::Relaxed) {
            crate::app_deprintln!("[stream] ranged: moov metadata ready (tail prefetch)");
            return Ok(());
        }
        let dl = gate.downloaded_to.load(Ordering::Relaxed);
        if dl >= PREFIX_SCAN_MIN {
            let guard = gate.buf.lock().unwrap();
            let n = dl.min(guard.len());
            if !mp4::mp4_needs_tail_prefetch(&guard[..n], gate.format_hint.as_deref()) {
                crate::app_deprintln!(
                    "[stream] ranged: moov metadata ready (fast-start, {} KiB prefix)",
                    n / 1024
                );
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            return Err(
                "ranged-stream: timed out waiting for moov metadata (tail prefetch)".into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Sleep interval when ring buffer is empty (prevents CPU spin).
pub(crate) const RADIO_YIELD_MS: u64 = 2;
