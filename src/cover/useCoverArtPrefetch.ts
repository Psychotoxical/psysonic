import { useEffect } from 'react';
import { coverCacheStats } from '@/lib/api/coverCache';
import { coverStrategyAllowsRoutePrefetch } from '@/lib/library/coverStrategy';
import { useCoverStrategyStore } from '../store/coverStrategyStore';
import { useAuthStore } from '../store/authStore';
import { coverPrefetchDrainBatch } from './prefetchRegistry';
import { coverTrafficBackgroundPaused } from './coverTraffic';
import { coverEnsureQueued, coverEnsureQueueStats } from './ensureQueue';
import { getDiskSrcForGrid } from './diskSrcLookup';
import { coverStorageKeyFromRef } from './storageKeys';
import { warmCoverDiskSrcBatch, type CoverWarmItem } from './warmDiskPeek';
import { resolveCoverDisplayTier } from './tiers';
import type { CoverArtRef, CoverArtTier } from './types';

const STEADY_POLL_MS = 1500;
/** Full cover-root disk walk — idle only, not every prefetch tick. */
const STATS_IDLE_POLL_MS = 30_000;
const BATCH_LIMIT = 12;
/** Match dense card thumbs (~160 CSS px) — prefetch 128 wasted a full re-ensure for 512. */
const DENSE_PREFETCH_TIER = resolveCoverDisplayTier(160, { surface: 'dense' }) as CoverArtTier;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function batchWarmItems(refs: CoverArtRef[]): CoverWarmItem[] {
  return refs.map(ref => ({
    ref,
    tier: DENSE_PREFETCH_TIER,
    storageKey: coverStorageKeyFromRef(ref, DENSE_PREFETCH_TIER),
  }));
}

/** Back off while viewport cells are waiting on high-priority ensures. */
function prefetchShouldYieldToViewport(): boolean {
  const { queuedHigh, inflight, maxInflight } = coverEnsureQueueStats();
  return queuedHigh > 0 || inflight >= maxInflight - 1;
}

/**
 * Background cover warm-up — low rate; Rust HTTP only (never competes with webview grid fetches).
 * Registry drains: batched disk peek first (cached WebP → diskSrcCache), ensure only for misses.
 * Stats (`cover_cache_stats` disk walk) run rarely when the registry is idle.
 */
export function useCoverArtPrefetch(enabled = true): void {
  const activeServerId = useAuthStore(s => s.activeServerId);
  const strategy = useCoverStrategyStore(s => s.getStrategyForServer(activeServerId));

  useEffect(() => {
    if (!enabled || !activeServerId || !coverStrategyAllowsRoutePrefetch(strategy)) return;
    let cancelled = false;
    let lastStatsAt = 0;
    let autoDownloadEnabled = true;

    void (async () => {
      while (!cancelled) {
        if (coverTrafficBackgroundPaused()) {
          await sleep(STEADY_POLL_MS);
          continue;
        }

        const batch = coverPrefetchDrainBatch(BATCH_LIMIT);
        if (batch.length > 0) {
          if (prefetchShouldYieldToViewport()) {
            await sleep(STEADY_POLL_MS);
            continue;
          }

          await warmCoverDiskSrcBatch(batchWarmItems(batch));

          if (autoDownloadEnabled) {
            const misses = batch.filter(ref => !getDiskSrcForGrid(ref, DENSE_PREFETCH_TIER));
            if (misses.length > 0) {
              await Promise.all(
                misses.map(ref => {
                  const key = coverStorageKeyFromRef(ref, DENSE_PREFETCH_TIER);
                  return coverEnsureQueued(key, ref, DENSE_PREFETCH_TIER, 'low');
                }),
              );
            }
          }
          await sleep(STEADY_POLL_MS);
          continue;
        }

        const now = Date.now();
        if (now - lastStatsAt >= STATS_IDLE_POLL_MS) {
          const stats = await coverCacheStats().catch(() => null);
          lastStatsAt = now;
          autoDownloadEnabled = stats?.autoDownloadEnabled ?? true;
        }

        await sleep(STEADY_POLL_MS);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, activeServerId, strategy]);
}
