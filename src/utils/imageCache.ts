import { useAuthStore } from '../store/authStore';
import { COVER_ART_REGISTERED_SIZES } from './coverArtRegisteredSizes';
import { downscaleCoverBlob } from './coverBlobDownscale';

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

function entryBlobIfFresh(entry: { timestamp: number; blob: Blob } | undefined): Blob | null {
  return entry && Date.now() - entry.timestamp < MAX_AGE_MS ? entry.blob : null;
}

async function getBlobFromIDB(key: string): Promise<Blob | null> {
  try {
    const database = await openDB();
    return new Promise(resolve => {
      const req = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(entryBlobIfFresh(req.result));
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Several `get`s in one read transaction — avoids N separate transactions when probing sibling covers. */
async function mapBlobsFromIDB(keys: readonly string[]): Promise<Map<string, Blob | null>> {
  const map = new Map<string, Blob | null>();
  for (const key of keys) map.set(key, null);
  if (keys.length === 0) return map;
  try {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      let pending = keys.length;
      tx.onerror = () => reject(tx.error ?? new Error('idb'));
      tx.onabort = () => reject(new Error('idb abort'));
      const step = (): void => {
        pending--;
        if (pending === 0) resolve();
      };
      for (const key of keys) {
        const req = store.get(key);
        req.onsuccess = () => {
          map.set(key, entryBlobIfFresh(req.result));
          step();
        };
        req.onerror = () => step();
      }
    });
  } catch {
    for (const key of keys) map.set(key, null);
  }
  return map;
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

/** Prefer larger blobs as provisional placeholders — downscaled in `<img>` for sharpness. */
const COVER_ART_CACHE_SIZES_DESC = [...COVER_ART_REGISTERED_SIZES].sort((a, b) => b - a);

function parseCoverCacheKey(cacheKey: string): { stem: string; size: number } | null {
  const colon = cacheKey.lastIndexOf(':');
  if (colon <= 0) return null;
  const tail = cacheKey.slice(colon + 1);
  const size = Number(tail);
  if (!Number.isFinite(size) || size <= 0) return null;
  const stem = cacheKey.slice(0, colon);
  if (!stem.includes(':cover:')) return null;
  return { stem, size };
}

function probeSiblingCoverBlobInMemory(stem: string, excludedSize: number): Blob | null {
  for (const sz of COVER_ART_CACHE_SIZES_DESC) {
    if (sz === excludedSize) continue;
    const b = blobCache.get(`${stem}:${sz}`);
    if (b) return b;
  }
  return null;
}

async function probeSiblingCoverBlobFromIDB(stem: string, excludedSize: number): Promise<Blob | null> {
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
function scheduleSiblingVersusNetworkRace(
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

export async function invalidateCoverArt(entityId: string): Promise<void> {
  const serverId = useAuthStore.getState().getActiveServer()?.id ?? '_';
  await Promise.all(
    COVER_ART_REGISTERED_SIZES.map(size =>
      invalidateCacheKey(`${serverId}:cover:${entityId}:${size}`),
    ),
  );
}

export async function clearImageCache(): Promise<void> {
  if (evictDebounceTimer) {
    clearTimeout(evictDebounceTimer);
    evictDebounceTimer = null;
  }
  blobCache.clear();
  inflightBlobGets.clear();
  coverUpgradeListeners.clear();
  coverSiblingRaceInflights.clear();
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
