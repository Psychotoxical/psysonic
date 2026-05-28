//! Library analysis backfill queue watermark — native coordinator (spec: Settings → Library).

pub const LIBRARY_BACKLOG_DEPTH_MULTIPLIER: u32 = 3;
pub const LIBRARY_BACKLOG_MIN: u32 = 8;
pub const LIBRARY_BACKLOG_MAX: u32 = 240;
pub const LIBRARY_ANALYSIS_BACKFILL_BATCH_SIZE: u32 = 20;

#[derive(Debug, Clone, Copy, Default)]
pub struct PipelineBacklogCounts {
    pub http_queued: u32,
    pub http_download_active: u32,
    pub cpu_queued: u32,
    pub cpu_decode_active: u32,
}

impl PipelineBacklogCounts {
    pub fn total(self) -> u32 {
        self.http_queued
            .saturating_add(self.http_download_active)
            .saturating_add(self.cpu_queued)
            .saturating_add(self.cpu_decode_active)
    }
}

pub fn compute_library_backfill_target_depth(workers: u32) -> u32 {
    let w = workers.max(1);
    (w * LIBRARY_BACKLOG_DEPTH_MULTIPLIER).clamp(LIBRARY_BACKLOG_MIN, LIBRARY_BACKLOG_MAX)
}

pub fn library_backfill_needs_top_up(counts: PipelineBacklogCounts, workers: u32) -> bool {
    counts.total() < compute_library_backfill_target_depth(workers)
}

pub fn library_backfill_top_up_limit(counts: PipelineBacklogCounts, workers: u32) -> u32 {
    let target = compute_library_backfill_target_depth(workers);
    let deficit = target.saturating_sub(counts.total());
    if deficit == 0 {
        return 0;
    }
    deficit.min(LIBRARY_ANALYSIS_BACKFILL_BATCH_SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_depth_uses_floor_and_cap() {
        assert_eq!(compute_library_backfill_target_depth(1), 8);
        assert_eq!(compute_library_backfill_target_depth(4), 12);
        assert_eq!(compute_library_backfill_target_depth(100), 240);
    }

    #[test]
    fn top_up_when_backlog_below_target() {
        let counts = PipelineBacklogCounts {
            http_queued: 2,
            http_download_active: 1,
            ..Default::default()
        };
        assert!(library_backfill_needs_top_up(counts, 8));
        assert_eq!(library_backfill_top_up_limit(counts, 8), 20);
    }
}
