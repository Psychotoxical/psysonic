import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';

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

export interface LibraryAnalysisProgressDto {
  totalTracks: number;
  pendingTracks: number;
  doneTracks: number;
}

export interface AnalysisFailedTrackDto {
  trackId: string;
  // Wire truth from the specta contract: the Rust field `md5_16kb` under
  // `#[serde(rename_all = "camelCase")]` serialises as `md516kb`. The former
  // `md5_16kb` field here read `undefined` at runtime (latent since introduction).
  md516kb: string;
  updatedAt: number;
}

export interface AnalysisDeleteServerReportDto {
  analysisTracks: number;
  waveforms: number;
  loudness: number;
}

function serverIndexKeyForId(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (!server) return serverId;
  return serverIndexKeyFromUrl(server.url) || serverId;
}

export async function analysisGetBackfillQueueStats(): Promise<AnalysisBackfillQueueStatsDto> {
  const res = await commands.analysisGetBackfillQueueStats();
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function analysisGetPipelineQueueStats(): Promise<AnalysisPipelineQueueStatsDto> {
  const res = await commands.analysisGetPipelineQueueStats();
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryAnalysisProgress(
  serverId: string,
): Promise<LibraryAnalysisProgressDto> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.libraryAnalysisProgress(indexKey);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryCountLiveTracks(serverId: string): Promise<number> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.libraryCountLiveTracks(indexKey);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function analysisDeleteAllForServer(
  serverId: string,
): Promise<AnalysisDeleteServerReportDto> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.analysisDeleteAllForServer(indexKey);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function analysisGetFailedTrackCount(serverId: string): Promise<number> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.analysisGetFailedTrackCount(indexKey);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function analysisListFailedTracks(
  serverId: string,
  limit?: number,
): Promise<AnalysisFailedTrackDto[]> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.analysisListFailedTracks(indexKey, limit ?? null);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function analysisClearFailedTracks(
  serverId: string,
  trackIds?: string[],
): Promise<number> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.analysisClearFailedTracks(indexKey, trackIds ?? null);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export type AnalysisBackfillPriority = 'high' | 'middle' | 'low';

export async function analysisSetPipelineParallelism(workers: number): Promise<void> {
  const res = await commands.analysisSetPipelineParallelism(workers);
  if (res.status === 'error') throw new Error(res.error);
}

export type AnalysisPriorityHintDto = {
  serverId: string;
  trackId: string;
};

export async function analysisSetPlaybackPriorityHints(
  middleTrackRefs: AnalysisPriorityHintDto[],
): Promise<void> {
  const remapped = middleTrackRefs.map(ref => ({
    ...ref,
    serverId: serverIndexKeyForId(ref.serverId),
  }));
  const res = await commands.analysisSetPlaybackPriorityHints(remapped);
  if (res.status === 'error') throw new Error(res.error);
}

export async function analysisEnqueueSeedFromUrl(
  trackId: string,
  url: string,
  serverId: string,
  priority: AnalysisBackfillPriority = 'low',
): Promise<void> {
  const indexKey = serverIndexKeyForId(serverId);
  // Generated signature threads an extra `force` flag (default off) between
  // `url` and `serverId`; the FE has never forced re-seed → pass null.
  const res = await commands.analysisEnqueueSeedFromUrl(trackId, url, null, indexKey, priority);
  if (res.status === 'error') throw new Error(res.error);
}

export type LibraryAnalysisBackfillConfigureArgs = {
  enabled: boolean;
  serverIndexKey: string;
  libraryServerId: string;
  serverUrl: string;
  username: string;
  password: string;
  workers: number;
};

/** Start/stop native library analysis backfill (advanced strategy only). */
export async function libraryAnalysisBackfillConfigure(
  args: LibraryAnalysisBackfillConfigureArgs,
): Promise<void> {
  const res = await commands.libraryAnalysisBackfillConfigure(
    args.enabled,
    args.serverIndexKey,
    args.libraryServerId,
    args.serverUrl,
    args.username,
    args.password,
    args.workers,
  );
  if (res.status === 'error') throw new Error(res.error);
}
