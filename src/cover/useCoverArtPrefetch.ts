import { useEffect, useRef } from 'react';
import { coverCacheEnsureBatch, coverCacheStats, libraryCoverBackfillBatch } from '../api/coverCache';
import { useAuthStore } from '../store/authStore';
import { libraryIsReady } from '../utils/library/libraryReady';
import { coverArtRef } from './ref';
import { coverPrefetchDrainBatch } from './prefetchRegistry';
import type { CoverArtTier } from './types';

const STEADY_POLL_MS = 2000;
const BATCH_LIMIT = 32;
const DENSE_PREFETCH_TIER = 128 as CoverArtTier;

/**
 * Background cover warm-up — mirrors {@link useLibraryAnalysisBackfill} scheduling.
 */
export function useCoverArtPrefetch(enabled = true): void {
  const activeServerId = useAuthStore(s => s.activeServerId);
  const cursorRef = useRef<string | null>(null);

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
          await new Promise(r => setTimeout(r, STEADY_POLL_MS * 3));
          continue;
        }

        const batch = coverPrefetchDrainBatch(BATCH_LIMIT);
        if (batch.length > 0) {
          await coverCacheEnsureBatch(batch, DENSE_PREFETCH_TIER, 'low').catch(() => {});
        } else {
          const backfill = await libraryCoverBackfillBatch(
            activeServerId,
            cursorRef.current,
            BATCH_LIMIT,
          ).catch(() => null);
          if (backfill && backfill.coverIds.length > 0) {
            const refs = backfill.coverIds.map(id => coverArtRef(id, { kind: 'active' }));
            await coverCacheEnsureBatch(refs, DENSE_PREFETCH_TIER, 'low').catch(() => {});
            cursorRef.current = backfill.nextCursor;
            if (backfill.exhausted) cursorRef.current = null;
          }
        }

        await new Promise(r => setTimeout(r, STEADY_POLL_MS));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, activeServerId]);
}
