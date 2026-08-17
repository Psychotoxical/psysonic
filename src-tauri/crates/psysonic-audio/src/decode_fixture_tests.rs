//! Fixture-backed decoder tests, grouped by playback domain under `decode/tests`.

use std::io::{Cursor, Read, Seek};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::Source;
use symphonia::core::{
    formats::probe::Hint,
    formats::FormatOptions,
    io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions},
    meta::MetadataOptions,
};

use super::builders::{build_source, build_streaming_source, BuiltSource};
use super::decoder::{should_use_builtin_gapless, SizedDecoder};
use super::gapless::parse_gapless_info;
use super::source_probe::SizedCursorSource;
use super::test_support::{build_pcm16_wav, synth_itunsmpb_blob, synthetic_wav_bytes};
use crate::playback_rate::PlaybackRateAtomics;

#[path = "decode/tests/fixture_support.rs"]
mod support;
