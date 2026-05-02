//! Internet radio, ranged/track HTTP readers, ring-buffer producers, and ICY parsing.
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use ringbuf::{HeapConsumer, HeapProducer};
use symphonia::core::io::MediaSource;
use tauri::{AppHandle, Emitter};

use super::state::PreloadedTrack;
/// Clears [`AudioEngine::ranged_loudness_seed_hold`] only if it still matches this play.
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
/// 256 KB on the heap — ≈16 s at 128 kbps, ≈6 s at 320 kbps.
/// Small enough that stale audio drains within a few seconds on reconnect;
/// large enough to absorb brief network hiccups without stuttering.
pub(crate) const RADIO_BUF_CAPACITY: usize = 256 * 1024;
/// Minimum ring buffer for on-demand track streaming starts.
pub(crate) const TRACK_STREAM_MIN_BUF_CAPACITY: usize = 1024 * 1024;
/// Cap ring buffer growth when content-length is known.
pub(crate) const TRACK_STREAM_MAX_BUF_CAPACITY: usize = 32 * 1024 * 1024;
/// Max bytes kept in memory to promote a completed streamed track for fast replay/seek recovery.
pub(crate) const TRACK_STREAM_PROMOTE_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Hot/offline `psysonic-local://` files are read from disk for waveform/LUFS seeding — not the
/// same heap pressure as retaining a full HTTP capture. FLAC/DSD tracks often exceed 64 MiB;
/// using the stream-promote cap here skipped analysis entirely (empty seekbar).
pub(crate) const LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES: usize = 512 * 1024 * 1024;
/// Consecutive body-stream failures tolerated for track streaming before abort.
pub(crate) const TRACK_STREAM_MAX_RECONNECTS: u32 = 3;
/// Seconds at stall threshold while paused before hard-disconnect.
pub(crate) const RADIO_HARD_PAUSE_SECS: u64 = 5;
/// AudioStreamReader timeout: if no audio bytes arrive for this long → EOF.
pub(crate) const RADIO_READ_TIMEOUT_SECS: u64 = 15;
/// Sleep interval when ring buffer is empty (prevents CPU spin).
pub(crate) const RADIO_YIELD_MS: u64 = 2;

// ── ICY Metadata State Machine ────────────────────────────────────────────────
//
// Shoutcast/Icecast embed metadata every `metaint` audio bytes:
//
//   ┌──────────────────────┬───┬─────────────┐
//   │  audio × metaint     │ N │ meta × N×16 │  (repeating)
//   └──────────────────────┴───┴─────────────┘
//
// N = 0 → no metadata this block.  Metadata bytes are stripped so only
// pure audio reaches the ring buffer and Symphonia never sees text bytes.

pub(crate) enum IcyState {
    /// Forwarding audio bytes; `remaining` counts down to the next boundary.
    ReadingAudio { remaining: usize },
    /// Next byte is the metadata length multiplier N.
    ReadingLengthByte,
    /// Accumulating N×16 metadata bytes.
    ReadingMetadata { remaining: usize, buf: Vec<u8> },
}

pub(crate) struct IcyInterceptor {
    state: IcyState,
    metaint: usize,
}

impl IcyInterceptor {
    fn new(metaint: usize) -> Self {
        Self { metaint, state: IcyState::ReadingAudio { remaining: metaint } }
    }

    /// Feed a raw HTTP chunk.
    /// Appends only audio bytes to `audio_out`.
    /// Returns `Some(IcyMeta)` when a StreamTitle is extracted.
    fn process(&mut self, input: &[u8], audio_out: &mut Vec<u8>) -> Option<IcyMeta> {
        let mut extracted: Option<IcyMeta> = None;
        let mut i = 0;
        while i < input.len() {
            match &mut self.state {
                IcyState::ReadingAudio { remaining } => {
                    let n = (input.len() - i).min(*remaining);
                    audio_out.extend_from_slice(&input[i..i + n]);
                    i += n;
                    *remaining -= n;
                    if *remaining == 0 {
                        self.state = IcyState::ReadingLengthByte;
                    }
                }
                IcyState::ReadingLengthByte => {
                    let len_n = input[i] as usize;
                    i += 1;
                    self.state = if len_n == 0 {
                        IcyState::ReadingAudio { remaining: self.metaint }
                    } else {
                        IcyState::ReadingMetadata {
                            remaining: len_n * 16,
                            buf: Vec::with_capacity(len_n * 16),
                        }
                    };
                }
                IcyState::ReadingMetadata { remaining, buf } => {
                    let n = (input.len() - i).min(*remaining);
                    buf.extend_from_slice(&input[i..i + n]);
                    i += n;
                    *remaining -= n;
                    if *remaining == 0 {
                        let bytes = std::mem::take(buf);
                        extracted = parse_icy_meta(&bytes);
                        self.state = IcyState::ReadingAudio { remaining: self.metaint };
                    }
                }
            }
        }
        extracted
    }
}

