import { useAuthStore } from '../store/authStore';

const DB_NAME = 'psysonic-img-cache';
const STORE_NAME = 'images';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** In-memory blobs — scrolling large grids used to thrash at 200 and re-hit IndexedDB for “cold” keys that still had a live shared object URL. */
const MAX_BLOB_CACHE = 600; // hot in-memory blob entries (LRU)
/** Network-only pool — IndexedDB hits must not queue behind remote fetches. */
const MAX_CONCURRENT_NET_FETCHES = 6;

type LoadWaiter = {
  getPriority: () => number;
  resolve: (granted: boolean) => void;
};
const loadWaiters: LoadWaiter[] = [];

/** One in-flight read per logical image — avoids duplicate IndexedDB transactions when many cells mount together. */
const inflightBlobGets = new Map<string, Promise<Blob | null>>();

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
 *
 * IMPORTANT: the Blob can be LRU-evicted from `blobCache` while `urlEntries`
 * still holds a valid object URL (another `<img>` still references it). We
 * must reuse that URL — otherwise callers fall through to IndexedDB / network
 * again and scrolling janks even when data was already resolved once.
 */
export function acquireUrl(cacheKey: string): string | null {
  const blob = blobCache.get(cacheKey);
  if (blob) {
    rememberBlob(cacheKey, blob); // refresh LRU position
  }

  const entry = urlEntries.get(cacheKey);
  if (entry) {
    if (entry.revokeTimer) {
      clearTimeout(entry.revokeTimer);
      entry.revokeTimer = null;
    }
    entry.refs++;
    return entry.url;
  }

  if (!blob) return null;

  const newEntry: UrlEntry = { url: URL.createObjectURL(blob), refs: 0, revokeTimer: null };
  urlEntries.set(cacheKey, newEntry);
  newEntry.refs++;
  return newEntry.url;
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

let activeNetFetches = 0;

function removeLoadWaiter(waiter: LoadWaiter): void {
  const i = loadWaiters.indexOf(waiter);
  if (i !== -1) loadWaiters.splice(i, 1);
}

/**
 * Slot for remote `fetch` only. IndexedDB reads run before this — cached disk
 * art can render without waiting on in-flight network downloads.
 */
function acquireNetFetchSlot(signal?: AbortSignal, getPriority?: () => number): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (activeNetFetches < MAX_CONCURRENT_NET_FETCHES) {
    activeNetFetches++;
    return Promise.resolve(true);
  }
  return new Promise<boolean>(resolve => {
    let waiter: LoadWaiter;
    const onAbort = () => {
      signal?.removeEventListener('abort', onAbort);
      removeLoadWaiter(waiter);
      resolve(false);
    };
    waiter = {
      getPriority: getPriority ?? (() => 0),
      resolve: (granted: boolean) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(granted);
      },
    };
    loadWaiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function pickHighestPriorityWaiterIndex(): number {
  if (loadWaiters.length === 0) return -1;
  let best = 0;
  let bestP = safePriority(loadWaiters[0].getPriority);
  for (let i = 1; i < loadWaiters.length; i++) {
    const p = safePriority(loadWaiters[i].getPriority);
    if (p > bestP) {
      bestP = p;
      best = i;
    }
  }
  return best;
}

function safePriority(fn: () => number): number {
  try {
    return fn();
  } catch {
    return 0;
  }
}

function releaseNetFetchSlot(): void {
  activeNetFetches = Math.max(0, activeNetFetches - 1);
  if (activeNetFetches >= MAX_CONCURRENT_NET_FETCHES) return;
  const idx = pickHighestPriorityWaiterIndex();
  if (idx === -1) return;
  const [w] = loadWaiters.splice(idx, 1);
  activeNetFetches++;
  w.resolve(true);
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

/** Batched eviction — avoids `getAll()` on every cover write during fast scrolling. */
let evictDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let evictPendingMaxBytes = 0;

function scheduleEvictDiskIfNeeded(maxBytes: number): void {
  evictPendingMaxBytes = maxBytes;
  if (evictDebounceTimer) clearTimeout(evictDebounceTimer);
  evictDebounceTimer = setTimeout(() => {
    evictDebounceTimer = null;
    void evictDiskIfNeeded(evictPendingMaxBytes);
  }, 450);
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
    scheduleEvictDiskIfNeeded(maxBytes);
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
  const sizes = [40, 64, 128, 200, 256, 300, 500, 2000];
  await Promise.all(sizes.map(size => invalidateCacheKey(`${serverId}:cover:${entityId}:${size}`)));
}

export async function clearImageCache(): Promise<void> {
  if (evictDebounceTimer) {
    clearTimeout(evictDebounceTimer);
    evictDebounceTimer = null;
  }
  blobCache.clear();
  inflightBlobGets.clear();
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
