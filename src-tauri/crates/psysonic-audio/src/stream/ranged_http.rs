//! `RangedHttpSource` — seekable HTTP-backed `MediaSource`, plus its
//! background `ranged_download_task` linear filler.
//!
//! Pre-allocates a `Vec<u8>` of total track size. The download task fills it
//! linearly from offset 0 via streaming HTTP. `Read` blocks (with timeout)
//! until requested bytes are downloaded; `Seek` only updates the cursor.
//!
//! Reports `is_seekable=true` so Symphonia performs time-based seeks via the
//! format reader. Backward seeks: instant (data in buffer). Forward seeks
//! beyond `downloaded_to`: `Read` blocks until the linear download catches up.
//!
//! Requires the server to respond with both `Content-Length` and
//! `Accept-Ranges: bytes` so reconnects can resume via HTTP `Range`.

use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use symphonia::core::io::MediaSource;
use tauri::{AppHandle, Emitter};

use super::super::state::PreloadedTrack;
use super::{
    RADIO_READ_TIMEOUT_SECS, RADIO_YIELD_MS, TRACK_STREAM_MAX_RECONNECTS,
    TRACK_STREAM_PROMOTE_MAX_BYTES,
};

/// Clears `AudioEngine::ranged_loudness_seed_hold` only if it still matches this play.
struct RangedLoudnessSeedHoldClear {
    slot: Arc<Mutex<Option<(String, u64)>>>,
    tid: String,
    gen: u64,
}

impl Drop for RangedLoudnessSeedHoldClear {
    fn drop(&mut self) {
        if let Ok(mut g) = self.slot.lock() {
            if matches!(&*g, Some((t, gen)) if t == &self.tid && *gen == self.gen) {
                *g = None;
            }
        }
    }
}

pub(crate) struct RangedHttpSource {
    /// Pre-allocated buffer of total size. Filled linearly from offset 0.
    pub(crate) buf: Arc<Mutex<Vec<u8>>>,
    /// Bytes contiguously downloaded from offset 0.
    pub(crate) downloaded_to: Arc<AtomicUsize>,
    pub(crate) total_size: u64,
    pub(crate) pos: u64,
    /// Set when the download task terminates (success or hard error).
    pub(crate) done: Arc<AtomicBool>,
    pub(crate) gen_arc: Arc<AtomicU64>,
    pub(crate) gen: u64,
}

impl Read for RangedHttpSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.gen_arc.load(Ordering::SeqCst) != self.gen {
            crate::app_deprintln!(
                "[stream] ranged-stream read EOF: superseded before first read (gen={} cur={} pos={}/{})",
                self.gen, self.gen_arc.load(Ordering::SeqCst), self.pos, self.total_size
            );
            return Ok(0);
        }
        if self.pos >= self.total_size {
            return Ok(0);
        }
        let max_read = ((self.total_size - self.pos) as usize).min(buf.len());
        if max_read == 0 {
            return Ok(0);
        }
        let target_end = self.pos + max_read as u64;

        let deadline = Instant::now() + Duration::from_secs(RADIO_READ_TIMEOUT_SECS);
        loop {
            if self.gen_arc.load(Ordering::SeqCst) != self.gen {
                crate::app_deprintln!(
                    "[stream] ranged-stream read EOF: superseded mid-wait (gen={} cur={} pos={}/{} dl={})",
                    self.gen, self.gen_arc.load(Ordering::SeqCst), self.pos, self.total_size,
                    self.downloaded_to.load(Ordering::SeqCst)
                );
                return Ok(0);
            }
            let dl = self.downloaded_to.load(Ordering::SeqCst) as u64;
            if dl >= target_end {
                break;
            }
            // Download finished but our cursor is past downloaded_to (e.g. seek
            // beyond a partial download that aborted). Return what we have.
            if self.done.load(Ordering::SeqCst) {
                if dl > self.pos {
                    let avail = (dl - self.pos) as usize;
                    let src = self.buf.lock().unwrap();
                    let start = self.pos as usize;
                    buf[..avail].copy_from_slice(&src[start..start + avail]);
                    drop(src);
                    self.pos += avail as u64;
                    return Ok(avail);
                }
                crate::app_deprintln!(
                    "[stream] ranged-stream read EOF: download done with no data ahead of cursor (pos={}/{} dl={})",
                    self.pos, self.total_size, dl
                );
                return Ok(0);
            }
            if Instant::now() >= deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "ranged-http: no data within timeout",
                ));
            }
            std::thread::sleep(Duration::from_millis(RADIO_YIELD_MS));
        }

        let src = self.buf.lock().unwrap();
        let start = self.pos as usize;
        let end = start + max_read;
        buf[..max_read].copy_from_slice(&src[start..end]);
        drop(src);
        self.pos += max_read as u64;
        Ok(max_read)
    }
}