/// ICY metadata parsed from a raw metadata block.
#[derive(serde::Serialize, Clone)]
pub(crate) struct IcyMeta {
    pub title: String,
    /// `true` when `StreamUrl='0'` — indicates a CDN-injected ad/promo.
    pub is_ad: bool,
}

/// Extract `StreamTitle` and `StreamUrl` from a raw ICY metadata block.
/// Tolerates null padding and non-UTF-8 bytes (lossy conversion).
fn parse_icy_meta(raw: &[u8]) -> Option<IcyMeta> {
    let s = String::from_utf8_lossy(raw);
    let s = s.trim_end_matches('\0');

    const TITLE_TAG: &str = "StreamTitle='";
    let title_start = s.find(TITLE_TAG)? + TITLE_TAG.len();
    let title_rest = &s[title_start..];
    // find (not rfind) — rfind would skip past StreamUrl and corrupt the title
    let title_end = title_rest.find("';")?;
    let title = title_rest[..title_end].trim().to_string();
    if title.is_empty() {
        return None;
    }

    const URL_TAG: &str = "StreamUrl='";
    let stream_url = s.find(URL_TAG).map(|pos| {
        let rest = &s[pos + URL_TAG.len()..];
        let end = rest.find("';").unwrap_or(rest.len());
        rest[..end].trim().to_string()
    }).unwrap_or_default();

    Some(IcyMeta { title, is_ad: stream_url == "0" })
}

// ── AudioStreamReader — SPSC consumer → std::io::Read ────────────────────────
//
// Bridges HeapConsumer<u8> (non-blocking) into the synchronous Read interface
// that Symphonia requires.  Designed to run inside tokio::task::spawn_blocking.
//
// Empty buffer:  sleeps RADIO_YIELD_MS ms, retries. Never busy-spins.
// Timeout:       after RADIO_READ_TIMEOUT_SECS with no data → TimedOut.
// Generation:    if gen_arc != self.gen → Ok(0) (EOF; new track started).
// Reconnect:     audio_resume sends a fresh HeapConsumer via new_cons_rx.
//                On the next read() we drain the channel (keep latest) and swap.

pub(crate) struct AudioStreamReader {
    pub(crate) cons: HeapConsumer<u8>,
    /// Delivers fresh consumers on hard-pause reconnect (unbounded; drain to latest).
    /// Wrapped in Mutex so AudioStreamReader is Sync (required by symphonia::MediaSource).
    /// No real contention: only the audio thread ever calls read().
    pub(crate) new_cons_rx: Mutex<std::sync::mpsc::Receiver<HeapConsumer<u8>>>,
    pub(crate) deadline: std::time::Instant,
    pub(crate) gen_arc: Arc<AtomicU64>,
    pub(crate) gen: u64,
    /// Diagnostic tag for logs ("radio" or "track-stream").
    pub(crate) source_tag: &'static str,
    /// Optional completion marker: when true and the ring buffer is empty,
    /// return EOF immediately (used by one-shot track streaming).
    pub(crate) eof_when_empty: Option<Arc<AtomicBool>>,
    /// Monotonic byte offset for SeekFrom::Current(0) "tell" (Symphonia probe).
    pub(crate) pos: u64,
}

