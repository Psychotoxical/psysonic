import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 8;

export type LosslessRailCacheEntry = {
  albums: SubsonicAlbum[];
  status: 'ready' | 'empty';
  savedAt: number;
};

const cache = new Map<string, LosslessRailCacheEntry>();

export function readLosslessRailCache(key: string): LosslessRailCacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

export function writeLosslessRailCache(
  key: string,
  entry: Omit<LosslessRailCacheEntry, 'savedAt'>,
): void {
  cache.delete(key);
  cache.set(key, { ...entry, savedAt: Date.now() });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

export function resetLosslessRailCacheForTests(): void {
  cache.clear();
}
