use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use symphonia::core::io::MediaSource;

use super::super::RangedHttpSource;

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
        tail_ready: Arc::new(AtomicBool::new(true)),
        tail_filled_from: Arc::new(AtomicU64::new(0)),
        total_size: total,
        pos: 0,
        done,
        gen_arc,
        gen: 7,
        on_demand: None,
    }
}

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
        tail_ready: Arc::new(AtomicBool::new(false)),
        tail_filled_from: Arc::new(AtomicU64::new(0)),
        total_size: total,
        pos: 0,
        done,
        gen_arc,
        gen: 1,
        on_demand: None,
    };
    let mut out = [0u8; 8];
    let n = src.read(&mut out).unwrap();
    assert_eq!(n, 5, "returns only the bytes that arrived before EOF");
    assert_eq!(&out[..5], &[1, 2, 3, 4, 5]);
    assert_eq!(src.pos, 5);
}

#[test]
fn read_blocks_until_download_progress_reaches_seek_target() {
    let total: u64 = 8;
    let buf = Arc::new(Mutex::new(vec![1, 2, 3, 4, 5, 6, 7, 8]));
    let downloaded_to = Arc::new(AtomicUsize::new(2));
    let done = Arc::new(AtomicBool::new(false));
    let gen_arc = Arc::new(AtomicU64::new(1));
    let dl_bg = downloaded_to.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        dl_bg.store(8, Ordering::SeqCst);
    });
    let mut src = RangedHttpSource {
        buf,
        downloaded_to,
        tail_ready: Arc::new(AtomicBool::new(false)),
        tail_filled_from: Arc::new(AtomicU64::new(0)),
        total_size: total,
        pos: 6,
        done,
        gen_arc,
        gen: 1,
        on_demand: None,
    };
    let mut out = [0u8; 2];
    let n = src.read(&mut out).unwrap();
    assert_eq!(n, 2);
    assert_eq!(out, [7, 8]);
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
        tail_ready: Arc::new(AtomicBool::new(false)),
        tail_filled_from: Arc::new(AtomicU64::new(0)),
        total_size: total,
        pos: 5, // past downloaded_to
        done,
        gen_arc,
        gen: 1,
        on_demand: None,
    };
    let mut out = [0u8; 8];
    assert_eq!(src.read(&mut out).unwrap(), 0);
}

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