impl Read for AudioStreamReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // EOF guard: new track started.
        if self.gen_arc.load(Ordering::SeqCst) != self.gen {
            return Ok(0);
        }
        // Drain reconnect channel; keep only the most recently delivered consumer
        // so a double-tap of resume doesn't leave stale data in place.
        let mut newest: Option<HeapConsumer<u8>> = None;
        while let Ok(c) = self.new_cons_rx.lock().unwrap().try_recv() {
            newest = Some(c);
        }
        if let Some(c) = newest {
            self.cons = c;
            self.deadline =
                std::time::Instant::now() + Duration::from_secs(RADIO_READ_TIMEOUT_SECS);
        }
        loop {
            if self.gen_arc.load(Ordering::SeqCst) != self.gen {
                return Ok(0);
            }
            let available = self.cons.len();
            if available > 0 {
                let n = buf.len().min(available);
                let read = self.cons.pop_slice(&mut buf[..n]);
                self.pos += read as u64;
                // Reset deadline: data arrived, so connection is alive.
                self.deadline =
                    std::time::Instant::now() + Duration::from_secs(RADIO_READ_TIMEOUT_SECS);
                return Ok(read);
            }
            if self
                .eof_when_empty
                .as_ref()
                .is_some_and(|done| done.load(Ordering::SeqCst))
            {
                return Ok(0);
            }
            if std::time::Instant::now() >= self.deadline {
                crate::app_eprintln!(
                    "[{}] AudioStreamReader: {}s without data → EOF",
                    self.source_tag,
                    RADIO_READ_TIMEOUT_SECS
                );
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("{}: no data received", self.source_tag),
                ));
            }
            std::thread::sleep(Duration::from_millis(RADIO_YIELD_MS));
        }
    }
}

impl Seek for AudioStreamReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        match pos {
            SeekFrom::Current(0) => Ok(self.pos),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                format!("{} stream is not seekable", self.source_tag),
            )),
        }
    }
}

impl MediaSource for AudioStreamReader {
    fn is_seekable(&self) -> bool { false }
    fn byte_len(&self) -> Option<u64> { None }
}

// ── RangedHttpSource — seekable HTTP-backed MediaSource ──────────────────────
//
// Pre-allocates a Vec<u8> of total track size. A background task fills it
// linearly from offset 0 via streaming HTTP. Read blocks (with timeout) until
// requested bytes are downloaded; Seek only updates the cursor.
//
// Reports is_seekable=true so Symphonia performs time-based seeks via the
// format reader. Backward seeks: instant (data in buffer). Forward seeks
// beyond downloaded_to: Read blocks until the linear download catches up.
//
// Requires server to have responded with both Content-Length and
// `Accept-Ranges: bytes` so reconnects can resume via HTTP Range.

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

// ── LocalFileSource — seekable file-backed MediaSource ───────────────────────
//
// Wraps `std::fs::File` so the decoder reads on-demand from disk instead of
// pre-loading the whole file into a Vec. Used for `psysonic-local://` URLs
// (offline library + hot playback cache hits) — gives instant track-start
// because Symphonia only needs to read ~64 KB during probe before playback
// can begin, vs the previous behaviour of `tokio::fs::read` which blocked
// until the entire file (often 100+ MB for hi-res FLAC) was in RAM.

pub(crate) struct LocalFileSource {
    pub(crate) file: std::fs::File,
    pub(crate) len: u64,
}

impl Read for LocalFileSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(buf)
    }
}

impl Seek for LocalFileSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(pos)
    }
}

impl MediaSource for LocalFileSource {
    fn is_seekable(&self) -> bool { true }
    fn byte_len(&self) -> Option<u64> { Some(self.len) }
}

// ── Pause / Reconnect Coordination ───────────────────────────────────────────

pub(crate) struct RadioSharedFlags {
    /// Set by audio_pause; cleared by audio_resume.
    pub(crate) is_paused: AtomicBool,
    /// Set by download task on hard disconnect; cleared on resume-reconnect.
    pub(crate) is_hard_paused: AtomicBool,
    /// Delivers a fresh HeapConsumer<u8> to AudioStreamReader on reconnect.
    pub(crate) new_cons_tx: Mutex<std::sync::mpsc::Sender<HeapConsumer<u8>>>,
}

/// Live state for the current radio session, stored in AudioEngine.
/// Dropping this struct aborts the HTTP download task immediately.
pub(crate) struct RadioLiveState {
    pub url: String,
    pub gen: u64,
    pub task: tokio::task::JoinHandle<()>,
    pub flags: Arc<RadioSharedFlags>,
}

impl Drop for RadioLiveState {
    fn drop(&mut self) { self.task.abort(); }
}

// ── HE-AAC / FDK-AAC Fallback ────────────────────────────────────────────────
//
// Symphonia 0.5.x: AAC-LC only.  HE-AAC (AAC+) and HE-AACv2 lack SBR/PS →
// streams play at half speed with muffled audio.
//
// With Cargo feature "fdk-aac": FdkAacDecoder is tried first for CODEC_TYPE_AAC.
// Enable in Cargo.toml:
//   symphonia-adapter-fdk-aac = { version = "0.1", optional = true }
//   [features]
//   fdk-aac = ["dep:symphonia-adapter-fdk-aac"]

