// IndexedDB image cache (30-day TTL, LRU). Split into focused submodules under
// `imageCache/`; this file keeps the orchestration entry points and re-exports
// the public surface so existing call sites import from `imageCache` unchanged.
import { useAuthStore } from '../store/authStore';
import { COVER_ART_REGISTERED_SIZES } from './coverArtRegisteredSizes';
import { STORE_NAME } from './imageCache/constants';
import { blobCache, inflightBlobGets, rememberBlob } from './imageCache/blobCache';
import { purgeUrlEntry, clearAllUrlEntries } from './imageCache/urlPool';
import { acquireNetFetchSlot, releaseNetFetchSlot } from './imageCache/netFetchScheduler';
import { openDB, getBlobFromIDB, putBlob, cancelScheduledEvict } from './imageCache/idbStore';
import {
  parseCoverCacheKey,
  probeSiblingCoverBlobInMemory,
  probeSiblingCoverBlobFromIDB,
  scheduleSiblingVersusNetworkRace,
  clearCoverState,
} from './imageCache/coverSiblings';

export { acquireUrl, releaseUrl } from './imageCache/urlPool';
export { getImageCacheSize } from './imageCache/idbStore';
export { subscribeCoverUpgraded } from './imageCache/coverSiblings';

export async function invalidateCacheKey(cacheKey: string): Promise<void> {
  blobCache.delete(cacheKey);
  purgeUrlEntry(cacheKey);
  inflightBlobGets.delete(cacheKey);
  try {
    const database = await openDB();
    await new Promise<void>(resolve => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(cacheKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

export async function invalidateCoverArt(entityId: string): Promise<void> {
  const serverId = useAuthStore.getState().getActiveServer()?.id ?? '_';
  await Promise.all(
    COVER_ART_REGISTERED_SIZES.map(size =>
      invalidateCacheKey(`${serverId}:cover:${entityId}:${size}`),
    ),
  );
}

export async function clearImageCache(): Promise<void> {
  cancelScheduledEvict();
  blobCache.clear();
  inflightBlobGets.clear();
  clearCoverState();
  clearAllUrlEntries();
  try {
    const database = await openDB();
    await new Promise<void>(resolve => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore
  }
}

/**
 * Returns the cached Blob for an image, fetching it if necessary. Callers own
 * any object URL they create from the returned blob and must revoke it when
 * done — there is no shared URL pool.
 *
 * @param fetchUrl  The actual URL to fetch from (may contain ephemeral auth params).
 * @param cacheKey  A stable key that identifies the image across sessions.
 * @param signal    Optional AbortSignal — aborts queue-waiting and in-flight fetches.
 * @param getPriority  Called when waiting for a **network** slot (IndexedDB hits skip this queue).
 */
export async function getCachedBlob(
  fetchUrl: string,
  cacheKey: string,
  signal?: AbortSignal,
  getPriority?: () => number,
): Promise<Blob | null> {
  if (!fetchUrl || signal?.aborted) return null;

  const memHit = blobCache.get(cacheKey);
  if (memHit) {
    rememberBlob(cacheKey, memHit); // refresh LRU position
    return memHit;
  }

  const existing = inflightBlobGets.get(cacheKey);
  if (existing) return existing;

  const run = (async () => {
    if (signal?.aborted) return null;

    const idbHit = await getBlobFromIDB(cacheKey);
    if (signal?.aborted) return null;
    if (idbHit) {
      rememberBlob(cacheKey, idbHit);
      return idbHit;
    }

    const parsedCover = parseCoverCacheKey(cacheKey);
    if (parsedCover && !signal?.aborted) {
      const provisional =
        probeSiblingCoverBlobInMemory(parsedCover.stem, parsedCover.size) ??
        (await probeSiblingCoverBlobFromIDB(parsedCover.stem, parsedCover.size));
      if (provisional && !signal?.aborted) {
        rememberBlob(cacheKey, provisional);
        scheduleSiblingVersusNetworkRace(fetchUrl, cacheKey, provisional, signal, getPriority);
        return provisional;
      }
    }

    const acquired = await acquireNetFetchSlot(signal, getPriority);
    if (!acquired || signal?.aborted) {
      if (acquired) releaseNetFetchSlot();
      return null;
    }
    try {
      const resp = await fetch(fetchUrl, { signal });
      if (!resp.ok) return null;
      const newBlob = await resp.blob();
      if (signal?.aborted) return null;
      putBlob(cacheKey, newBlob); // fire-and-forget
      rememberBlob(cacheKey, newBlob);
      return newBlob;
    } catch {
      return null;
    } finally {
      releaseNetFetchSlot();
    }
  })();

  inflightBlobGets.set(cacheKey, run);
  run.finally(() => inflightBlobGets.delete(cacheKey));
  return run;
}
