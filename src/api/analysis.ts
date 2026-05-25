import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import { serverIndexKeyFromUrl } from '../utils/server/serverIndexKey';

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

export interface LibraryAnalysisProgressDto {
  totalTracks: number;
  pendingTracks: number;
  doneTracks: number;
}

export interface AnalysisFailedTrackDto {
  trackId: string;
  md5_16kb: string;
  updatedAt: number;
}

export interface AnalysisDeleteServerReportDto {
  analysisTracks: number;
  waveforms: number;
  loudness: number;
}

export const LIBRARY_ANALYSIS_BACKFILL_BATCH_SIZE = 20;

function serverIndexKeyForId(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (!server) return serverId;
  return serverIndexKeyFromUrl(server.url) || serverId;
}

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
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<LibraryAnalysisBackfillBatchDto>('library_analysis_backfill_batch', {
    serverId: indexKey,
    cursor: cursor ?? null,
    limit,
  });
}

export function libraryAnalysisProgress(
  serverId: string,
): Promise<LibraryAnalysisProgressDto> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<LibraryAnalysisProgressDto>('library_analysis_progress', { serverId: indexKey });
}

export function libraryCountLiveTracks(serverId: string): Promise<number> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<number>('library_count_live_tracks', { serverId: indexKey });
}

export function analysisDeleteAllForServer(
  serverId: string,
): Promise<AnalysisDeleteServerReportDto> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<AnalysisDeleteServerReportDto>('analysis_delete_all_for_server', { serverId: indexKey });
}

export function analysisGetFailedTrackCount(serverId: string): Promise<number> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<number>('analysis_get_failed_track_count', { serverId: indexKey });
}

export function analysisListFailedTracks(
  serverId: string,
  limit?: number,
): Promise<AnalysisFailedTrackDto[]> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<AnalysisFailedTrackDto[]>('analysis_list_failed_tracks', {
    serverId: indexKey,
    limit: limit ?? null,
  });
}

export function analysisClearFailedTracks(
  serverId: string,
  trackIds?: string[],
): Promise<number> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<number>('analysis_clear_failed_tracks', {
    serverId: indexKey,
    trackIds: trackIds ?? null,
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
  const remapped = middleTrackRefs.map(ref => ({
    ...ref,
    serverId: serverIndexKeyForId(ref.serverId),
  }));
  return invoke('analysis_set_playback_priority_hints', { middleTrackRefs: remapped });
}

export function analysisEnqueueSeedFromUrl(
  trackId: string,
  url: string,
  serverId: string,
  priority: AnalysisBackfillPriority = 'low',
): Promise<void> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke('analysis_enqueue_seed_from_url', { trackId, url, serverId: indexKey, priority });
}
