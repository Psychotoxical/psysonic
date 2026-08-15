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

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

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

/// AIFF permits chunks in any order. Symphonia must keep seekability during
/// probing so it can scan past `SSND`, find `COMM`, then return to the audio.
pub(crate) fn container_hint_is_aiff(hint: Option<&str>) -> bool {
    let Some(h) = hint else { return false };
    matches!(h.to_ascii_lowercase().as_str(), "aiff" | "aif" | "aifc")
}
pub(crate) use local_file::LocalFileSource;
pub(crate) use radio::{RadioLiveState, RadioSharedFlags, radio_download_task};
pub(crate) use ranged_http::{OnDemand, RangedHttpSource, ranged_download_task};
pub(crate) use reader::AudioStreamReader;
pub(crate) use track_stream::track_download_task;

pub(crate) type AnalysisSeedHold = Arc<Mutex<Option<(String, u64)>>>;
static ANALYSIS_SEED_HOLD_TOKEN: AtomicU64 = AtomicU64::new(0);

/// Shared ownership state between an HTTP downloader and a full-buffer fallback.
pub(crate) struct StreamDownloadControl {
    pub(crate) done: Arc<AtomicBool>,
    analysis_selection: AtomicU8,
    analysis_selection_notify: Notify,
    fallback_succeeded: AtomicBool,
    ended_without_reusable_bytes: AtomicBool,
}

impl StreamDownloadControl {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            done: Arc::new(AtomicBool::new(false)),
            analysis_selection: AtomicU8::new(0),
            analysis_selection_notify: Notify::new(),
            fallback_succeeded: AtomicBool::new(false),
            ended_without_reusable_bytes: AtomicBool::new(false),
        })
    }

    pub(crate) fn select_downloader_analysis(&self) {
        if self
            .analysis_selection
            .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.analysis_selection_notify.notify_one();
        }
    }

    pub(crate) fn select_fallback_analysis(&self) -> bool {
        let selected = self
            .analysis_selection
            .compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        if selected {
            self.analysis_selection_notify.notify_one();
        }
        selected
    }

    pub(crate) async fn downloader_analysis_selected(&self) -> bool {
        loop {
            let notified = self.analysis_selection_notify.notified();
            match self.analysis_selection.load(Ordering::SeqCst) {
                1 => return true,
                2 => return false,
                _ => notified.await,
            }
        }
    }

    pub(crate) fn mark_fallback_succeeded(&self) {
        self.fallback_succeeded.store(true, Ordering::SeqCst);
    }

    pub(crate) fn fallback_succeeded(&self) -> bool {
        self.fallback_succeeded.load(Ordering::SeqCst)
    }

    pub(crate) fn mark_ended_without_reusable_bytes(&self) {
        self.ended_without_reusable_bytes
            .store(true, Ordering::SeqCst);
        self.done.store(true, Ordering::SeqCst);
    }

    pub(crate) fn ended_without_reusable_bytes(&self) -> bool {
        self.ended_without_reusable_bytes.load(Ordering::SeqCst)
    }
}

/// Keeps HTTP backfill from downloading the same original while a playback
/// stream is already collecting bytes that will seed analysis on completion.
pub(crate) struct AnalysisSeedHoldGuard {
    slot: AnalysisSeedHold,
    track_id: String,
    token: u64,
}

impl AnalysisSeedHoldGuard {
    pub(crate) fn arm(
        slot: Option<&AnalysisSeedHold>,
        track_id: Option<&str>,
        generation: u64,
        generation_arc: &AtomicU64,
    ) -> Option<Self> {
        let slot = slot?;
        let track_id = track_id?.trim();
        if track_id.is_empty() {
            return None;
        }
        if let Ok(mut guard) = slot.lock() {
            if generation_arc.load(Ordering::SeqCst) != generation {
                return None;
            }
            let token = ANALYSIS_SEED_HOLD_TOKEN.fetch_add(1, Ordering::Relaxed);
            *guard = Some((track_id.to_string(), token));
            Some(Self {
                slot: Arc::clone(slot),
                track_id: track_id.to_string(),
                token,
            })
        } else {
            None
        }
    }
}

impl Drop for AnalysisSeedHoldGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.slot.lock() {
            if matches!(&*guard, Some((track_id, token)) if track_id == &self.track_id && *token == self.token) {
                *guard = None;
            }
        }
    }
}

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

