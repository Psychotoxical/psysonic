import type { SubsonicSong } from '@/lib/api/subsonicTypes';

export type CachedSongBrowsePage = {
  songs: SubsonicSong[];
  hasMore: boolean;
  nextCursor?: string | null;
};

type CacheEntry = {
  savedAt: number;
  page: CachedSongBrowsePage;
};

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 8;
const cache = new Map<string, CacheEntry>();

export function readSongBrowsePageCache(key: string): CachedSongBrowsePage | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt >= CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.page;
}

export function writeSongBrowsePageCache(key: string, page: CachedSongBrowsePage): void {
  cache.delete(key);
  cache.set(key, { savedAt: Date.now(), page });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey == null) break;
    cache.delete(oldestKey);
  }
}

export function clearSongBrowsePageCache(): void {
  cache.clear();
}
