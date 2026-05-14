/**
 * IndexedDB layer for lyrics caching. The RAM-level cache lives in
 * `useLyrics.ts` as module state — this file only persists across app
 * restarts. Reads are best-effort and fall back to the network fetch
 * chain if anything goes wrong.
 *
 * Key format: `${serverId}:${songId}` so the same song id on two
 * different Subsonic servers can't collide.
 *
 * TTL:
 *  - Found lyrics: 90 days. Lyrics rarely change once shipped.
 *  - notFound entries: 7 days. Lets the user / server admin add lyrics
 *    later without an indefinite negative cache.
 */
import type { CachedLyrics } from '../../hooks/useLyrics';

const DB_NAME = 'psysonic-lyrics-cache';
const STORE_NAME = 'lyrics';
const TTL_FOUND_MS    = 90 * 24 * 60 * 60 * 1000;
const TTL_NOT_FOUND_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredEntry {
  key: string;
  payload: CachedLyrics;
  timestamp: number;
}

let db: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
  if (db) return Promise.resolve(db);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const database = (e.target as IDBOpenDBRequest).result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = e => {
        db = (e.target as IDBOpenDBRequest).result;
        resolve(db);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export function lyricsCacheKey(serverId: string, songId: string): string {
  return `${serverId}:${songId}`;
}

export async function getCachedLyrics(key: string): Promise<CachedLyrics | null> {
  try {
    const database = await openDB();
    if (!database) return null;
    return await new Promise<CachedLyrics | null>(resolve => {
      const req = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const entry = req.result as StoredEntry | undefined;
        if (!entry) { resolve(null); return; }
        const ttl = entry.payload?.notFound ? TTL_NOT_FOUND_MS : TTL_FOUND_MS;
        if (Date.now() - entry.timestamp > ttl) { resolve(null); return; }
        resolve(entry.payload);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function putCachedLyrics(key: string, payload: CachedLyrics): Promise<void> {
  try {
    const database = await openDB();
    if (!database) return;
    await new Promise<void>(resolve => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ key, payload, timestamp: Date.now() } satisfies StoredEntry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Ignore — fall back to RAM-only behaviour.
  }
}

/** Wipes all entries — exposed for a future "clear cache" Settings action. */
export async function clearLyricsCache(): Promise<void> {
  try {
    const database = await openDB();
    if (!database) return;
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
