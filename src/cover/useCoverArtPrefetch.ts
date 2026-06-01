import { useEffect } from 'react';
import { coverCacheStats } from '../api/coverCache';
import { coverStrategyAllowsRoutePrefetch } from '../utils/library/coverStrategy';
import { useCoverStrategyStore } from '../store/coverStrategyStore';
import { useAuthStore } from '../store/authStore';
import { coverPrefetchDrainBatch } from './prefetchRegistry';
import { coverTrafficBackgroundPaused } from './coverTraffic';
import { coverEnsureQueued } from './ensureQueue';
import { coverStorageKeyFromRef } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import type { CoverArtTier } from './types';

const STEADY_POLL_MS = 1500;
/** Full cover-root disk walk — idle only, not every prefetch tick. */
const STATS_IDLE_POLL_MS = 30_000;
const BATCH_LIMIT = 12;
/** Match dense card thumbs (~160 CSS px) — prefetch 128 wasted a full re-ensure for 512. */
const DENSE_PREFETCH_TIER = resolveCoverDisplayTier(160, { surface: 'dense' }) as CoverArtTier;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

/**
 * Background cover warm-up — low rate; Rust HTTP only (never competes with webview grid fetches).
 * Registry drains run without `cover_cache_stats` (full disk walk); stats run rarely when idle.
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
          if (autoDownloadEnabled) {
            await Promise.all(
              batch.map(ref => {
                const key = coverStorageKeyFromRef(ref, DENSE_PREFETCH_TIER);
                return coverEnsureQueued(key, ref, DENSE_PREFETCH_TIER, 'low');
              }),
            );
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
