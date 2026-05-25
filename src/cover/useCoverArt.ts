import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { coverEnsureQueued, coverEnsureRelease } from './ensureQueue';
import { coverPeekQueued } from './peekQueue';
import { getDiskSrcForGrid, seedGridDiskSrcCache } from './diskSrcLookup';
import {
  forgetDiskSrc,
  getDiskSrc,
  getDiskSrcCacheGeneration,
  rememberDiskSrc,
  subscribeDiskSrcCache,
} from './diskSrcCache';
import { subscribeCoverDiskReady } from './diskHandoff';
import { coverArtRef } from './ref';
import { coverServerReachable } from './reachability';
import { coverStorageKey } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import type {
  CoverArtHandle,
  CoverArtId,
  CoverPrefetchPriority,
  CoverServerScope,
  CoverSurfaceKind,
} from './types';

/**
 * Disk cache in Rust (WebP tiers) — no webview `getCoverArt` fetch when server is reachable.
 */
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
    /** Download / ensure ordering — visible cells should pass `high`. */
    ensurePriority?: CoverPrefetchPriority;
  },
): CoverArtHandle {
  const serverScope = opts?.serverScope ?? { kind: 'active' };
  const surface = opts?.surface ?? 'sparse';
  const reachable = coverServerReachable(serverScope);

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

  const ensurePriority: CoverPrefetchPriority = opts?.ensurePriority ?? 'middle';

  /** Dense grids: peek on mount; HTTP ensure only when IO marks the cell `high`. */
  const deferEnsureUntilVisible = surface === 'dense' && ensurePriority !== 'high';

  const readCachedSrc = useCallback(() => {
    if (!ref) return '';
    if (surface === 'dense') {
      return getDiskSrcForGrid(ref.serverScope, ref.coverArtId, tier);
    }
    return getDiskSrc(storageKey);
  }, [ref, storageKey, surface, tier]);

  useSyncExternalStore(subscribeDiskSrcCache, getDiskSrcCacheGeneration);

  const cachedSrc = readCachedSrc();

  const applyDiskPath = useCallback((path: string) => {
    if (!ref || !storageKey) return;
    if (!path) {
      forgetDiskSrc(storageKey);
      return;
    }
    if (surface === 'dense') {
      seedGridDiskSrcCache(ref.serverScope, ref.coverArtId, tier, path);
    } else {
      rememberDiskSrc(storageKey, path);
    }
  }, [ref, storageKey, tier, surface, readCachedSrc]);

  useEffect(() => {
    if (!ref || !storageKey) return;

    if (readCachedSrc()) return;

    let cancelled = false;

    void (async () => {
      const peekHit = await coverPeekQueued(storageKey, ref, tier);
      if (cancelled) return;
      if (peekHit || readCachedSrc()) return;

      if (reachable && !deferEnsureUntilVisible) {
        const result = await coverEnsureQueued(storageKey, ref, tier, ensurePriority);
        if (cancelled) return;
        if (result.hit && result.path) {
          applyDiskPath(result.path);
        }
      }
    })();

    const unsubDisk = subscribeCoverDiskReady(storageKey, path => {
      if (!cancelled && path) applyDiskPath(path);
    });

    return () => {
      cancelled = true;
      unsubDisk();
      coverEnsureRelease(storageKey);
    };
  }, [
    ref,
    storageKey,
    tier,
    reachable,
    ensurePriority,
    deferEnsureUntilVisible,
    applyDiskPath,
    readCachedSrc,
  ]);

  const src = cachedSrc;
  const provisional = Boolean(ref && storageKey && !src);

  const onImgError = useCallback(() => {
    forgetDiskSrc(storageKey);
    if (ref && reachable) {
      void coverEnsureQueued(storageKey, ref, tier, 'high').then(result => {
        if (result.hit && result.path) applyDiskPath(result.path);
      });
    }
  }, [storageKey, ref, tier, reachable, applyDiskPath]);

  return { src, storageKey, cacheKey: storageKey, tier, provisional, onImgError };
}
