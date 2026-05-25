import { convertFileSrc } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { acquireUrl, releaseUrl } from '../utils/imageCache/urlPool';
import { getBlobFromIDB } from '../utils/imageCache/idbStore';
import { rememberBlob } from '../utils/imageCache/blobCache';
import { blobCache } from '../utils/imageCache/blobCache';
import { coverEnsureQueued } from './ensureQueue';
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

function initialDiskSrc(storageKey: string): string {
  if (!storageKey) return '';
  return acquireUrl(storageKey) ?? '';
}

/**
 * Disk + IDB/memory in the webview — no `getCoverArt` URL in `<img src>` (Rust fetch only).
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

  const [diskSrc, setDiskSrc] = useState(() => initialDiskSrc(storageKey));
  const ownedDiskRef = useRef<string | null>(
    initialDiskSrc(storageKey) ? storageKey : null,
  );

  const applyDiskPath = useCallback((path: string) => {
    if (!path) return;
    setDiskSrc(convertFileSrc(path));
    ownedDiskRef.current = storageKey;
  }, [storageKey]);

  useEffect(() => {
    if (!ref || !storageKey) {
      setDiskSrc('');
      ownedDiskRef.current = null;
      return;
    }

    const sync = acquireUrl(storageKey);
    if (sync) {
      setDiskSrc(sync);
      ownedDiskRef.current = storageKey;
      return;
    }

    let cancelled = false;

    void (async () => {
      if (reachable) {
        const result = await coverEnsureQueued(storageKey, ref, tier, ensurePriority);
        if (cancelled) return;
        if (result.hit && result.path) {
          applyDiskPath(result.path);
          return;
        }
      }

      const idb = await getBlobFromIDB(storageKey);
      if (cancelled) return;
      if (idb) {
        rememberBlob(storageKey, idb);
        const url = acquireUrl(storageKey);
        if (url) {
          setDiskSrc(url);
          ownedDiskRef.current = storageKey;
        }
      }
    })();

    const unsubDisk = subscribeCoverDiskReady(storageKey, path => {
      if (!cancelled) applyDiskPath(path);
    });

    return () => {
      cancelled = true;
      unsubDisk();
      if (ownedDiskRef.current === storageKey) {
        releaseUrl(storageKey);
      }
    };
  }, [ref, storageKey, tier, reachable, ensurePriority, applyDiskPath]);

  const src = diskSrc;
  const provisional = useMemo(() => {
    if (!ref || !storageKey || src) return false;
    return !blobCache.has(storageKey);
  }, [ref, storageKey, src]);

  return { src, storageKey, cacheKey: storageKey, tier, provisional };
}
