import { useAuthStore } from '../../store/authStore';
import { DB_NAME, STORE_NAME, MAX_AGE_MS } from './constants';
import { blobCache } from './blobCache';

let db: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
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

export async function getBlobFromIDB(key: string): Promise<Blob | null> {
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
export async function mapBlobsFromIDB(keys: readonly string[]): Promise<Map<string, Blob | null>> {
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

/** Cancels a pending debounced eviction — used by clearImageCache. */
export function cancelScheduledEvict(): void {
  if (evictDebounceTimer) {
    clearTimeout(evictDebounceTimer);
    evictDebounceTimer = null;
  }
}

export async function putBlob(key: string, blob: Blob): Promise<void> {
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
