//! Unified client-side track analysis plan (waveform / LUFS / enrichment facts).
//!
//! Planning logic lives in `psysonic-analysis::track_analysis_plan`; this module
//! holds the shared outcome type so future analysis modes can extend the plan
//! without pulling analysis-cache types into every crate.

use crate::track_enrichment::TrackEnrichmentPlan;

/// What still needs to be computed for a track at the current content fingerprint.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TrackAnalysisPlan {
    /// Waveform bins missing for `(server_id, track_id)` at the current algo version.
    pub need_waveform: bool,
    /// Integrated LUFS / true-peak row missing.
    pub need_loudness: bool,
    /// Oximedia BPM + mood facts (`track_fact` via library enrichment port).
    pub enrichment: TrackEnrichmentPlan,
}

impl TrackAnalysisPlan {
    pub fn any(self) -> bool {
        self.need_waveform || self.need_loudness || self.enrichment.any()
    }

    /// Symphonia full-file decode (waveform and/or EBU R128 loudness).
    pub fn needs_full_cpu_seed(self) -> bool {
        self.need_waveform || self.need_loudness
    }

    /// Oximedia 60 s center window only — waveform + loudness already cached.
    pub fn needs_enrichment_only(self) -> bool {
        !self.needs_full_cpu_seed() && self.enrichment.any()
    }
}
