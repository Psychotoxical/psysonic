import { invoke } from '@tauri-apps/api/core';

export interface AnalysisBackfillQueueStatsDto {
  queued: number;
  inProgressCount: number;
  inProgressTrackId: string | null;
}

export interface AnalysisPipelineQueueStatsDto {
  pipelineWorkers: number;
  httpQueued: number;
  httpQueuedHigh: number;
  httpQueuedMiddle: number;
  httpQueuedLow: number;
  httpDownloadActive: number;
  httpDownloadActiveHigh: number;
  httpDownloadActiveMiddle: number;
  httpDownloadActiveLow: number;
  cpuQueued: number;
  cpuQueuedHigh: number;
  cpuQueuedMiddle: number;
  cpuQueuedLow: number;
  cpuDecodeActive: number;
  cpuDecodeActiveHigh: number;
  cpuDecodeActiveMiddle: number;
  cpuDecodeActiveLow: number;
}

export interface LibraryAnalysisBackfillBatchDto {
  trackIds: string[];
  nextCursor: string | null;
  exhausted: boolean;
}

export const LIBRARY_ANALYSIS_BACKFILL_BATCH_SIZE = 20;

export function analysisGetBackfillQueueStats(): Promise<AnalysisBackfillQueueStatsDto> {
  return invoke<AnalysisBackfillQueueStatsDto>('analysis_get_backfill_queue_stats');
}

export function analysisGetPipelineQueueStats(): Promise<AnalysisPipelineQueueStatsDto> {
  return invoke<AnalysisPipelineQueueStatsDto>('analysis_get_pipeline_queue_stats');
}

export function libraryAnalysisBackfillBatch(
  serverId: string,
  cursor?: string | null,
  limit = LIBRARY_ANALYSIS_BACKFILL_BATCH_SIZE,
): Promise<LibraryAnalysisBackfillBatchDto> {
  return invoke<LibraryAnalysisBackfillBatchDto>('library_analysis_backfill_batch', {
    serverId,
    cursor: cursor ?? null,
    limit,
  });
}

export type AnalysisBackfillPriority = 'high' | 'middle' | 'low';

export function analysisSetPipelineParallelism(workers: number): Promise<void> {
  return invoke('analysis_set_pipeline_parallelism', { workers });
}

export type AnalysisPriorityHintDto = {
  serverId: string;
  trackId: string;
};

export function analysisSetPlaybackPriorityHints(
  middleTrackRefs: AnalysisPriorityHintDto[],
): Promise<void> {
  return invoke('analysis_set_playback_priority_hints', { middleTrackRefs });
}

export function analysisEnqueueSeedFromUrl(
  trackId: string,
  url: string,
  serverId: string,
  priority: AnalysisBackfillPriority = 'low',
): Promise<void> {
  return invoke('analysis_enqueue_seed_from_url', { trackId, url, serverId, priority });
}
