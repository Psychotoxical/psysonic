import { useAuthStore } from '../store/authStore';

const DB_NAME = 'psysonic-img-cache';
const STORE_NAME = 'images';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_BLOB_CACHE = 200; // hot in-memory blob entries (LRU)
const MAX_CONCURRENT_FETCHES = 5;

// In-memory blob cache: cacheKey → Blob (insertion-order = LRU approximation).
// Only the Map entry is dropped on overflow — the underlying Blob is freed by
// the GC once no <img>/<canvas>/object URL still references it.
const blobCache = new Map<string, Blob>();

// Refcounted object URLs shared across all consumers of the same cacheKey.
// Chromium/WebView2 keys its decoded-image cache by URL, so handing every
// <img> its own URL.createObjectURL forces a fresh decode for each instance —
// catastrophic on Windows even for tiny cover thumbnails. Sharing a single
// URL per cacheKey lets the renderer reuse the decoded bitmap.
const URL_REVOKE_DELAY_MS = 500;
type UrlEntry = { url: string; refs: number; revokeTimer: ReturnType<typeof setTimeout> | null };
const urlEntries = new Map<string, UrlEntry>();

function purgeUrlEntry(cacheKey: string): void {
  const entry = urlEntries.get(cacheKey);
  if (!entry) return;
  if (entry.revokeTimer) clearTimeout(entry.revokeTimer);
  URL.revokeObjectURL(entry.url);
  urlEntries.delete(cacheKey);
}

/**
 * Returns a shared object URL for the cached blob of `cacheKey`, or null if
 * not currently in memory. Pair every successful call with releaseUrl().
 * Subsequent acquires reuse the same URL and just bump the refcount.
 */
export function acquireUrl(cacheKey: string): string | null {
  const blob = blobCache.get(cacheKey);
  if (!blob) return null;
  rememberBlob(cacheKey, blob); // refresh LRU position
  let entry = urlEntries.get(cacheKey);
  if (!entry) {
    entry = { url: URL.createObjectURL(blob), refs: 0, revokeTimer: null };
    urlEntries.set(cacheKey, entry);
  } else if (entry.revokeTimer) {
    clearTimeout(entry.revokeTimer);
    entry.revokeTimer = null;
  }
  entry.refs++;
  return entry.url;
}

/** Decrements the refcount; revokes (after grace delay) when it reaches zero. */
export function releaseUrl(cacheKey: string): void {
  const entry = urlEntries.get(cacheKey);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  entry.revokeTimer = setTimeout(() => {
    URL.revokeObjectURL(entry.url);
    urlEntries.delete(cacheKey);
  }, URL_REVOKE_DELAY_MS);
}

let activeFetches = 0;
const fetchQueue: Array<() => void> = [];

function acquireFetchSlot(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>(resolve => {
    const onGrant = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    };
    const onAbort = () => {
      const idx = fetchQueue.indexOf(onGrant);
      if (idx !== -1) fetchQueue.splice(idx, 1);
      resolve(false);
    };
    fetchQueue.push(onGrant);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function releaseFetchSlot(): void {
  activeFetches--;
  const next = fetchQueue.shift();
  if (next) { activeFetches++; next(); }
}

function rememberBlob(key: string, blob: Blob): void {
  blobCache.delete(key); // re-insert at end → marks as recently used
  blobCache.set(key, blob);
  while (blobCache.size > MAX_BLOB_CACHE) {
    const oldest = blobCache.keys().next().value;
    if (!oldest) break;
    blobCache.delete(oldest);
  }
}

let db: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (db) return Promise.resolve(db);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const database = (e.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = e => {
      db = (e.target as IDBOpenDBRequest).result;
      resolve(db!);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function getBlobFromIDB(key: string): Promise<Blob | null> {
  try {
    const database = await openDB();
    return new Promise(resolve => {
      const req = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const entry = req.result;
        resolve(entry && Date.now() - entry.timestamp < MAX_AGE_MS ? entry.blob : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function evictDiskIfNeeded(maxBytes: number): Promise<void> {
  try {
    const database = await openDB();
    const entries: Array<{ key: string; timestamp: number; size: number }> = await new Promise(resolve => {
      const req = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        resolve(
          (req.result ?? []).map((e: { key: string; timestamp: number; blob: Blob }) => ({
            key: e.key,
            timestamp: e.timestamp,
            size: e.blob?.size ?? 0,
          })),
        );
      };
      req.onerror = () => resolve([]);
    });

    let total = entries.reduce((acc, e) => acc + e.size, 0);
    if (total <= maxBytes) return;

    entries.sort((a, b) => a.timestamp - b.timestamp);

    const tx = database.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const entry of entries) {
      if (total <= maxBytes) break;
      store.delete(entry.key);
      blobCache.delete(entry.key);
      total -= entry.size;
    }
  } catch {
    // Ignore
  }
}

async function putBlob(key: string, blob: Blob): Promise<void> {
  try {
    const database = await openDB();
    await new Promise<void>(resolve => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ key, blob, timestamp: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    const maxBytes = useAuthStore.getState().maxCacheMb * 1024 * 1024;
    evictDiskIfNeeded(maxBytes);
  } catch {
    // Ignore write errors
  }
}

export async function getImageCacheSize(): Promise<number> {
  try {
    const database = await openDB();
    return new Promise(resolve => {
      const req = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const entries: Array<{ blob: Blob }> = req.result ?? [];
        resolve(entries.reduce((acc, e) => acc + (e.blob?.size ?? 0), 0));
      };
      req.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

export async function invalidateCacheKey(cacheKey: string): Promise<void> {
  blobCache.delete(cacheKey);
  purgeUrlEntry(cacheKey);
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
  const sizes = [40, 64, 128, 200, 256, 300, 500, 2000];
  await Promise.all(sizes.map(size => invalidateCacheKey(`${serverId}:cover:${entityId}:${size}`)));
}

export async function clearImageCache(): Promise<void> {
  blobCache.clear();
  for (const key of Array.from(urlEntries.keys())) purgeUrlEntry(key);
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
 */
export async function getCachedBlob(fetchUrl: string, cacheKey: string, signal?: AbortSignal): Promise<Blob | null> {
  if (!fetchUrl || signal?.aborted) return null;

  const memHit = blobCache.get(cacheKey);
  if (memHit) {
    rememberBlob(cacheKey, memHit); // refresh LRU position
    return memHit;
  }

  const idbHit = await getBlobFromIDB(cacheKey);
  if (signal?.aborted) return null;
  if (idbHit) {
    rememberBlob(cacheKey, idbHit);
    return idbHit;
  }

  const acquired = await acquireFetchSlot(signal);
  if (!acquired || signal?.aborted) {
    if (acquired) releaseFetchSlot();
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
    releaseFetchSlot();
  }
}
