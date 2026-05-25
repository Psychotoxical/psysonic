import { convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCachedUrl } from '../components/CachedImage';
import { coverCacheEnsure } from '../api/coverCache';
import { acquireUrl, releaseUrl } from '../utils/imageCache/urlPool';
import { getBlobFromIDB } from '../utils/imageCache/idbStore';
import { rememberBlob } from '../utils/imageCache/blobCache';
import { blobCache } from '../utils/imageCache/blobCache';
import { buildCoverArtFetchUrl } from './fetchUrl';
import { subscribeCoverDiskReady } from './diskHandoff';
import { coverArtRef } from './ref';
import { coverServerReachable } from './reachability';
import { coverStorageKey } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import type { CoverArtHandle, CoverArtId, CoverServerScope, CoverSurfaceKind } from './types';

const ensureInflight = new Map<string, Promise<{ hit: boolean; path: string }>>();
let ensureChain: Promise<void> = Promise.resolve();

function ensureDiskOnce(
  ref: NonNullable<ReturnType<typeof coverArtRef>>,
  tier: ReturnType<typeof resolveCoverDisplayTier>,
  priority: 'high' | 'middle' | 'low',
): Promise<{ hit: boolean; path: string }> {
  const key = `${coverStorageKey(ref.serverScope, ref.coverArtId, tier)}:${priority}`;
  const existing = ensureInflight.get(key);
  if (existing) return existing;
  const p = new Promise<{ hit: boolean; path: string }>(resolve => {
    ensureChain = ensureChain
      .then(async () => {
        const r = await coverCacheEnsure(ref, tier, priority).catch(() => ({
          hit: false,
          path: '',
          tier,
        }));
        resolve({ hit: r.hit, path: r.path });
      })
      .catch(() => resolve({ hit: false, path: '' }));
  }).finally(() => ensureInflight.delete(key));
  ensureInflight.set(key, p);
  return p;
}

/**
 * Dense grids: disk + IDB/memory only in the webview — no `getCoverArt` URL in `<img src>`.
 * Sparse: legacy cached URL path with fetch fallback when reachable.
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

  const fetchUrl = useMemo(
    () => (ref && reachable ? buildCoverArtFetchUrl(ref, tier) : ''),
    [ref, tier, reachable],
  );

  const [diskSrc, setDiskSrc] = useState('');
  const ownedDiskRef = useRef<string | null>(null);

  const sparseSrc = useCachedUrl(
    fetchUrl,
    storageKey,
    surface === 'sparse' && reachable,
    () => opts?.fetchQueueBias ?? 0,
  );

  useEffect(() => {
    setDiskSrc('');
    ownedDiskRef.current = null;
  }, [storageKey]);

  useEffect(() => {
    if (!ref || !storageKey) return;

    const releaseDisk = () => {
      ownedDiskRef.current = null;
    };

    const applyDiskPath = (path: string) => {
      if (!path) return;
      setDiskSrc(convertFileSrc(path));
      ownedDiskRef.current = storageKey;
    };

    const sync = acquireUrl(storageKey);
    if (sync) {
      setDiskSrc(sync);
      ownedDiskRef.current = storageKey;
      return releaseDisk;
    }

    let cancelled = false;

    void (async () => {
      const idb = await getBlobFromIDB(storageKey);
      if (cancelled) return;
      if (idb) {
        rememberBlob(storageKey, idb);
        const url = acquireUrl(storageKey);
        if (url) {
          setDiskSrc(url);
          ownedDiskRef.current = storageKey;
        }
        return;
      }

      if (surface !== 'dense' || !reachable) return;

      const result = await ensureDiskOnce(ref, tier, 'high');
      if (cancelled) return;
      if (result.hit && result.path) applyDiskPath(result.path);
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
      releaseDisk();
    };
  }, [ref, storageKey, tier, surface, reachable]);

  const src = diskSrc || (surface === 'sparse' ? sparseSrc : '');
  const provisional = useMemo(() => {
    if (!ref || !storageKey || src) return false;
    return !blobCache.has(storageKey);
  }, [ref, storageKey, src]);

  return { src, storageKey, cacheKey: storageKey, tier, provisional };
}
