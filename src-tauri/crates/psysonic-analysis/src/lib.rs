//! `psysonic-analysis` — loudness/waveform analysis cache and the runtime
//! that drives HTTP backfill + CPU-seed work queues.
//!
//! Submodules mirror the original layout in the top crate:
//! - `analysis_cache` — SQLite-backed loudness/waveform store + compute helpers
//! - `analysis_runtime` — backfill queue, CPU-seed queue, queue snapshot loop

pub mod analysis_cache;
pub mod analysis_perf;
pub mod analysis_runtime;
mod codec;
pub mod commands;
pub mod track_analysis_plan;
pub mod track_enrichment;

// Re-export logging facade so submodules can write `crate::app_eprintln!()`
// the same way they did when they lived in the top crate.
pub use psysonic_core::{app_deprintln, app_eprintln, logging};
