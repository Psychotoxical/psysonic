import { useEffect } from 'react';
import { coverCacheStats } from '../api/coverCache';
import { useAuthStore } from '../store/authStore';
import { coverPrefetchDrainBatch } from './prefetchRegistry';
import { coverEnsureQueued } from './ensureQueue';
import { coverStorageKey } from './storageKeys';
import type { CoverArtTier } from './types';

const STEADY_POLL_MS = 2000;
const BATCH_LIMIT = 8;
const DENSE_PREFETCH_TIER = 128 as CoverArtTier;

/**
 * Background cover warm-up — low rate; Rust HTTP only (never competes with webview grid fetches).
 */
export function useCoverArtPrefetch(enabled = true): void {
  const activeServerId = useAuthStore(s => s.activeServerId);

  useEffect(() => {
    if (!enabled || !activeServerId) return;
    let cancelled = false;

    void (async () => {
      while (!cancelled) {
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
  }, [enabled, activeServerId]);
}