impl Seek for RangedHttpSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let new_pos: i64 = match pos {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::Current(p) => self.pos as i64 + p,
            SeekFrom::End(p) => self.total_size as i64 + p,
        };
        if new_pos < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "ranged-http: seek before start",
            ));
        }
        self.pos = (new_pos as u64).min(self.total_size);
        Ok(self.pos)
    }
}

impl MediaSource for RangedHttpSource {
    fn is_seekable(&self) -> bool { true }
    fn byte_len(&self) -> Option<u64> { Some(self.total_size) }
}

/// Slot used to coordinate "ranged playback seeds on completion → defer HTTP
/// backfill for that track" between [`ranged_download_task`] and the analysis
/// runtime; the inner `(track_id, deadline_unix_ms)` describes the active hold.
pub(crate) type LoudnessSeedHold = Arc<Mutex<Option<(String, u64)>>>;

/// Linear downloader for `RangedHttpSource`: fills the pre-allocated buffer
/// from offset 0 to total_size. Reconnects via HTTP Range from the current
/// `downloaded` offset on transient errors. On completion (full track) the
/// data is promoted to `stream_completed_cache` for fast replay.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn ranged_download_task(
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    http_client: reqwest::Client,
    app: AppHandle,
    _duration_hint: f64,
    url: String,
    initial_response: reqwest::Response,
    buf: Arc<Mutex<Vec<u8>>>,
    downloaded_to: Arc<AtomicUsize>,
    done: Arc<AtomicBool>,
    promote_cache_slot: Arc<Mutex<Option<PreloadedTrack>>>,
    normalization_engine: Arc<AtomicU32>,
    normalization_target_lufs: Arc<AtomicU32>,
    loudness_pre_analysis_attenuation_db: Arc<AtomicU32>,
    cache_track_id: Option<String>,
    // When `Some`, ranged playback seeds on completion — defer HTTP backfill for that
    // track; `None` for large files where ranged skips seed (needs backfill).
    loudness_seed_hold: Option<LoudnessSeedHold>,
) {
    let _ranged_loudness_hold_clear = match (loudness_seed_hold.as_ref(), cache_track_id.as_ref()) {
        (Some(slot), Some(tid)) => {
            let t = tid.clone();
            {
                let mut g = slot.lock().unwrap();
                *g = Some((t.clone(), gen));
            }
            Some(RangedLoudnessSeedHoldClear {
                slot: Arc::clone(slot),
                tid: t,
                gen,
            })
        }
        _ => None,
    };
    let total_size = buf.lock().unwrap().len();
    let mut downloaded: usize = 0;
    let mut reconnects: u32 = 0;
    let mut next_response: Option<reqwest::Response> = Some(initial_response);
    let dl_started = Instant::now();
    let mut next_progress_mb: usize = 0;
    let mut last_partial_loudness_emit = Instant::now() - Duration::from_secs(5);

    crate::app_deprintln!(
        "[stream] ranged dl start: total={} KiB (~{:.2} MiB)",
        total_size.saturating_div(1024),
        total_size as f64 / (1024.0 * 1024.0)
    );

    'outer: loop {
        let response = if let Some(r) = next_response.take() {
            r
        } else {
            let mut req = http_client.get(&url);
            if downloaded > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
            }
            match req.send().await {
                Ok(r) => r,
                Err(err) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] ranged reconnect failed after {} attempts: {}",
                            reconnects, err
                        );
                        break 'outer;
                    }
                    reconnects += 1;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue 'outer;
                }
            }
        };
        if downloaded > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            crate::app_eprintln!(
                "[audio] ranged reconnect returned {}, expected 206",
                response.status()
            );
            break 'outer;
        }
        if downloaded == 0 && !response.status().is_success() {
            crate::app_eprintln!("[audio] ranged HTTP {}", response.status());
            break 'outer;
        }

        let mut byte_stream = response.bytes_stream();
        while let Some(chunk) = byte_stream.next().await {
            if gen_arc.load(Ordering::SeqCst) != gen {
                crate::app_deprintln!(
                    "[stream] ranged dl superseded by skip: track_id={:?} gen={}→{} downloaded={}/{} bytes",
                    cache_track_id, gen, gen_arc.load(Ordering::SeqCst), downloaded, total_size
                );
                done.store(true, Ordering::SeqCst);
                return;
            }
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] ranged dl error after {} reconnects: {}",
                            reconnects, e
                        );
                        break 'outer;
                    }
                    reconnects += 1;
                    crate::app_eprintln!(
                        "[audio] ranged dl error (attempt {}/{}): {} — reconnecting",
                        reconnects, TRACK_STREAM_MAX_RECONNECTS, e
                    );
                    next_response = None;
                    continue 'outer;
                }
            };
            reconnects = 0;
            let writable = total_size.saturating_sub(downloaded);
            if writable == 0 {
                break;
            }
            let n = chunk.len().min(writable);
            {
                let mut b = buf.lock().unwrap();
                b[downloaded..downloaded + n].copy_from_slice(&chunk[..n]);
            }
            downloaded += n;
            downloaded_to.store(downloaded, Ordering::SeqCst);
            if downloaded >= crate::helpers::PARTIAL_LOUDNESS_MIN_BYTES
                && total_size > 0
                && last_partial_loudness_emit.elapsed() >= Duration::from_millis(crate::helpers::PARTIAL_LOUDNESS_EMIT_INTERVAL_MS)
            {
                last_partial_loudness_emit = Instant::now();
                if normalization_engine.load(Ordering::Relaxed) == 2 {
                    let target_lufs = f32::from_bits(normalization_target_lufs.load(Ordering::Relaxed));
                    let start_db = f32::from_bits(loudness_pre_analysis_attenuation_db.load(Ordering::Relaxed))
                        .clamp(-24.0, 0.0);
                    if let Some(provisional_db) =
                        crate::helpers::provisional_loudness_gain_from_progress(downloaded, total_size, target_lufs, start_db)
                    {
                        let track_key = crate::helpers::playback_identity(&url).unwrap_or_else(|| url.clone());
                        if crate::ipc::partial_loudness_should_emit(&track_key, provisional_db) {
                            let _ = app.emit(
                                "analysis:loudness-partial",
                                crate::ipc::PartialLoudnessPayload {
                                    track_id: crate::helpers::playback_identity(&url),
                                    gain_db: provisional_db,
                                    target_lufs,
                                    is_partial: true,
                                },
                            );
                        }
                    }
                }
            }
            let mb = downloaded / (1024 * 1024);
            while mb >= next_progress_mb {
                let pct = if total_size > 0 {
                    (downloaded as f64 / total_size as f64 * 100.0) as u32
                } else {
                    0u32
                };
                crate::app_deprintln!(
                    "[stream] dl progress: {} MB / {} MB ({}%)",
                    mb,
                    total_size / (1024 * 1024),
                    pct
                );
                next_progress_mb = mb + 1;
            }
            if downloaded >= total_size {
                break;
            }
        }
        // Stream ended cleanly (or hit total_size).
        break 'outer;
    }

    done.store(true, Ordering::SeqCst);

    if downloaded < total_size {
        crate::app_eprintln!(
            "[stream] ranged dl ABORTED: {} / {} bytes in {:.2}s ({} reconnects, track_id={:?})",
            downloaded,
            total_size,
            dl_started.elapsed().as_secs_f64(),
            reconnects,
            cache_track_id
        );
    } else {
        crate::app_deprintln!(
            "[stream] dl done: {} / {} bytes in {:.2}s ({} reconnects)",
            downloaded,
            total_size,
            dl_started.elapsed().as_secs_f64(),
            reconnects
        );
    }

    if downloaded == total_size && total_size > 0 && total_size <= TRACK_STREAM_PROMOTE_MAX_BYTES {
        if let Some(ref tid) = cache_track_id {
            crate::app_deprintln!(
                "[stream] ranged: HTTP buffer full track_id={} size_mib={:.2} — cloning {} bytes then full-track analysis (cpu-seed queue; this task awaits completion)",
                tid,
                total_size as f64 / (1024.0 * 1024.0),
                total_size
            );
        }
        let t_clone = Instant::now();
        let data = buf.lock().unwrap().clone();
        if total_size > 32 * 1024 * 1024 {
            crate::app_deprintln!(
                "[stream] ranged: buffer cloned in_ms={}",
                t_clone.elapsed().as_millis()
            );
        }
        if let Some(track_id) = cache_track_id {
            let high = crate::engine::analysis_seed_high_priority_for_track(&app, &track_id);
            if let Err(e) = psysonic_analysis::analysis_runtime::submit_analysis_cpu_seed(app.clone(), track_id.clone(), data.clone(), high).await {
                crate::app_eprintln!("[analysis] ranged seed failed for {}: {}", track_id, e);
            }
        }
        if gen_arc.load(Ordering::SeqCst) != gen {
            return;
        }
        *promote_cache_slot.lock().unwrap() = Some(PreloadedTrack { url, data });
        crate::app_deprintln!("[stream] promoted to stream_completed_cache for replay");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a `RangedHttpSource` with `total_size` bytes, all already
    /// "downloaded" — no read path will block waiting for data.
    fn ready_source(data: &[u8]) -> RangedHttpSource {
        let total = data.len() as u64;
        let buf = Arc::new(Mutex::new(data.to_vec()));
        let downloaded_to = Arc::new(AtomicUsize::new(data.len()));
        let done = Arc::new(AtomicBool::new(true));
        let gen_arc = Arc::new(AtomicU64::new(7));
        RangedHttpSource {
            buf,
            downloaded_to,
            total_size: total,
            pos: 0,
            done,
            gen_arc,
            gen: 7,
        }
    }

    // ── Read ──────────────────────────────────────────────────────────────────

    #[test]
    fn read_returns_zero_when_pos_at_end() {
        let mut src = ready_source(&[1, 2, 3, 4]);
        src.pos = 4;
        let mut out = [0u8; 8];
        assert_eq!(src.read(&mut out).unwrap(), 0);
    }

    #[test]
    fn read_returns_zero_for_empty_output_buffer() {
        let mut src = ready_source(&[1, 2, 3, 4]);
        let mut out: [u8; 0] = [];
        assert_eq!(src.read(&mut out).unwrap(), 0);
    }

    #[test]
    fn read_copies_full_buffer_when_data_is_already_downloaded() {
        let mut src = ready_source(&[10, 20, 30, 40]);
        let mut out = [0u8; 4];
        assert_eq!(src.read(&mut out).unwrap(), 4);
        assert_eq!(out, [10, 20, 30, 40]);
        assert_eq!(src.pos, 4, "pos advances by bytes read");
    }

    #[test]
    fn read_advances_pos_across_multiple_calls() {
        let mut src = ready_source(&[1, 2, 3, 4, 5, 6]);
        let mut out = [0u8; 4];
        assert_eq!(src.read(&mut out).unwrap(), 4);
        assert_eq!(out, [1, 2, 3, 4]);
        let mut out2 = [0u8; 4];
        assert_eq!(src.read(&mut out2).unwrap(), 2, "remaining is < buf.len");
        assert_eq!(&out2[..2], &[5, 6]);
    }

    #[test]
    fn read_returns_zero_when_superseded_by_gen_change() {
        let mut src = ready_source(&[1, 2, 3, 4]);
        src.gen_arc.store(99, Ordering::SeqCst); // generation moved on
        let mut out = [0u8; 4];
        assert_eq!(src.read(&mut out).unwrap(), 0);
    }

    #[test]
    fn read_returns_partial_when_done_with_only_some_data() {
        let total: u64 = 8;
        let buf = Arc::new(Mutex::new(vec![0u8; total as usize]));
        // Pre-fill only the first 5 bytes.
        for (i, b) in [1u8, 2, 3, 4, 5].iter().enumerate() {
            buf.lock().unwrap()[i] = *b;
        }
        let downloaded_to = Arc::new(AtomicUsize::new(5));
        let done = Arc::new(AtomicBool::new(true));
        let gen_arc = Arc::new(AtomicU64::new(1));
        let mut src = RangedHttpSource {
            buf,
            downloaded_to,
            total_size: total,
            pos: 0,
            done,
            gen_arc,
            gen: 1,
        };
        let mut out = [0u8; 8];
        let n = src.read(&mut out).unwrap();
        assert_eq!(n, 5, "returns only the bytes that arrived before EOF");
        assert_eq!(&out[..5], &[1, 2, 3, 4, 5]);
        assert_eq!(src.pos, 5);
    }

    #[test]
    fn read_returns_zero_when_done_with_no_data_ahead_of_cursor() {
        let total: u64 = 8;
        let src_buf = Arc::new(Mutex::new(vec![0u8; total as usize]));
        let downloaded_to = Arc::new(AtomicUsize::new(3));
        let done = Arc::new(AtomicBool::new(true));
        let gen_arc = Arc::new(AtomicU64::new(1));
        let mut src = RangedHttpSource {
            buf: src_buf,
            downloaded_to,
            total_size: total,
            pos: 5, // past downloaded_to
            done,
            gen_arc,
            gen: 1,
        };
        let mut out = [0u8; 8];
        assert_eq!(src.read(&mut out).unwrap(), 0);
    }

    // ── Seek ──────────────────────────────────────────────────────────────────

    #[test]
    fn seek_from_start_sets_pos() {
        let mut src = ready_source(&[0u8; 16]);
        assert_eq!(src.seek(SeekFrom::Start(8)).unwrap(), 8);
        assert_eq!(src.pos, 8);
    }

    #[test]
    fn seek_from_start_clamps_to_total_size() {
        let mut src = ready_source(&[0u8; 16]);
        assert_eq!(src.seek(SeekFrom::Start(100)).unwrap(), 16);
        assert_eq!(src.pos, 16);
    }

    #[test]
    fn seek_from_current_offsets_relative_to_pos() {
        let mut src = ready_source(&[0u8; 16]);
        src.pos = 4;
        assert_eq!(src.seek(SeekFrom::Current(3)).unwrap(), 7);
    }

    #[test]
    fn seek_from_current_negative_walks_backward() {
        let mut src = ready_source(&[0u8; 16]);
        src.pos = 10;
        assert_eq!(src.seek(SeekFrom::Current(-4)).unwrap(), 6);
    }

    #[test]
    fn seek_from_end_negative_walks_back_from_total() {
        let mut src = ready_source(&[0u8; 16]);
        assert_eq!(src.seek(SeekFrom::End(-3)).unwrap(), 13);
    }

    #[test]
    fn seek_before_start_errors_with_invalid_input() {
        let mut src = ready_source(&[0u8; 16]);
        let err = src.seek(SeekFrom::Current(-5)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn seek_beyond_end_clamps_at_total_size() {
        let mut src = ready_source(&[0u8; 16]);
        assert_eq!(src.seek(SeekFrom::End(100)).unwrap(), 16);
    }

    // ── MediaSource ───────────────────────────────────────────────────────────

    #[test]
    fn media_source_is_seekable_returns_true() {
        let src = ready_source(&[0u8; 4]);
        assert!(src.is_seekable());
    }

    #[test]
    fn media_source_byte_len_returns_total_size() {
        let src = ready_source(&[0u8; 42]);
        assert_eq!(src.byte_len(), Some(42));
    }
}
