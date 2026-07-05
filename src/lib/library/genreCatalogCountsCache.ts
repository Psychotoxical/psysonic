import type { SubsonicGenre } from '@/lib/api/subsonicTypes';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';

/** Fresh hits skip SQLite entirely. */
const FRESH_TTL_MS = 60 * 60 * 1000;
/** Stale entries still render while a background refresh runs. */
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CacheEntry = {
  genres: SubsonicGenre[];
  fetchedAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SubsonicGenre[]>>();

export function genreCatalogCacheKey(serverId: string, libraryScope?: string): string {
  const resolved = resolveServerIdForIndexKey(serverId);
  const folder = libraryScope?.trim() ? libraryScope.trim() : 'all';
  return `${resolved}:${folder}`;
}

function entryAge(entry: CacheEntry): number {
  return Date.now() - entry.fetchedAt;
}

function findGenreInCatalog(genres: SubsonicGenre[], genre: string): SubsonicGenre | undefined {
  return genres.find(g => g.value.localeCompare(genre, undefined, { sensitivity: 'accent' }) === 0);
}

export function peekGenreCatalogCache(
  serverId: string,
  libraryScope?: string,
  allowStale = false,
): SubsonicGenre[] | null {
  const entry = cache.get(genreCatalogCacheKey(serverId, libraryScope));
  if (!entry) return null;
  const age = entryAge(entry);
  if (age <= FRESH_TTL_MS) return entry.genres;
  if (allowStale && age <= STALE_TTL_MS) return entry.genres;
  return null;
}

export function lookupGenreAlbumCount(
  serverId: string,
  genre: string,
  libraryScope?: string,
): number | null {
  const entry = cache.get(genreCatalogCacheKey(serverId, libraryScope));
  if (!entry || entryAge(entry) > STALE_TTL_MS) return null;
  return findGenreInCatalog(entry.genres, genre)?.albumCount ?? null;
}

export function writeGenreCatalogCache(
  serverId: string,
  libraryScope: string | undefined,
  genres: SubsonicGenre[],
): void {
  cache.set(genreCatalogCacheKey(serverId, libraryScope), {
    genres,
    fetchedAt: Date.now(),
  });
}

export function invalidateGenreCatalogCache(serverId?: string): void {
  if (!serverId) {
    cache.clear();
    inflight.clear();
    return;
  }
  const resolved = resolveServerIdForIndexKey(serverId);
  const prefix = `${resolved}:`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}

export function getInflightGenreCatalog(key: string): Promise<SubsonicGenre[]> | undefined {
  return inflight.get(key);
}

export function trackInflightGenreCatalog(key: string, promise: Promise<SubsonicGenre[]>): void {
  inflight.set(key, promise);
  void promise.finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
}

/** Test-only reset. */
export function resetGenreCatalogCountsCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
