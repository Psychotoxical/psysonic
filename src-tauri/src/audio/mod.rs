//! Audio playback: Symphonia decode, rodio output, HTTP radio/streaming, gapless, previews.
//!
//! Implementation is split into submodules (`sources`, `decode`, `stream`, `commands`, …)
//! for navigation; behavior matches the historical single `audio.rs` file.

mod codec;
pub mod commands;
mod decode;
mod dev_io;
mod device_watcher;
mod engine;
mod helpers;
mod ipc;
pub mod preview;
mod sources;
mod state;
mod stream;

pub use commands::{audio_default_output_device_name, audio_list_devices_for_engine};
pub use device_watcher::start_device_watcher;
pub use engine::{create_engine, refresh_http_user_agent, AudioEngine};
pub use helpers::take_stream_completed_for_url;

pub(crate) use engine::{analysis_track_id_is_current_playback, ranged_loudness_backfill_should_defer};
