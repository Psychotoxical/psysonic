import { invoke } from '@tauri-apps/api/core';
import { usePlayerStore } from '../store/playerStore';
import { hotCacheFrontendDebug } from './helpers';

let analysisPruneTimer: ReturnType<typeof setTimeout> | null = null;
let lastAnalysisPruneSig = '';
const ANALYSIS_PRUNE_DEBOUNCE_MS = 1200;

type AnalysisPrunePendingResult = {
  keepCount: number;
  httpRemoved: number;
  cpuRemovedJobs: number;
  cpuRemovedWaiters: number;
};

export function scheduleAnalysisQueuePruneFromPlaybackQueue(): void {
  const { queue, currentTrack } = usePlayerStore.getState();
  const keepTrackIds: string[] = [];
  const seen = new Set<string>();
  const pushId = (id: string | undefined | null) => {
    if (!id) return;
    const tid = id.trim();
    if (!tid || seen.has(tid)) return;
    seen.add(tid);
    keepTrackIds.push(tid);
  };
  pushId(currentTrack?.id);
  for (const track of queue) {
    pushId(track.id);
    if (keepTrackIds.length >= 1000) break;
  }
  const sig = JSON.stringify(keepTrackIds);
  if (sig === lastAnalysisPruneSig) return;
  lastAnalysisPruneSig = sig;
  if (analysisPruneTimer) {
    clearTimeout(analysisPruneTimer);
    analysisPruneTimer = null;
  }
  analysisPruneTimer = setTimeout(() => {
    analysisPruneTimer = null;
    void invoke<AnalysisPrunePendingResult>('analysis_prune_pending_to_track_ids', { trackIds: keepTrackIds })
      .then(result => {
        if (!result) return;
        hotCacheFrontendDebug({
          event: 'analysis-prune',
          keepCount: result.keepCount,
          removedHttp: result.httpRemoved,
          removedCpuJobs: result.cpuRemovedJobs,
          removedCpuWaiters: result.cpuRemovedWaiters,
        });
      })
      .catch(() => {});
  }, ANALYSIS_PRUNE_DEBOUNCE_MS);
}

/** Tear-down for the analysis-prune state — used by initHotCachePrefetch's cleanup. */
export function resetAnalysisPruneState(): void {
  if (analysisPruneTimer) clearTimeout(analysisPruneTimer);
  analysisPruneTimer = null;
  lastAnalysisPruneSig = '';
}
