import { useEffect } from 'react';
import { coverCacheStats } from '../api/coverCache';
import { coverStrategyAllowsRoutePrefetch } from '../utils/library/coverStrategy';
import { useCoverStrategyStore } from '../store/coverStrategyStore';
import { useAuthStore } from '../store/authStore';
import { coverPrefetchDrainBatch } from './prefetchRegistry';
import { coverTrafficBackgroundPaused } from './coverTraffic';
import { coverEnsureQueued } from './ensureQueue';
import { coverStorageKey } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import type { CoverArtTier } from './types';

const STEADY_POLL_MS = 1500;
const BATCH_LIMIT = 12;
/** Match dense card thumbs (~160 CSS px) — prefetch 128 wasted a full re-ensure for 512. */
const DENSE_PREFETCH_TIER = resolveCoverDisplayTier(160, { surface: 'dense' }) as CoverArtTier;

/**
 * Background cover warm-up — low rate; Rust HTTP only (never competes with webview grid fetches).
 */
export function useCoverArtPrefetch(enabled = true): void {
  const activeServerId = useAuthStore(s => s.activeServerId);
  const strategy = useCoverStrategyStore(s => s.getStrategyForServer(activeServerId));

  useEffect(() => {
    if (!enabled || !activeServerId || !coverStrategyAllowsRoutePrefetch(strategy)) return;
    let cancelled = false;

    void (async () => {
      while (!cancelled) {
        if (coverTrafficBackgroundPaused()) {
          await new Promise(r => setTimeout(r, STEADY_POLL_MS));
          continue;
        }

        const stats = await coverCacheStats().catch(() => null);
        if (stats && !stats.autoDownloadEnabled) {
          await new Promise(r => setTimeout(r, STEADY_POLL_MS * 2));
          continue;
        }

        const batch = coverPrefetchDrainBatch(BATCH_LIMIT);
        if (batch.length > 0) {
          await Promise.all(
            batch.map(ref => {
              const key = coverStorageKey(ref.serverScope, ref.coverArtId, DENSE_PREFETCH_TIER);
              return coverEnsureQueued(key, ref, DENSE_PREFETCH_TIER, 'low');
            }),
          );
        }

        await new Promise(r => setTimeout(r, STEADY_POLL_MS));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, activeServerId, strategy]);
}