// ── Async HTTP Download Task ──────────────────────────────────────────────────
//
// Lifecycle:
//   'outer loop — reconnect on TCP drop (up to MAX_RECONNECTS)
//   'inner loop — read HTTP chunks → ICY interceptor → push audio to ring buffer
//
// Hard-pause detection: if push_slice() returns 0 (buffer full) AND sink is
// paused AND that condition persists for RADIO_HARD_PAUSE_SECS → disconnect.
// Sets is_hard_paused = true so audio_resume knows it must reconnect.

pub(crate) async fn radio_download_task(
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    mut initial_response: Option<reqwest::Response>,
    http_client: reqwest::Client,
    url: String,
    mut prod: HeapProducer<u8>,
    flags: Arc<RadioSharedFlags>,
    app: AppHandle,
) {
    let mut bytes_total: u64 = 0;
    // Counts consecutive failures (reset on each successful chunk).
    // laut.fm and similar CDNs force-reconnect every ~700 KB; this is normal.
    let mut reconnect_count: u32 = 0;
    const MAX_CONSECUTIVE_FAILURES: u32 = 5;
    let mut audio_scratch: Vec<u8> = Vec::with_capacity(65_536);

    'outer: loop {
        if gen_arc.load(Ordering::SeqCst) != gen { return; }

        // ── Obtain response (initial or reconnect) ────────────────────────────
        let response = match initial_response.take() {
            Some(r) => r,
            None => {
                if reconnect_count >= MAX_CONSECUTIVE_FAILURES {
                    crate::app_eprintln!("[radio] {MAX_CONSECUTIVE_FAILURES} consecutive failures — giving up");
                    break 'outer;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                if gen_arc.load(Ordering::SeqCst) != gen { return; }
                match http_client
                    .get(&url)
                    .header("Icy-MetaData", "1")
                    .send()
                    .await
                {
                    Ok(r) if r.status().is_success() => {
                        crate::app_eprintln!("[radio] reconnected ({bytes_total} B so far)");
                        r
                    }
                    Ok(r) => {
                        crate::app_eprintln!("[radio] reconnect: HTTP {} — giving up", r.status());
                        break 'outer;
                    }
                    Err(e) => {
                        crate::app_eprintln!("[radio] reconnect error: {e} — giving up");
                        break 'outer;
                    }
                }
            }
        };

        // Parse ICY metaint from each response (consistent across reconnects).
        let metaint: Option<usize> = response
            .headers()
            .get("icy-metaint")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok());
        let mut icy = metaint.map(IcyInterceptor::new);

        let mut byte_stream = response.bytes_stream();
        // Stall timer: tracks how long push_slice() returns 0 while paused.
        let mut stall_since: Option<std::time::Instant> = None;

        'inner: loop {
            if gen_arc.load(Ordering::SeqCst) != gen { return; }

            // ── Back-pressure + hard-pause detection ──────────────────────────
            if prod.is_full() {
                if flags.is_paused.load(Ordering::Relaxed) {
                    let since = stall_since.get_or_insert(std::time::Instant::now());
                    if since.elapsed() >= Duration::from_secs(RADIO_HARD_PAUSE_SECS) {
                        let fill_pct = ((1.0
                            - prod.free_len() as f32 / RADIO_BUF_CAPACITY as f32)
                            * 100.0) as u32;
                        crate::app_eprintln!(
                            "[radio] hard pause: {fill_pct}% full, \
                             paused >{RADIO_HARD_PAUSE_SECS}s → disconnecting"
                        );
                        flags.is_hard_paused.store(true, Ordering::Release);
                        return; // Drop HeapProducer → TCP connection released.
                    }
                } else {
                    stall_since = None;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue 'inner;
            }
            stall_since = None;

            // ── Read HTTP chunk ───────────────────────────────────────────────
            match byte_stream.next().await {
                Some(Ok(chunk)) => {
                    bytes_total += chunk.len() as u64;
                    // Successful data → reset consecutive-failure counter.
                    reconnect_count = 0;
                    audio_scratch.clear();

                    if let Some(ref mut interceptor) = icy {
                        if let Some(meta) = interceptor.process(&chunk, &mut audio_scratch) {
                            let label = if meta.is_ad { "[Ad]" } else { "" };
                            crate::app_eprintln!("[radio] ICY StreamTitle: {}{}", label, meta.title);
                            let _ = app.emit("radio:metadata", &meta);
                        }
                    } else {
                        audio_scratch.extend_from_slice(&chunk);
                    }

                    // Push with per-chunk back-pressure: yield 5 ms if full mid-chunk.
                    let mut offset = 0;
                    while offset < audio_scratch.len() {
                        if gen_arc.load(Ordering::SeqCst) != gen { return; }
                        let pushed = prod.push_slice(&audio_scratch[offset..]);
                        if pushed == 0 {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        } else {
                            offset += pushed;
                        }
                    }
                }
                Some(Err(e)) => {
                    reconnect_count += 1;
                    crate::app_eprintln!("[radio] stream error: {e} → reconnecting (consecutive #{reconnect_count})");
                    break 'inner;
                }
                None => {
                    reconnect_count += 1;
                    crate::app_eprintln!("[radio] stream ended cleanly → reconnecting (consecutive #{reconnect_count})");
                    break 'inner;
                }
            }
        } // 'inner

        // Do NOT swap the ring buffer here.  The remaining bytes in the buffer
        // are still valid audio and will drain naturally during reconnect.
        // Clearing it would cause an immediate underrun/glitch.
        // The buffer is kept small (RADIO_BUF_CAPACITY) so stale audio drains
        // within a few seconds rather than minutes.
    } // 'outer

    crate::app_eprintln!("[radio] download task done ({bytes_total} B total)");
}

