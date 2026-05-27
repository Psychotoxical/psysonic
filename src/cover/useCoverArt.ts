import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { libraryGetTrack } from '../api/library';
import { coverEnsureQueued, coverEnsureRelease } from './ensureQueue';
import { coverPeekQueued } from './peekQueue';
import { getDiskSrcForGrid, seedGridDiskSrcCache } from './diskSrcLookup';
import { mergeDiskIdHints } from './mergeDiskIdHints';
import {
  forgetDiskSrcPrefix,
  getDiskSrcCacheGeneration,
  subscribeDiskSrcCache,
} from './diskSrcCache';
import { subscribeCoverDiskReady } from './diskHandoff';
import { coverArtRef } from './ref';
import { coverServerReachable } from './reachability';
import { coverIndexKeyFromRef, coverStorageKey } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import type { DiskCoverIdHints } from './diskPeekIds';
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
    /** Probe legacy on-disk folders (track id vs album id) when the resolved id misses. */
    diskIdHints?: DiskCoverIdHints;
    /** When Subsonic omits `albumId`, load `al-*` from the library index for mf→al peek. */
    libraryTrackId?: string;
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

  const [libraryDiskHints, setLibraryDiskHints] = useState<DiskCoverIdHints | undefined>();
  const diskIdHints = useMemo(
    () => mergeDiskIdHints(opts?.diskIdHints, libraryDiskHints),
    [opts?.diskIdHints, libraryDiskHints],
  );

  useEffect(() => {
    const trackId = opts?.libraryTrackId?.trim();
    if (!trackId || !ref?.coverArtId.startsWith('mf-')) {
      setLibraryDiskHints(undefined);
      return;
    }
    if (opts?.diskIdHints?.albumId?.trim()?.startsWith('al-')) {
      setLibraryDiskHints(undefined);
      return;
    }
    let cancelled = false;
    const serverKey = coverIndexKeyFromRef(ref);
    void libraryGetTrack(serverKey, trackId).then(row => {
      if (cancelled || !row) return;
      setLibraryDiskHints({
        albumId: row.albumId ?? undefined,
        rawCoverArt: row.coverArtId ?? undefined,
        songId: row.id,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [opts?.libraryTrackId, opts?.diskIdHints?.albumId, ref]);

  /** Dense grids: peek on mount; HTTP ensure only when IO marks the cell `high`. */
  const deferEnsureUntilVisible = surface === 'dense' && ensurePriority !== 'high';

  const readCachedSrc = useCallback(() => {
    if (!ref) return '';
    return getDiskSrcForGrid(ref.serverScope, ref.coverArtId, tier);
  }, [ref, tier]);

  useSyncExternalStore(subscribeDiskSrcCache, getDiskSrcCacheGeneration);

  const cachedSrc = readCachedSrc();

  const applyDiskPath = useCallback((path: string) => {
    if (!ref) return;
    if (!path) {
      forgetDiskSrcPrefix(coverIndexKeyFromRef(ref), ref.coverArtId);
      return;
    }
    seedGridDiskSrcCache(ref.serverScope, ref.coverArtId, tier, path);
  }, [ref, tier]);

  useEffect(() => {
    if (!ref || !storageKey) return;

    if (readCachedSrc()) return;

    let cancelled = false;

    void (async () => {
      const peekHit = await coverPeekQueued(storageKey, ref, tier, diskIdHints);
      if (cancelled) return;
      if (peekHit || readCachedSrc()) return;

      if (reachable && !deferEnsureUntilVisible) {
        let result = await coverEnsureQueued(storageKey, ref, tier, ensurePriority);
        if (cancelled) return;
        const albumId = diskIdHints?.albumId?.trim();
        if (
          !result.hit
          && ref.coverArtId.startsWith('mf-')
          && albumId?.startsWith('al-')
          && albumId !== ref.coverArtId
        ) {
          const altRef = { ...ref, coverArtId: albumId };
          const altKey = coverStorageKey(ref.serverScope, albumId, tier);
          result = await coverEnsureQueued(altKey, altRef, tier, ensurePriority);
          if (cancelled) return;
        }
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
    diskIdHints,
  ]);

  const src = cachedSrc;
  const provisional = Boolean(ref && storageKey && !src);

  const onImgError = useCallback(() => {
    if (!ref) return;
    forgetDiskSrcPrefix(coverIndexKeyFromRef(ref), ref.coverArtId);
    if (reachable) {
      void coverEnsureQueued(storageKey, ref, tier, 'high').then(result => {
        if (result.hit && result.path) applyDiskPath(result.path);
      });
    }
  }, [storageKey, ref, tier, reachable, applyDiskPath]);

  return { src, storageKey, cacheKey: storageKey, tier, provisional, onImgError };
}
