import { COVER_ART_REGISTERED_SIZES } from '../cover/coverArtRegisteredSizes';
import { downscaleCoverBlob } from '../cover/coverBlobDownscale';
import { blobCache, rememberBlob } from './blobCache';
import { purgeUrlEntry } from './urlPool';
import { mapBlobsFromIDB, putBlob } from './idbStore';
import { acquireNetFetchSlot, releaseNetFetchSlot } from './netFetchScheduler';

/** Prefer larger blobs as provisional placeholders — downscaled in `<img>` for sharpness. */
const COVER_ART_CACHE_SIZES_DESC = [...COVER_ART_REGISTERED_SIZES].sort((a, b) => b - a);

export function parseCoverCacheKey(cacheKey: string): { stem: string; size: number } | null {
  const colon = cacheKey.lastIndexOf(':');
  if (colon <= 0) return null;
  const tail = cacheKey.slice(colon + 1);
  const size = Number(tail);
  if (!Number.isFinite(size) || size <= 0) return null;
  const stem = cacheKey.slice(0, colon);
  if (!stem.includes(':cover:')) return null;
  return { stem, size };
}

export function probeSiblingCoverBlobInMemory(stem: string, excludedSize: number): Blob | null {
  for (const sz of COVER_ART_CACHE_SIZES_DESC) {
    if (sz === excludedSize) continue;
    const b = blobCache.get(`${stem}:${sz}`);
    if (b) return b;
  }
  return null;
}

export async function probeSiblingCoverBlobFromIDB(stem: string, excludedSize: number): Promise<Blob | null> {
  const keys = COVER_ART_CACHE_SIZES_DESC.filter(sz => sz !== excludedSize).map(sz => `${stem}:${sz}`);
  if (keys.length === 0) return null;
  const blobs = await mapBlobsFromIDB(keys);
  for (const key of keys) {
    const b = blobs.get(key);
    if (b) return b;
  }
  return null;
}

const coverUpgradeListeners = new Map<string, Set<() => void>>();
const coverSiblingRaceInflights = new Map<string, Promise<void>>();

/** Abort when any of `outer` / `peer` fires (ES2022 `AbortSignal.any` not in our lib target). */
function mergedAbortSignals(outer: AbortSignal | undefined, peer: AbortSignal): AbortSignal {
  if (!outer) return peer;
  if (outer.aborted || peer.aborted) {
    const c = new AbortController();
    c.abort();
    return c.signal;
  }
  const c = new AbortController();
  const on = () => c.abort();
  outer.addEventListener('abort', on, { once: true });
  peer.addEventListener('abort', on, { once: true });
  return c.signal;
}

function notifyCoverUpgraded(cacheKey: string): void {
  purgeUrlEntry(cacheKey);
  const listeners = coverUpgradeListeners.get(cacheKey);
  if (!listeners) return;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

/** When the exact-resolution blob replaces a provisional sibling blob, repaint consumers. */
export function subscribeCoverUpgraded(cacheKey: string, onUpgrade: () => void): () => void {
  let set = coverUpgradeListeners.get(cacheKey);
  if (!set) {
    set = new Set();
    coverUpgradeListeners.set(cacheKey, set);
  }
  set.add(onUpgrade);
  return () => {
    const s = coverUpgradeListeners.get(cacheKey);
    if (!s) return;
    s.delete(onUpgrade);
    if (s.size === 0) coverUpgradeListeners.delete(cacheKey);
  };
}

/**
 * Parallel resolve when we only have another size of the same cover in cache:
 * small server request vs local downscale — first successful blob wins, other side aborts.
 */
export function scheduleSiblingVersusNetworkRace(
  fetchUrl: string,
  cacheKey: string,
  siblingBlob: Blob,
  outerSignal: AbortSignal | undefined,
  getPriority?: () => number,
): void {
  if (coverSiblingRaceInflights.has(cacheKey)) return;
  const parsed = parseCoverCacheKey(cacheKey);
  if (!parsed) return;

  const netCtl = new AbortController();
  const dsCtl = new AbortController();
  let winner = false;

  const killLosers = () => {
    netCtl.abort();
    dsCtl.abort();
  };

  const tryCommitWinner = (blob: Blob | null) => {
    if (!blob || winner || outerSignal?.aborted) return;
    winner = true;
    killLosers();
    putBlob(cacheKey, blob);
    rememberBlob(cacheKey, blob);
    notifyCoverUpgraded(cacheKey);
  };

  outerSignal?.addEventListener('abort', () => killLosers(), { once: true });

  const netBranch = (async () => {
    if (winner || outerSignal?.aborted) return;
    const waitSig = mergedAbortSignals(outerSignal, netCtl.signal);
    const acquired = await acquireNetFetchSlot(waitSig, getPriority);
    if (!acquired || winner || outerSignal?.aborted) {
      if (acquired) releaseNetFetchSlot();
      return;
    }
    try {
      const fetchSig = mergedAbortSignals(outerSignal, netCtl.signal);
      const resp = await fetch(fetchUrl, { signal: fetchSig });
      if (!resp.ok || winner || outerSignal?.aborted) return;
      const blob = await resp.blob();
      tryCommitWinner(blob);
    } catch {
      /* fetch aborted / network */
    } finally {
      releaseNetFetchSlot();
    }
  })();

  const clientBranch = (async () => {
    await Promise.resolve();
    if (winner || outerSignal?.aborted) return;
    const dsSig = mergedAbortSignals(outerSignal, dsCtl.signal);
    const out = await downscaleCoverBlob(siblingBlob, parsed.size, dsSig);
    if (!out || winner || outerSignal?.aborted) return;
    if (out.size >= siblingBlob.size * 0.92) return;
    tryCommitWinner(out);
  })();

  const settled = Promise.allSettled([netBranch, clientBranch]).then(() => {});
  coverSiblingRaceInflights.set(cacheKey, settled);
  void settled.finally(() => coverSiblingRaceInflights.delete(cacheKey));
}

/** Drop all cover-upgrade listeners and in-flight sibling races — used by clearImageCache. */
export function clearCoverState(): void {
  coverUpgradeListeners.clear();
  coverSiblingRaceInflights.clear();
}
