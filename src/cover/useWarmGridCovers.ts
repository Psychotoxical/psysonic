import { useEffect, useMemo } from 'react';
import {
  collectAlbumCoverWarmItems,
  ensureAlbumCoverMisses,
  warmCoverDiskSrcBatch,
} from '@/cover/warmDiskPeek';
import type { CoverSurfaceKind } from '@/cover/types';

const DEFAULT_LIMIT = 120;

/**
 * Peek after mount (non-blocking); ensure disk misses for the warmed viewport slice.
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

  useEffect(() => {
    if (!enabled || displayCssPx <= 0) return;

    let cancelled = false;
    void (async () => {
      const batch = collectAlbumCoverWarmItems(items, displayCssPx, surface, limit);
      if (cancelled || batch.length === 0) return;
      await warmCoverDiskSrcBatch(batch);
      if (cancelled) return;
      // Prime disk misses for the warmed viewport slice (not only tiny grids).
      await ensureAlbumCoverMisses(items, displayCssPx, { surface, limit });
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, warmKey, items, displayCssPx, limit, surface]);
}
