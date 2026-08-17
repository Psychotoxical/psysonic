use std::io::{Read, Seek};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use symphonia::core::io::MediaSource;

use super::*;
use crate::decode::test_support::{seekable_source, synthetic_wav_bytes};

#[test]
fn probe_seek_gate_toggles_seekability() {
    let wav = synthetic_wav_bytes(0.1);
    let len = wav.len() as u64;
    let flag = Arc::new(AtomicBool::new(false));
    let gate = ProbeSeekGate {
        inner: seekable_source(wav),
        seekable: flag.clone(),
    };
    // Hidden during probe …
    assert!(!gate.is_seekable());
    // … restored afterwards.
    flag.store(true, Ordering::Relaxed);
    assert!(gate.is_seekable());
    // byte_len always passes through to the inner source.
    assert_eq!(gate.byte_len(), Some(len));
}

#[test]
fn probe_seek_gate_read_and_seek_pass_through() {
    let bytes = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
    let mut gate = ProbeSeekGate {
        inner: seekable_source(bytes),
        seekable: Arc::new(AtomicBool::new(true)),
    };
    let mut buf = [0u8; 4];
    let n = gate.read(&mut buf).expect("read");
    assert_eq!(n, 4);
    assert_eq!(&buf, &[1, 2, 3, 4]);
    let pos = gate.seek(std::io::SeekFrom::Start(6)).expect("seek");
    assert_eq!(pos, 6);
    let n = gate.read(&mut buf).expect("read after seek");
    assert_eq!(&buf[..n], &[7, 8]);
}
