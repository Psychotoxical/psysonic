import { useLayoutEffect, useMemo } from 'react';
import { GRID_COVER_PRIME_ALL_MAX } from '../cover/layoutSizes';
import {
  collectAlbumCoverWarmItems,
  ensureAlbumCoverMisses,
  warmCoverDiskSrcBatch,
} from '../cover/warmDiskPeek';
import type { CoverSurfaceKind } from '../cover/types';

const DEFAULT_LIMIT = 120;

/**
 * Peek before paint; for small grids (≤48) queue ensures only for disk misses.
 */
export function useWarmGridCovers(
  items: ReadonlyArray<{ coverArt?: string | null }>,
  displayCssPx: number,
  opts?: {
    limit?: number;
    surface?: CoverSurfaceKind;
    enabled?: boolean;
    /** Precomputed fingerprint — avoids re-peeking when parent re-renders with a huge list. */
    warmKey?: string;
  },
): void {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const surface = opts?.surface ?? 'dense';
  const enabled = opts?.enabled ?? true;

  const warmKey = useMemo(() => {
    if (opts?.warmKey !== undefined) {
      return `${displayCssPx}:${opts.warmKey}`;
    }
    const slice = items.slice(0, limit);
    return `${displayCssPx}:${slice.map(a => a.coverArt ?? '').join('\u0001')}`;
  }, [items, displayCssPx, limit, opts?.warmKey]);

  const primeAllMisses = items.length > 0 && items.length <= GRID_COVER_PRIME_ALL_MAX;

  useLayoutEffect(() => {
    if (!enabled || displayCssPx <= 0) return;
    const batch = collectAlbumCoverWarmItems(items, displayCssPx, surface, limit);
    if (batch.length === 0) return;

    let cancelled = false;
    void (async () => {
      await warmCoverDiskSrcBatch(batch);
      if (cancelled) return;
      if (primeAllMisses) {
        await ensureAlbumCoverMisses(items, displayCssPx, { surface, limit });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, warmKey, items, displayCssPx, limit, surface, primeAllMisses]);
}
