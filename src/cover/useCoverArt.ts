import { useMemo } from 'react';
import { useCachedUrl } from '../components/CachedImage';
import { blobCache } from '../utils/imageCache/blobCache';
import { buildCoverArtFetchUrl } from './fetchUrl';
import { coverArtRef } from './ref';
import { coverStorageKey } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import type { CoverArtHandle, CoverArtId, CoverServerScope, CoverSurfaceKind } from './types';

export function useCoverArt(
  coverArtId: CoverArtId | null | undefined,
  displayCssPx: number,
  opts?: {
    serverScope?: CoverServerScope;
    surface?: CoverSurfaceKind;
    fullRes?: boolean;
    fetchQueueBias?: number;
    observeRootMargin?: string;
    alt?: string;
  },
): CoverArtHandle {
  const serverScope = opts?.serverScope ?? { kind: 'active' };
  const surface = opts?.surface ?? 'sparse';

  const tier = useMemo(
    () =>
      coverArtId
        ? resolveCoverDisplayTier(displayCssPx, {
            surface,
            fullRes: opts?.fullRes,
          })
        : 128,
    [coverArtId, displayCssPx, surface, opts?.fullRes],
  );

  const ref = useMemo(
    () => (coverArtId ? coverArtRef(coverArtId, serverScope) : null),
    [coverArtId, serverScope],
  );

  const storageKey = useMemo(
    () => (ref ? coverStorageKey(ref.serverScope, ref.coverArtId, tier) : ''),
    [ref, tier],
  );

  const fetchUrl = useMemo(
    () => (ref ? buildCoverArtFetchUrl(ref, tier) : ''),
    [ref, tier],
  );

  const src = useCachedUrl(
    fetchUrl,
    storageKey,
    true,
    () => opts?.fetchQueueBias ?? 0,
  );

  const provisional = useMemo(() => {
    if (!ref || !storageKey) return false;
    return !blobCache.has(storageKey) && !!src;
  }, [ref, storageKey, src]);

  return { src, storageKey, cacheKey: storageKey, tier, provisional };
}
