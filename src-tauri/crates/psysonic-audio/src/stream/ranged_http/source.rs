use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use symphonia::core::io::MediaSource;

use super::range_task::ranged_write_http_range;
use crate::engine::PlaybackHttpHeaders;
use crate::stream::{RADIO_YIELD_MS, TRACK_READ_TIMEOUT_SECS};

/// Minimum bytes fetched per on-demand Range request. A seek often triggers a
/// short read; fetching a window amortizes the HTTP round-trip and lets the few
/// pages a bisection lands on (and the playback that follows a forward seek) be
/// served without a fresh request each time.
const OD_FETCH_WINDOW: u64 = 1024 * 1024;
/// Forward gap (cursor ahead of the contiguous linear download) above which a
/// read is treated as a *seek* and served by an on-demand HTTP Range fetch
/// instead of waiting for the linear filler to catch up. Below it we assume
/// ordinary read-ahead that the linear download will satisfy shortly, so we do
/// not issue redundant range requests during normal (slightly starved) play.
const OD_SEEK_GAP: u64 = 512 * 1024;

/// Random-access companion for [`RangedHttpSource`]: fetches arbitrary byte
/// ranges over HTTP `Range` on demand so seeks (which jump the read cursor far
/// ahead of the linear download) resolve quickly instead of blocking until the
/// linear filler reaches the target.
///
/// symphonia 0.6's Ogg demuxer seeks by *bisection* — it reads pages at
/// midpoints across the whole byte range, and its probe scans the last pages to
/// find the stream-end timestamp. On a purely linear-fill source every such read
/// would block until the download caught up (effectively forcing a full
/// download before any seek). On-demand range fetches make those reads cheap.
pub(crate) struct OnDemand {
    http: reqwest::Client,
    handle: tokio::runtime::Handle,
    url: String,
    buf: Arc<Mutex<Vec<u8>>>,
    total_size: u64,
    gen_arc: Arc<AtomicU64>,
    gen: u64,
    /// Byte ranges already fetched on demand (sorted/merged not required — N is
    /// the handful of seek targets per track).
    filled: Mutex<Vec<(u64, u64)>>,
    /// Ranges with an in-flight fetch, so a polling read does not respawn them.
    inflight: Mutex<Vec<(u64, u64)>>,
    /// Bumped after every completed (success or failure) fetch so the read loop
    /// can reset its stall deadline while on-demand fetches make progress.
    progress: AtomicU64,
    http_headers: PlaybackHttpHeaders,
}

impl OnDemand {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        http: reqwest::Client,
        handle: tokio::runtime::Handle,
        url: String,
        buf: Arc<Mutex<Vec<u8>>>,
        total_size: u64,
        gen_arc: Arc<AtomicU64>,
        gen: u64,
        http_headers: PlaybackHttpHeaders,
    ) -> Self {
        OnDemand {
            http,
            handle,
            url,
            buf,
            total_size,
            gen_arc,
            gen,
            filled: Mutex::new(Vec::new()),
            inflight: Mutex::new(Vec::new()),
            progress: AtomicU64::new(0),
            http_headers,
        }
    }

    fn covers(&self, start: u64, end: u64) -> bool {
        self.filled
            .lock()
            .unwrap()
            .iter()
            .any(|&(s, e)| s <= start && end <= e)
    }

    fn inflight_covers(&self, start: u64, end: u64) -> bool {
        self.inflight
            .lock()
            .unwrap()
            .iter()
            .any(|&(s, e)| s <= start && end <= e)
    }

    /// Spawn a Range fetch covering at least `[start, end)` (rounded up to
    /// [`OD_FETCH_WINDOW`]) unless it is already filled or in flight. Returns
    /// immediately; the caller polls [`OnDemand::covers`] / `progress`.
    fn request(self: &Arc<Self>, start: u64, end: u64) {
        if start >= self.total_size {
            return;
        }
        let want_end = end.max(start + OD_FETCH_WINDOW).min(self.total_size);
        if self.covers(start, want_end) || self.inflight_covers(start, want_end) {
            return;
        }
        self.inflight.lock().unwrap().push((start, want_end));
        let me = Arc::clone(self);
        self.handle.spawn(async move {
            let end_inclusive = want_end.saturating_sub(1);
            let res = ranged_write_http_range(
                &me.http,
                &me.url,
                &me.buf,
                start,
                end_inclusive,
                me.gen,
                &me.gen_arc,
                &me.http_headers,
            )
            .await;
            if let Ok(written) = res {
                if written > 0 {
                    me.filled
                        .lock()
                        .unwrap()
                        .push((start, start + written as u64));
                }
            }
            // Drop the reservation either way so a failed fetch can be retried.
            me.inflight
                .lock()
                .unwrap()
                .retain(|&(s, e)| !(s == start && e == want_end));
            me.progress.fetch_add(1, Ordering::SeqCst);
        });
    }
}

