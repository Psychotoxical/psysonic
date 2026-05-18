//! `AudioStreamReader` — bridges an SPSC ring buffer (`HeapCons<u8>`) into the
//! synchronous `std::io::Read` interface that Symphonia requires.
//!
//! Designed to run inside `tokio::task::spawn_blocking`.
//!
//! - Empty buffer:  sleeps `RADIO_YIELD_MS` ms, retries. Never busy-spins.
//! - Timeout:       after `RADIO_READ_TIMEOUT_SECS` with no data → `TimedOut`.
//! - Generation:    if `gen_arc` != `self.gen` → `Ok(0)` (EOF; new track started).
//! - Reconnect:     `audio_resume` sends a fresh `HeapCons` via `new_cons_rx`.
//!   On the next read() we drain the channel (keep latest) and swap.

use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ringbuf::HeapCons;
use ringbuf::traits::{Consumer, Observer};
use symphonia::core::io::MediaSource;

use super::{RADIO_YIELD_MS};

pub(crate) struct AudioStreamReader {
    pub(crate) read_timeout_secs: u64,
    pub(crate) cons: Mutex<HeapCons<u8>>,
    /// Delivers fresh consumers on hard-pause reconnect (unbounded; drain to latest).
    /// Wrapped in Mutex so AudioStreamReader is Sync (required by symphonia::MediaSource).
    /// No real contention: only the audio thread ever calls read().
    pub(crate) new_cons_rx: Mutex<std::sync::mpsc::Receiver<HeapCons<u8>>>,
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
        let mut newest: Option<HeapCons<u8>> = None;
        while let Ok(c) = self.new_cons_rx.lock().unwrap().try_recv() {
            newest = Some(c);
        }
        if let Some(c) = newest {
            *self.cons.lock().unwrap() = c;
            self.deadline =
                std::time::Instant::now() + Duration::from_secs(self.read_timeout_secs);
        }
        loop {
            if self.gen_arc.load(Ordering::SeqCst) != self.gen {
                return Ok(0);
            }
            let available = self.cons.lock().unwrap().occupied_len();
            if available > 0 {
                let n = buf.len().min(available);
                let read = self.cons.lock().unwrap().pop_slice(&mut buf[..n]);
                self.pos += read as u64;
                // Reset deadline: data arrived, so connection is alive.
                self.deadline =
                    std::time::Instant::now() + Duration::from_secs(self.read_timeout_secs);
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
                    self.read_timeout_secs
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
