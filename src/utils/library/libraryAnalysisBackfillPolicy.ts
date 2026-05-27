import type { AnalysisPipelineQueueStatsDto } from '../../api/analysis';
import { LIBRARY_ANALYSIS_BACKFILL_BATCH_SIZE } from '../../api/analysis';

/** Target backlog ≈ workers × multiplier (min floor, max cap). */
export const LIBRARY_BACKLOG_DEPTH_MULTIPLIER = 3;
export const LIBRARY_BACKLOG_MIN = 8;
export const LIBRARY_BACKLOG_MAX = 240;

export function computeLibraryBackfillTargetDepth(workers: number): number {
  const w = Math.max(1, Math.round(workers));
  return Math.min(
    LIBRARY_BACKLOG_MAX,
    Math.max(LIBRARY_BACKLOG_MIN, w * LIBRARY_BACKLOG_DEPTH_MULTIPLIER),
  );
}

type PipelineBacklogStats = Pick<
  AnalysisPipelineQueueStatsDto,
  'httpQueued' | 'httpDownloadActive' | 'cpuQueued' | 'cpuDecodeActive'
>;

/** HTTP + in-flight CPU seed jobs (decode backpressure must not look like an empty pipeline). */
export function libraryBackfillPipelineBacklog(stats: PipelineBacklogStats): number {
  return (
    stats.httpQueued
    + stats.httpDownloadActive
    + stats.cpuQueued
    + stats.cpuDecodeActive
  );
}

export function libraryBackfillNeedsTopUp(stats: PipelineBacklogStats, workers: number): boolean {
  return libraryBackfillPipelineBacklog(stats) < computeLibraryBackfillTargetDepth(workers);
}

export function libraryBackfillTopUpLimit(stats: PipelineBacklogStats, workers: number): number {
  const target = computeLibraryBackfillTargetDepth(workers);
  const deficit = target - libraryBackfillPipelineBacklog(stats);
  if (deficit <= 0) return 0;
  return Math.min(LIBRARY_ANALYSIS_BACKFILL_BATCH_SIZE, deficit);
}
