import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { coverEnsureQueued, coverEnsureRelease } from './ensureQueue';
import { coverPeekQueued } from './peekQueue';
import { getDiskSrcForGrid, seedGridDiskSrcCache } from './diskSrcLookup';
import {
  forgetDiskSrcPrefix,
  getDiskSrcCacheGeneration,
  subscribeDiskSrcCache,
} from './diskSrcCache';
import { subscribeCoverDiskReady } from './diskHandoff';
import { coverServerReachable } from './reachability';
import { coverStorageKeyFromRef } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import type {
  CoverArtHandle,
  CoverArtRef,
  CoverPrefetchPriority,
  CoverSurfaceKind,
} from './types';

/**
 * Disk cache in Rust (WebP tiers) — no webview `getCoverArt` fetch when server is reachable.
 */
export function useCoverArt(
  coverRef: CoverArtRef | null | undefined,
  displayCssPx: number,
  opts?: {
    surface?: CoverSurfaceKind;
    fullRes?: boolean;
    fetchQueueBias?: number;
    observeRootMargin?: string;
    alt?: string;
    ensurePriority?: CoverPrefetchPriority;
  },
): CoverArtHandle {
  const ref = coverRef ?? null;
  const surface = opts?.surface ?? 'sparse';
  const reachable = ref ? coverServerReachable(ref.serverScope) : false;

  const tier = useMemo(
    () =>
      ref
        ? resolveCoverDisplayTier(displayCssPx, {
            surface,
            fullRes: opts?.fullRes,
          })
        : 128,
    [ref, displayCssPx, surface, opts?.fullRes],
  );

  const storageKey = useMemo(
    () => (ref ? coverStorageKeyFromRef(ref, tier) : ''),
    [ref, tier],
  );

  const ensurePriority: CoverPrefetchPriority = opts?.ensurePriority ?? 'middle';

  const deferEnsureUntilVisible = surface === 'dense' && ensurePriority !== 'high';

  const readCachedSrc = useCallback(() => {
    if (!ref) return '';
    return getDiskSrcForGrid(ref, tier);
  }, [ref, tier]);

  useSyncExternalStore(subscribeDiskSrcCache, getDiskSrcCacheGeneration);

  const cachedSrc = readCachedSrc();

  const applyDiskPath = useCallback((path: string) => {
    if (!ref) return;
    if (!path) {
      forgetDiskSrcPrefix(ref);
      return;
    }
    seedGridDiskSrcCache(ref, tier, path);
  }, [ref, tier]);

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
    if (!ref) return;
    forgetDiskSrcPrefix(ref);
    if (reachable) {
      void coverEnsureQueued(storageKey, ref, tier, 'high').then(result => {
        if (result.hit && result.path) applyDiskPath(result.path);
      });
    }
  }, [storageKey, ref, tier, reachable, applyDiskPath]);

  return { src, storageKey, cacheKey: storageKey, tier, provisional, onImgError };
}
