import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { CoverEnsureOpts } from '@/lib/api/coverCache';
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
    /** Dense grid: true after first viewport intersection — allows middle-tier scroll-ahead. */
    seenViewport?: boolean;
    /** External album-art context (§5): carry artist/album so the server-miss
     *  fallback can try apple/lastfm for album refs. Plain covers pass none. */
    ensureOpts?: CoverEnsureOpts;
  },
): CoverArtHandle {
  const ref = coverRef ?? null;
  // Sanitize external album-art context: drop it when either name is empty/blank
  // (e.g. track metadata not yet resolved) so the Rust fallback isn't poisoned by
  // a bare-query miss that lands a `.miss-album-ext` marker for 30 min.
  const ensureOpts = useMemo(() => {
    const o = opts?.ensureOpts;
    if (!o) return undefined;
    const artist = o.artistName?.trim();
    const album = o.albumTitle?.trim();
    if (!artist || !album) return undefined;
    return { ...o, artistName: artist, albumTitle: album };
  }, [opts?.ensureOpts]);
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

  const seenViewport = opts?.seenViewport ?? false;
  const deferEnsureUntilVisible =
    surface === 'dense' && !seenViewport && ensurePriority !== 'high';

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

    if (readCachedSrc() && !ensureOpts?.allowExternalAlbum) return;

    let cancelled = false;

    void (async () => {
      await coverPeekQueued(storageKey, ref, tier);
      if (cancelled) return;
      if (readCachedSrc() && !ensureOpts?.allowExternalAlbum) return;

      if (reachable && !deferEnsureUntilVisible) {
        const result = await coverEnsureQueued(storageKey, ref, tier, ensurePriority, ensureOpts);
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
    };
  }, [
    ref,
    storageKey,
    tier,
    reachable,
    ensurePriority,
    deferEnsureUntilVisible,
    ensureOpts,
    applyDiskPath,
    readCachedSrc,
  ]);

  useEffect(() => {
    if (!storageKey) return;
    return () => coverEnsureRelease(storageKey);
  }, [storageKey]);

  const src = cachedSrc;
  const provisional = Boolean(ref && storageKey && !src);

  const onImgError = useCallback(() => {
    if (!ref) return;
    forgetDiskSrcPrefix(ref);
    if (reachable) {
      void coverEnsureQueued(storageKey, ref, tier, 'high', ensureOpts).then(result => {
        if (result.hit && result.path) applyDiskPath(result.path);
      });
    }
  }, [storageKey, ref, tier, reachable, ensureOpts, applyDiskPath]);

  return { src, storageKey, cacheKey: storageKey, tier, provisional, onImgError };
}