/// One-shot HTTP downloader for track streaming starts.
///
/// Pushes response chunks into an SPSC ring buffer consumed by `AudioStreamReader`.
/// Terminates when:
/// - generation changes (track superseded),
/// - response stream ends, or
/// - response emits an error.
pub(crate) async fn track_download_task(
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    http_client: reqwest::Client,
    app: AppHandle,
    url: String,
    initial_response: reqwest::Response,
    mut prod: HeapProducer<u8>,
    done: Arc<AtomicBool>,
    promote_cache_slot: Arc<Mutex<Option<PreloadedTrack>>>,
    normalization_engine: Arc<AtomicU32>,
    normalization_target_lufs: Arc<AtomicU32>,
    loudness_pre_analysis_attenuation_db: Arc<AtomicU32>,
    cache_track_id: Option<String>,
) {
    let mut downloaded: u64 = 0;
    let mut reconnects: u32 = 0;
    let mut next_response: Option<reqwest::Response> = Some(initial_response);
    let mut capture: Vec<u8> = Vec::new();
    let mut capture_over_limit = false;
    let mut last_partial_loudness_emit = Instant::now() - Duration::from_secs(5);
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
                            "[audio] streaming reconnect failed after {} attempts: {}",
                            reconnects, err
                        );
                        done.store(true, Ordering::SeqCst);
                        return;
                    }
                    reconnects += 1;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue 'outer;
                }
            }
        };
        if downloaded > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            crate::app_eprintln!(
                "[audio] streaming reconnect returned {}, expected 206 for range resume",
                response.status()
            );
            done.store(true, Ordering::SeqCst);
            return;
        }
        if downloaded == 0 && !response.status().is_success() {
            crate::app_eprintln!("[audio] streaming HTTP {}", response.status());
            done.store(true, Ordering::SeqCst);
            return;
        }

        let mut byte_stream = response.bytes_stream();
        while let Some(chunk) = byte_stream.next().await {
            if gen_arc.load(Ordering::SeqCst) != gen {
                done.store(true, Ordering::SeqCst);
                return;
            }
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] streaming download error after {} reconnects: {}",
                            reconnects, e
                        );
                        done.store(true, Ordering::SeqCst);
                        return;
                    }
                    reconnects += 1;
                    crate::app_eprintln!(
                        "[audio] streaming download error (attempt {}/{}): {} — reconnecting",
                        reconnects,
                        TRACK_STREAM_MAX_RECONNECTS,
                        e
                    );
                    next_response = None;
                    continue 'outer;
                }
            };
            reconnects = 0;
            let mut offset = 0;
            while offset < chunk.len() {
                if gen_arc.load(Ordering::SeqCst) != gen {
                    done.store(true, Ordering::SeqCst);
                    return;
                }
                let pushed = prod.push_slice(&chunk[offset..]);
                if pushed == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                } else {
                    if !capture_over_limit {
                        if capture.len().saturating_add(pushed) <= TRACK_STREAM_PROMOTE_MAX_BYTES {
                            let from = offset;
                            let to = offset + pushed;
                            capture.extend_from_slice(&chunk[from..to]);
                        } else {
                            capture.clear();
                            capture_over_limit = true;
                        }
                    }
                    if !capture_over_limit
                        && last_partial_loudness_emit.elapsed() >= Duration::from_millis(crate::audio::helpers::PARTIAL_LOUDNESS_EMIT_INTERVAL_MS)
                    {
                        last_partial_loudness_emit = Instant::now();
                        if normalization_engine.load(Ordering::Relaxed) == 2 {
                            let target_lufs = f32::from_bits(normalization_target_lufs.load(Ordering::Relaxed));
                            let pre_db = f32::from_bits(
                                loudness_pre_analysis_attenuation_db.load(Ordering::Relaxed),
                            )
                            .clamp(-24.0, 0.0);
                            super::helpers::emit_partial_loudness_from_bytes(&app, &url, &capture, target_lufs, pre_db);
                        }
                    }
                    offset += pushed;
                    downloaded += pushed as u64;
                }
            }
        }
        if !capture_over_limit && !capture.is_empty() {
            if let Some(track_id) = cache_track_id {
                crate::app_deprintln!(
                    "[stream] legacy stream: capture complete track_id={} capture_mib={:.2} — full-track analysis (cpu-seed queue)",
                    track_id,
                    capture.len() as f64 / (1024.0 * 1024.0)
                );
                let high = crate::audio::engine::analysis_seed_high_priority_for_track(&app, &track_id);
                if let Err(e) =
                    crate::submit_analysis_cpu_seed(app.clone(), track_id.clone(), capture.clone(), high).await
                {
                    crate::app_eprintln!("[analysis] track seed failed for {}: {}", track_id, e);
                }
            }
            *promote_cache_slot.lock().unwrap() = Some(PreloadedTrack {
                url: url.clone(),
                data: capture,
            });
        }
        done.store(true, Ordering::SeqCst);
        return;
    }
}

