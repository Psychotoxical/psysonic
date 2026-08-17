//! `RangedHttpSource` — seekable HTTP-backed `MediaSource`, plus its
//! background `ranged_download_task` linear filler.
//!
//! The facade keeps the existing stream-module call paths stable while the
//! source, downloader, range requests, MP4 tail handling, and tests live in
//! focused child modules.

mod downloader;
mod mp4_tail;
mod range_task;
mod source;

pub(crate) use downloader::ranged_download_task;
pub(crate) use source::{OnDemand, RangedHttpSource};

#[cfg(test)]
mod tests;
