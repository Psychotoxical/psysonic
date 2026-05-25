import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { coverEnsureQueued } from './ensureQueue';
import { forgetDiskSrc, getDiskSrc, rememberDiskSrc } from './diskSrcCache';
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

  const ensurePriority: CoverPrefetchPriority = opts?.ensurePriority
    ?? (surface === 'dense' ? 'middle' : 'middle');

  const [diskSrc, setDiskSrc] = useState(() => getDiskSrc(storageKey));

  const applyDiskPath = useCallback((path: string) => {
    if (!storageKey) return;
    if (!path) {
      forgetDiskSrc(storageKey);
      setDiskSrc('');
      return;
    }
    const src = rememberDiskSrc(storageKey, path);
    if (src) setDiskSrc(src);
  }, [storageKey]);

  useEffect(() => {
    if (!ref || !storageKey) {
      setDiskSrc('');
      return;
    }

    const cached = getDiskSrc(storageKey);
    if (cached) {
      setDiskSrc(cached);
      return;
    }

    let cancelled = false;

    void (async () => {
      if (reachable) {
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
    };
  }, [ref, storageKey, tier, reachable, ensurePriority, applyDiskPath]);

  const src = diskSrc;
  const provisional = Boolean(ref && storageKey && !src);

  const onImgError = useCallback(() => {
    forgetDiskSrc(storageKey);
    setDiskSrc('');
    if (ref && reachable) {
      void coverEnsureQueued(storageKey, ref, tier, 'high').then(result => {
        if (result.hit && result.path) applyDiskPath(result.path);
      });
    }
  }, [storageKey, ref, tier, reachable, applyDiskPath]);

  return { src, storageKey, cacheKey: storageKey, tier, provisional, onImgError };
}
