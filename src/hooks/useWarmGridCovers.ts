import { useLayoutEffect, useMemo } from 'react';
import { collectAlbumCoverWarmItems, warmCoverDiskSrcBatch } from '../cover/warmDiskPeek';
import type { CoverSurfaceKind } from '../cover/types';

const DEFAULT_LIMIT = 120;

/**
 * One peek-batch before grid paint — seeds `diskSrcCache` for the first viewport of cards.
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

  useLayoutEffect(() => {
    if (!enabled || displayCssPx <= 0) return;
    const batch = collectAlbumCoverWarmItems(items, displayCssPx, surface, limit);
    if (batch.length === 0) return;
    void warmCoverDiskSrcBatch(batch);
  }, [enabled, warmKey, items, displayCssPx, limit, surface]);
}
