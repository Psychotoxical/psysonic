#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformUpdatedPayload {
    pub track_id: String,
    pub server_index_key: String,
    pub is_partial: bool,
}

pub const ANALYSIS_PIPELINE_PARALLELISM_MIN: usize = 1;
pub const ANALYSIS_PIPELINE_PARALLELISM_MAX: usize = 20;
pub const ANALYSIS_PIPELINE_PARALLELISM_DEFAULT: usize = 1;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AnalysisTierCounts {
    pub high: usize,
    pub middle: usize,
    pub low: usize,
}

impl AnalysisTierCounts {
    pub fn total(&self) -> usize {
        self.high + self.middle + self.low
    }
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisPipelineQueueStatsDto {
    pub pipeline_workers: u32,
    pub http_queued: usize,
    pub http_queued_high: usize,
    pub http_queued_middle: usize,
    pub http_queued_low: usize,
    pub http_download_active: usize,
    pub http_download_active_high: usize,
    pub http_download_active_middle: usize,
    pub http_download_active_low: usize,
    pub cpu_queued: usize,
    pub cpu_queued_high: usize,
    pub cpu_queued_middle: usize,
    pub cpu_queued_low: usize,
    pub cpu_decode_active: usize,
    pub cpu_decode_active_high: usize,
    pub cpu_decode_active_middle: usize,
    pub cpu_decode_active_low: usize,
}

pub fn clamp_pipeline_parallelism(workers: usize) -> usize {
    workers.clamp(
        ANALYSIS_PIPELINE_PARALLELISM_MIN,
        ANALYSIS_PIPELINE_PARALLELISM_MAX,
    )
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AnalysisBackfillPriority {
    Low = 0,
    Middle = 1,
    High = 2,
}

impl AnalysisBackfillPriority {
    pub fn from_optional_str(raw: Option<&str>) -> Option<Self> {
        let s = raw?.trim();
        if s.is_empty() {
            return None;
        }
        match s.to_ascii_lowercase().as_str() {
            "high" => Some(Self::High),
            "middle" => Some(Self::Middle),
            "low" => Some(Self::Low),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisBackfillEnqueueKind {
    NewLow,
    NewMiddle,
    NewHigh,
    /// Same track was already waiting; moved to a higher tier with the latest URL.
    ReorderedHigher,
    /// Same or lower priority while the track is already queued or running.
    DuplicateSkipped,
    /// High-priority request but that track is already being downloaded+seeded.
    RunningSkipped,
    /// Automatic backfill recently failed before CPU admission.
    RetryDeferred,
    /// Automatic backfill is cooling down after a terminal failure.
    TerminalSkipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum EnqueueSeedFromUrlOutcome {
    Enqueued,
    AlreadyReserved,
    Skipped,
    Unsupported,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedAnalysisRevision {
    pub md5_16kb: String,
    pub generation: u64,
    /// The analysis bytes are a server transcode whose original identity was
    /// established independently through the raw-prefix probe.
    pub analysis_bytes_transcoded: bool,
    /// Library `track.server_id` scope for `content_hash` repair when it differs
    /// from the analysis-cache scope (offline dual-address/library paths).
    pub content_hash_server_id: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueTrackAnalysisOutcome {
    /// Waveform, LUFS, and enrichment facts are all current.
    Complete,
    /// Symphonia full-file decode queued (enrichment runs after seed when needed).
    QueuedFullSeed,
    /// Oximedia pass ran inline (waveform + LUFS already cached).
    RanEnrichmentOnly,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisCpuSeedEnqueueKind {
    NewLow,
    NewMiddle,
    NewHigh,
    ReorderedHigher,
    RunningFollower,
    MergedQueued,
}