/// Linear downloader for `RangedHttpSource`: fills the pre-allocated buffer
/// from offset 0 to total_size. Reconnects via HTTP Range from the current
/// `downloaded` offset on transient errors. On completion (full track) the
/// data is promoted to `stream_completed_cache` for fast replay.
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
    loudness_seed_hold: Option<Arc<Mutex<Option<(String, u64)>>>>,
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
    let mut next_progress_mb: usize = 1;
    let mut last_partial_loudness_emit = Instant::now() - Duration::from_secs(5);

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
            if downloaded >= crate::audio::helpers::PARTIAL_LOUDNESS_MIN_BYTES
                && total_size > 0
                && last_partial_loudness_emit.elapsed() >= Duration::from_millis(crate::audio::helpers::PARTIAL_LOUDNESS_EMIT_INTERVAL_MS)
            {
                last_partial_loudness_emit = Instant::now();
                if normalization_engine.load(Ordering::Relaxed) == 2 {
                    let target_lufs = f32::from_bits(normalization_target_lufs.load(Ordering::Relaxed));
                    let start_db = f32::from_bits(loudness_pre_analysis_attenuation_db.load(Ordering::Relaxed))
                        .clamp(-24.0, 0.0);
                    if let Some(provisional_db) =
                        super::helpers::provisional_loudness_gain_from_progress(downloaded, total_size, target_lufs, start_db)
                    {
                        let track_key = crate::audio::helpers::playback_identity(&url).unwrap_or_else(|| url.clone());
                        if crate::audio::ipc::partial_loudness_should_emit(&track_key, provisional_db) {
                            let _ = app.emit(
                                "analysis:loudness-partial",
                                crate::audio::ipc::PartialLoudnessPayload {
                                    track_id: crate::audio::helpers::playback_identity(&url),
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
            if mb >= next_progress_mb {
                let pct = (downloaded as f64 / total_size as f64 * 100.0) as u32;
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

    crate::app_deprintln!(
        "[stream] dl done: {} / {} bytes in {:.2}s ({} reconnects)",
        downloaded,
        total_size,
        dl_started.elapsed().as_secs_f64(),
        reconnects
    );

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
            let high = crate::audio::engine::analysis_seed_high_priority_for_track(&app, &track_id);
            if let Err(e) = crate::submit_analysis_cpu_seed(app.clone(), track_id.clone(), data.clone(), high).await {
                crate::app_eprintln!("[analysis] ranged seed failed for {}: {}", track_id, e);
            }
        }
        *promote_cache_slot.lock().unwrap() = Some(PreloadedTrack { url, data });
        crate::app_deprintln!("[stream] promoted to stream_completed_cache for replay");
    }
}
