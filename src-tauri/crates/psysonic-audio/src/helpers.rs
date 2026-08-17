//! URL identity, loudness cache resolution, fetch, gain math, and stream analysis helpers.

mod fetch;
mod format_hint;
mod gain;
mod identity;
mod stream_spill;
mod volume_ramp;

use serde::Serialize;

pub(crate) use fetch::{fetch_data, fetch_http_data};
pub(crate) use format_hint::{
    content_type_to_hint, format_hint_from_content_disposition, normalize_audio_extension_for_hint,
    normalize_stream_suffix_for_hint, resolve_playback_format_hint, sniff_stream_format_extension,
    STREAM_FORMAT_SNIFF_PROBE_BYTES,
};
#[allow(unused_imports)]
pub(crate) use gain::{
    compute_gain, current_playback_server_id_str, gain_linear_to_db,
    loudness_gain_db_after_resolve, loudness_gain_placeholder_until_cache,
    loudness_pre_analysis_db_for_engine, loudness_ui_current_gain_db, normalization_engine_name,
    provisional_loudness_gain_from_progress, resolve_loudness_gain_from_cache,
    resolve_loudness_gain_from_cache_impl, resolve_loudness_gain_with_cache,
    resolve_track_gain_inputs, ResolveLoudnessCacheOpts, TrackGainInputs, MASTER_HEADROOM,
    PARTIAL_LOUDNESS_EMIT_INTERVAL_MS, PARTIAL_LOUDNESS_MIN_BYTES,
};
pub(crate) use identity::{analysis_cache_track_id, playback_identity, same_playback_target};
pub use stream_spill::{
    cleanup_orphan_stream_spill_dir, take_stream_completed_for_url,
    take_stream_completed_spill_for_url,
};
#[allow(unused_imports)]
pub(crate) use stream_spill::{
    install_stream_completed_spill_if, stream_spill_file_paths,
    take_stream_completed_spill_from_slot, write_stream_spill_bytes_in_dir,
    write_stream_spill_file,
};
pub(crate) use volume_ramp::{
    cancel_sink_volume_ramp, cancel_transport_sink_volume_ramp, ramp_sink_volume,
    ramp_sink_volume_over_secs, ramp_sink_volume_smooth_over_secs_then, sink_volume_now,
};

#[derive(Clone, Serialize)]
pub struct ProgressPayload {
    pub current_time: f64,
    pub duration: f64,
    /// HTTP stream still filling its play buffer — UI must not extrapolate
    /// progress until this clears.
    pub buffering: bool,
}
