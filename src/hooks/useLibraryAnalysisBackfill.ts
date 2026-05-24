import { useEffect, useRef } from 'react';
import { buildStreamUrlForServer } from '../api/subsonicStreamUrl';
import {
  analysisEnqueueSeedFromUrl,
  analysisGetPipelineQueueStats,
  analysisSetPipelineParallelism,
  libraryAnalysisBackfillBatch,
} from '../api/analysis';
import { useAuthStore } from '../store/authStore';
import { useAnalysisStrategyStore } from '../store/analysisStrategyStore';
import { DEFAULT_ADVANCED_PARALLELISM } from '../utils/library/analysisStrategy';
import {
  libraryBackfillNeedsTopUp,
  libraryBackfillTopUpLimit,
} from '../utils/library/libraryAnalysisBackfillPolicy';
import { libraryIsReady } from '../utils/library/libraryReady';

const TOP_UP_POLL_MS = 500;
const STEADY_POLL_MS = 2000;
const READY_POLL_MS = 5000;
const EXHAUSTED_PAUSE_MS = 60_000;

const EMPTY_PIPELINE_STATS = {
  pipelineWorkers: 1,
  httpQueued: 0,
  httpQueuedHigh: 0,
  httpQueuedMiddle: 0,
  httpQueuedLow: 0,
  httpDownloadActive: 0,
  httpDownloadActiveHigh: 0,
  httpDownloadActiveMiddle: 0,
  httpDownloadActiveLow: 0,
  cpuQueued: 0,
  cpuQueuedHigh: 0,
  cpuQueuedMiddle: 0,
  cpuQueuedLow: 0,
  cpuDecodeActive: 0,
  cpuDecodeActiveHigh: 0,
  cpuDecodeActiveMiddle: 0,
  cpuDecodeActiveLow: 0,
};

/**
 * Advanced analytics strategy: keep the HTTP backfill backlog above worker count
 * (watermark target ≈ workers × 3) so parallel downloads stay busy. Library
 * tracks enqueue at low priority; playback tiers stay ahead in Rust.
 */
export function useLibraryAnalysisBackfill(enabled = true): void {
  const activeServerId = useAuthStore(s => s.activeServerId);
  const strategy = useAnalysisStrategyStore(s => s.getStrategyForServer(activeServerId));
  const advancedParallelism = useAnalysisStrategyStore(
    s => s.getAdvancedParallelismForServer(activeServerId),
  );
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const workers =
      strategy === 'advanced' ? advancedParallelism : DEFAULT_ADVANCED_PARALLELISM;
    void analysisSetPipelineParallelism(workers).catch(() => {});
  }, [strategy, advancedParallelism, enabled]);

  useEffect(() => {
    if (!enabled || strategy !== 'advanced' || !activeServerId) return;

    let cancelled = false;
    const serverId = activeServerId;

    void (async () => {
      while (!cancelled) {
        if (!(await libraryIsReady(serverId))) {
          await new Promise(r => setTimeout(r, READY_POLL_MS));
          continue;
        }

        const workers = advancedParallelism;
        const stats = await analysisGetPipelineQueueStats().catch(
          () => EMPTY_PIPELINE_STATS,
        );

        if (!libraryBackfillNeedsTopUp(stats, workers)) {
          await new Promise(r => setTimeout(r, STEADY_POLL_MS));
          continue;
        }

        const fetchLimit = libraryBackfillTopUpLimit(stats, workers);
        if (fetchLimit <= 0) {
          await new Promise(r => setTimeout(r, TOP_UP_POLL_MS));
          continue;
        }

        const batch = await libraryAnalysisBackfillBatch(
          serverId,
          cursorRef.current,
          fetchLimit,
        ).catch(() => null);

        if (!batch || cancelled) {
          await new Promise(r => setTimeout(r, TOP_UP_POLL_MS));
          continue;
        }

        cursorRef.current = batch.nextCursor;

        await Promise.all(
          batch.trackIds.map(trackId =>
            analysisEnqueueSeedFromUrl(
              trackId,
              buildStreamUrlForServer(serverId, trackId),
              serverId,
              'low',
            ).catch(() => {
              /* Rust skips completed tracks */
            }),
          ),
        );

        if (cancelled) return;

        if (batch.exhausted) {
          cursorRef.current = null;
          await new Promise(r => setTimeout(r, EXHAUSTED_PAUSE_MS));
        } else if (batch.trackIds.length === 0) {
          await new Promise(r => setTimeout(r, TOP_UP_POLL_MS));
        }
        // else: loop immediately if still below watermark
      }
    })();

    return () => {
      cancelled = true;
      cursorRef.current = null;
    };
  }, [strategy, activeServerId, advancedParallelism, enabled]);
}
