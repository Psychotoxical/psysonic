use std::io::{Cursor, Read, Seek};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use symphonia::core::io::MediaSource;

// ─── SizedCursorSource — correct byte_len for seekable in-memory sources ──────
//
// rodio's internal ReadSeekSource wraps Cursor<Vec<u8>> but hardcodes
// byte_len() → None.  This tells symphonia "stream length unknown", which
// prevents the FLAC demuxer from seeking (it validates seek offsets against
// the total stream length from byte_len).  MP3 is unaffected because its
// demuxer uses Xing/LAME headers instead.
//
// This wrapper provides the actual byte length, fixing seek for all formats.

pub(crate) struct SizedCursorSource {
    pub(super) inner: Cursor<Vec<u8>>,
    pub(super) len: u64,
}

impl Read for SizedCursorSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Seek for SizedCursorSource {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl MediaSource for SizedCursorSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

// ─── ProbeSeekGate — temporarily hide seekability during probing ──────────────
//
// Symphonia 0.6's `Probe::probe` scans for *trailing* metadata (ID3v1/APEv2/…)
// whenever the source reports `is_seekable() == true` and a known `byte_len()`.
// That scan seeks to the end of the stream. For a progressive ranged-HTTP source
// this forces a download all the way to EOF before the first sample can play
// (FLAC/MP3/OGG regressed to "won't start until fully downloaded").
//
// These formats are demuxed sequentially from the start, and their seek paths
// re-check `is_seekable()` dynamically, so we can advertise the source as
// non-seekable for the duration of the probe (skipping the trailing scan) and
// flip it back to seekable afterwards to preserve scrubbing. MP4/ISO-BMFF is
// excluded because its demuxer captures seekability at construction and relies
// on seeking to locate `moov` (its tail is prefetched separately instead).
pub(super) struct ProbeSeekGate {
    pub(super) inner: Box<dyn MediaSource>,
    pub(super) seekable: Arc<AtomicBool>,
}

#[cfg(test)]
#[path = "tests/source_probe_unit.rs"]
mod tests;

impl Read for ProbeSeekGate {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Seek for ProbeSeekGate {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl MediaSource for ProbeSeekGate {
    fn is_seekable(&self) -> bool {
        self.seekable.load(Ordering::Relaxed) && self.inner.is_seekable()
    }
    fn byte_len(&self) -> Option<u64> {
        self.inner.byte_len()
    }
}
