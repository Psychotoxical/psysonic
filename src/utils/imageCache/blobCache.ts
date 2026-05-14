import { MAX_BLOB_CACHE } from './constants';

/** One in-flight read per logical image — avoids duplicate IndexedDB transactions when many cells mount together. */
export const inflightBlobGets = new Map<string, Promise<Blob | null>>();

// In-memory blob cache: cacheKey → Blob (insertion-order = LRU approximation).
// Only the Map entry is dropped on overflow — the underlying Blob is freed by
// the GC once no <img>/<canvas>/object URL still references it.
export const blobCache = new Map<string, Blob>();

export function rememberBlob(key: string, blob: Blob): void {
  blobCache.delete(key); // re-insert at end → marks as recently used
  blobCache.set(key, blob);
  while (blobCache.size > MAX_BLOB_CACHE) {
    const oldest = blobCache.keys().next().value;
    if (!oldest) break;
    blobCache.delete(oldest);
  }
}