pub(crate) struct RangedHttpSource {
    /// Pre-allocated buffer of total size. Filled linearly from offset 0.
    pub(crate) buf: Arc<Mutex<Vec<u8>>>,
    /// Bytes contiguously downloaded from offset 0.
    pub(crate) downloaded_to: Arc<AtomicUsize>,
    /// When set, bytes `[tail_filled_from..total_size)` are valid (moov-at-end prefetch).
    pub(crate) tail_ready: Arc<AtomicBool>,
    pub(crate) tail_filled_from: Arc<AtomicU64>,
    pub(crate) total_size: u64,
    pub(crate) pos: u64,
    /// Set when the download task terminates (success or hard error).
    pub(crate) done: Arc<AtomicBool>,
    pub(crate) gen_arc: Arc<AtomicU64>,
    pub(crate) gen: u64,
    /// On-demand random-access fetcher. `None` keeps the legacy linear-only
    /// behaviour (used by unit tests); production ranged playback sets it so
    /// seeks resolve via HTTP `Range` instead of blocking on the linear filler.
    pub(crate) on_demand: Option<Arc<OnDemand>>,
}

impl RangedHttpSource {
    fn region_ready(&self, start: u64, end: u64) -> bool {
        let dl = self.downloaded_to.load(Ordering::Relaxed) as u64;
        if end <= dl {
            return true;
        }
        if self.tail_ready.load(Ordering::Relaxed) {
            let tail_from = self.tail_filled_from.load(Ordering::Relaxed);
            if start >= tail_from && end <= self.total_size {
                return true;
            }
        }
        if let Some(od) = &self.on_demand {
            if od.covers(start, end) {
                return true;
            }
        }
        false
    }
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

        let stall_timeout = Duration::from_secs(TRACK_READ_TIMEOUT_SECS);
        let mut deadline = Instant::now() + stall_timeout;
        let mut last_dl_seen = self.downloaded_to.load(Ordering::Relaxed) as u64;
        let mut last_od_seen = self
            .on_demand
            .as_ref()
            .map(|od| od.progress.load(Ordering::Relaxed))
            .unwrap_or(0);
        loop {
            if self.gen_arc.load(Ordering::SeqCst) != self.gen {
                crate::app_deprintln!(
                    "[stream] ranged-stream read EOF: superseded mid-wait (gen={} cur={} pos={}/{} dl={})",
                    self.gen, self.gen_arc.load(Ordering::SeqCst), self.pos, self.total_size,
                    self.downloaded_to.load(Ordering::SeqCst)
                );
                return Ok(0);
            }
            if self.region_ready(self.pos, target_end) {
                break;
            }
            let dl = self.downloaded_to.load(Ordering::SeqCst) as u64;
            if dl > last_dl_seen {
                last_dl_seen = dl;
                deadline = Instant::now() + stall_timeout;
            }
            // A read whose cursor is far ahead of the contiguous linear download
            // is a seek (Ogg bisection midpoint, end-of-stream probe, or a
            // forward scrub). Serve it from an on-demand HTTP Range fetch rather
            // than blocking until the linear filler crawls there. While the
            // download is still running; an aborted download keeps the legacy
            // partial/EOF behaviour below.
            if let Some(od) = &self.on_demand {
                let od_progress = od.progress.load(Ordering::SeqCst);
                if od_progress != last_od_seen {
                    last_od_seen = od_progress;
                    deadline = Instant::now() + stall_timeout;
                }
                if !self.done.load(Ordering::SeqCst) && self.pos > dl.saturating_add(OD_SEEK_GAP) {
                    od.request(self.pos, target_end);
                }
            }
            // Download finished but our cursor is past downloaded_to (e.g. seek
            // beyond a partial download that aborted). Return what we have.
            if self.done.load(Ordering::SeqCst) {
                if self.region_ready(self.pos, target_end) {
                    break;
                }
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
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.total_size)
    }
}
