mod backfill_queue;
mod cpu_seed;
mod enqueue;
mod http_backfill;
mod trusted_revision;
mod types;

pub use backfill_queue::{
    analysis_backfill_shared, AnalysisBackfillQueueState, AnalysisBackfillShared,
    PlaybackPriorityHints,
};
pub use cpu_seed::{
    analysis_backfill_queue_stats, analysis_pipeline_queue_stats, analysis_queue_snapshot_loop,
    analysis_revision_in_cpu_pipeline, analysis_set_pipeline_parallelism,
    analysis_track_in_cpu_pipeline, clear_analysis_backfill_failure_state, prune_analysis_queues,
};
pub use enqueue::{
    analysis_backfill_is_current_track, analysis_backfill_resolve_priority,
    analysis_emits_ui_events, enqueue_analysis_seed, enqueue_offline_library_analysis_from_file,
    enqueue_seed_from_url, enqueue_track_analysis, enqueue_track_analysis_from_file,
    enqueue_track_analysis_trusted, enqueue_track_analysis_trusted_owned,
    run_track_enrichment_from_bytes, track_analysis_needs_work,
};
pub(crate) use trusted_revision::commit_trusted_enrichment_if_current;
pub use trusted_revision::{
    begin_trusted_revision, reserve_trusted_analysis_fetch, TrustedAnalysisFetchPermit,
};
pub use types::*;

#[cfg(test)]
mod tests {
    mod backfill_queue;
    mod cpu_seed;
    mod http_backfill;
    mod trusted_revision;
}
