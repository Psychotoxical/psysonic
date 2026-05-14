import { blobCache, rememberBlob } from './blobCache';
import { URL_REVOKE_DELAY_MS } from './constants';

// Refcounted object URLs shared across all consumers of the same cacheKey.
// Chromium/WebView2 keys its decoded-image cache by URL, so handing every
// <img> its own URL.createObjectURL forces a fresh decode for each instance —
// catastrophic on Windows even for tiny cover thumbnails. Sharing a single
// URL per cacheKey lets the renderer reuse the decoded bitmap.
type UrlEntry = { url: string; refs: number; revokeTimer: ReturnType<typeof setTimeout> | null };
const urlEntries = new Map<string, UrlEntry>();

export function purgeUrlEntry(cacheKey: string): void {
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

/** Purge every shared URL entry — used by clearImageCache. */
export function clearAllUrlEntries(): void {
  for (const key of Array.from(urlEntries.keys())) purgeUrlEntry(key);
}