/// The playback generation a source was built for.
///
/// Every on-demand reader answers a read that has been superseded — the user
/// skipped, hovered away, started something else — with `Ok(0)`
/// (`ranged_http.rs`, and `track_download_task` by setting `done`). That reaches
/// the decoder as end-of-media and is indistinguishable there from a file that
/// is genuinely truncated. Handing the same `(gen, gen_arc)` pair the reader
/// holds down to the decoder is what lets it tell the two apart: one is an
/// abandoned build to drop quietly, the other is a broken stream the player
/// needs to hear about.
#[derive(Clone)]
pub(crate) struct GenerationGuard {
    pub(crate) gen: u64,
    pub(crate) gen_arc: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl GenerationGuard {
    pub(crate) fn is_superseded(&self) -> bool {
        self.gen_arc.load(std::sync::atomic::Ordering::SeqCst) != self.gen
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

#[cfg(test)]
mod container_hint_tests {
    use super::*;

    #[test]
    fn recognises_all_aiff_extensions() {
        assert!(container_hint_is_aiff(Some("AIFF")));
        assert!(container_hint_is_aiff(Some("aif")));
        assert!(container_hint_is_aiff(Some("aifc")));
        assert!(!container_hint_is_aiff(Some("wav")));
    }
}

#[cfg(test)]
mod stream_download_control_tests {
    use super::*;

    #[tokio::test]
    async fn fallback_selection_wakes_downloader_and_keeps_one_owner() {
        let control = StreamDownloadControl::new();
        assert!(control.select_fallback_analysis());
        assert!(!control.downloader_analysis_selected().await);
        control.select_downloader_analysis();
        assert!(!control.select_fallback_analysis());
        assert!(!control.fallback_succeeded());
        assert!(!control.ended_without_reusable_bytes());
        control.mark_fallback_succeeded();
        assert!(control.fallback_succeeded());
        control.mark_ended_without_reusable_bytes();
        assert!(control.ended_without_reusable_bytes());
        assert!(control.done.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn downloader_selection_wakes_waiter_and_prevents_late_fallback() {
        let control = StreamDownloadControl::new();
        let waiter = {
            let control = control.clone();
            tokio::spawn(async move { control.downloader_analysis_selected().await })
        };
        tokio::task::yield_now().await;
        control.select_downloader_analysis();
        assert!(waiter.await.unwrap());
        assert!(!control.select_fallback_analysis());
    }
}

#[cfg(test)]
mod analysis_seed_hold_tests {
    use super::*;

    #[test]
    fn guard_sets_and_clears_matching_token() {
        let slot: AnalysisSeedHold = Arc::new(Mutex::new(None));
        let generation = Arc::new(AtomicU64::new(7));
        let guard = AnalysisSeedHoldGuard::arm(Some(&slot), Some("track-1"), 7, &generation)
            .expect("valid track should arm hold");
        assert!(matches!(
            &*slot.lock().unwrap(),
            Some((track_id, _)) if track_id == "track-1"
        ));

        drop(guard);
        assert_eq!(*slot.lock().unwrap(), None);
    }

    #[test]
    fn stale_guard_does_not_clear_rearmed_hold_for_the_same_track() {
        let slot: AnalysisSeedHold = Arc::new(Mutex::new(None));
        let generation = Arc::new(AtomicU64::new(7));
        let stale = AnalysisSeedHoldGuard::arm(Some(&slot), Some("track-1"), 7, &generation)
            .expect("valid track should arm hold");
        let stale_token = slot.lock().unwrap().as_ref().unwrap().1;
        let current = AnalysisSeedHoldGuard::arm(Some(&slot), Some("track-1"), 7, &generation)
            .expect("analysis handoff should replace hold");
        let current_token = slot.lock().unwrap().as_ref().unwrap().1;
        assert_ne!(stale_token, current_token);

        drop(stale);
        assert_eq!(
            *slot.lock().unwrap(),
            Some(("track-1".to_string(), current_token))
        );
        drop(current);
        assert_eq!(*slot.lock().unwrap(), None);
    }

    #[test]
    fn stale_generation_cannot_overwrite_a_newer_playback_hold() {
        let slot: AnalysisSeedHold = Arc::new(Mutex::new(None));
        let generation = Arc::new(AtomicU64::new(8));
        let current = AnalysisSeedHoldGuard::arm(Some(&slot), Some("track-2"), 8, &generation)
            .expect("current playback should arm hold");
        let current_token = slot.lock().unwrap().as_ref().unwrap().1;

        assert!(AnalysisSeedHoldGuard::arm(Some(&slot), Some("track-1"), 7, &generation).is_none());
        assert_eq!(
            *slot.lock().unwrap(),
            Some(("track-2".to_string(), current_token))
        );
        drop(current);
    }
}
