export const DB_NAME = 'psysonic-img-cache';
export const STORE_NAME = 'images';
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** In-memory blobs — scrolling large grids used to thrash at 200 and re-hit IndexedDB for “cold” keys that still had a live shared object URL. */
export const MAX_BLOB_CACHE = 600; // hot in-memory blob entries (LRU)
/** Network-only pool — IndexedDB hits must not queue behind remote fetches. */
export const MAX_CONCURRENT_NET_FETCHES = 6;
export const URL_REVOKE_DELAY_MS = 500;
