import { useEffect, useRef } from 'react';
import { coverCacheEnsure, coverCacheStats } from '../api/coverCache';
import { useAuthStore } from '../store/authStore';
import { libraryIsReady } from '../utils/library/libraryReady';
import { coverArtRef } from './ref';
import { coverPrefetchDrainBatch } from './prefetchRegistry';
import type { CoverArtRef, CoverArtTier } from './types';

const STEADY_POLL_MS = 8000;
const BATCH_LIMIT = 4;
const DENSE_PREFETCH_TIER = 128 as CoverArtTier;
const ENSURE_GAP_MS = 400;

async function ensureSequential(refs: CoverArtRef[], tier: CoverArtTier): Promise<void> {
  for (const ref of refs) {
    await coverCacheEnsure(ref, tier, 'low').catch(() => {});
    await new Promise(r => setTimeout(r, ENSURE_GAP_MS));
  }
}

/**
 * Background cover warm-up — low rate; Rust HTTP only (never competes with webview grid fetches).
 */
export function useCoverArtPrefetch(enabled = true): void {
  const activeServerId = useAuthStore(s => s.activeServerId);
  const idleRoundsRef = useRef(0);

  useEffect(() => {
    if (!enabled || !activeServerId) return;
    let cancelled = false;

    void (async () => {
      while (!cancelled) {
        if (!libraryIsReady(activeServerId)) {
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
          idleRoundsRef.current = 0;
          await ensureSequential(batch, DENSE_PREFETCH_TIER);
        } else {
          idleRoundsRef.current += 1;
        }

        await new Promise(r => setTimeout(r, STEADY_POLL_MS));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, activeServerId]);
}
