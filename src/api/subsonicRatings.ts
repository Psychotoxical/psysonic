import { getArtist } from './subsonicArtists';
import { getAlbum } from './subsonicLibrary';

const MIX_RATING_PREFETCH_CONCURRENCY = 8;
const RATING_CACHE_TTL = 7 * 60 * 1000; // 7 minutes
const ratingCache = new Map<string, { value: number; expiresAt: number }>();

function getCachedRating(key: string): number | null {
  const entry = ratingCache.get(key);
  if (!entry) return null; // cache miss
  if (Date.now() > entry.expiresAt) { ratingCache.delete(key); return null; }
  return entry.value;
}

function setCachedRating(key: string, value: number): void {
  ratingCache.set(key, { value, expiresAt: Date.now() + RATING_CACHE_TTL });
}

/** Drop cached entity ratings after `setRating` so mixes see fresh stars. */
export function invalidateEntityUserRatingCaches(id: string): void {
  ratingCache.delete(`artist:${ENTITY_RATING_CACHE_KEY_VER}:${id}`);
  ratingCache.delete(`album:${ENTITY_RATING_CACHE_KEY_VER}:${id}`);
}

function parseEntityUserRating(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/** Navidrome and some JSON shapes use `rating` where Subsonic docs say `userRating`. */
export function parseSubsonicEntityStarRating(entity: {
  userRating?: unknown;
  rating?: unknown;
}): number | undefined {
  return parseEntityUserRating(entity.userRating ?? entity.rating);
}

/** Bump when rating parse keys change so stale cache entries are not reused. */
const ENTITY_RATING_CACHE_KEY_VER = 'v2';

/** Parallel `getArtist` calls to fill mix/album filters when list endpoints omit ratings. */
export async function prefetchArtistUserRatings(
  ids: string[],
  concurrency = MIX_RATING_PREFETCH_CONCURRENCY,
): Promise<Map<string, number>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, number>();
  if (!unique.length) return out;
  const uncached: string[] = [];
  for (const id of unique) {
    const cached = getCachedRating(`artist:${ENTITY_RATING_CACHE_KEY_VER}:${id}`);
    if (cached !== null) out.set(id, cached);
    else uncached.push(id);
  }
  if (!uncached.length) return out;
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= uncached.length) return;
      const id = uncached[i];
      try {
        const { artist } = await getArtist(id);
        const r = parseSubsonicEntityStarRating(artist);
        if (r !== undefined && r > 0) {
          setCachedRating(`artist:${ENTITY_RATING_CACHE_KEY_VER}:${id}`, r);
          out.set(id, r);
        }
      } catch {
        /* ignore */
      }
    }
  }
  const nWorkers = Math.min(concurrency, uncached.length);
  await Promise.all(Array.from({ length: nWorkers }, () => worker()));
  return out;
}

/** Parallel `getAlbum` calls when `albumList2` entries lack `userRating`. */
export async function prefetchAlbumUserRatings(
  ids: string[],
  concurrency = MIX_RATING_PREFETCH_CONCURRENCY,
): Promise<Map<string, number>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, number>();
  if (!unique.length) return out;
  const uncached: string[] = [];
  for (const id of unique) {
    const cached = getCachedRating(`album:${ENTITY_RATING_CACHE_KEY_VER}:${id}`);
    if (cached !== null) out.set(id, cached);
    else uncached.push(id);
  }
  if (!uncached.length) return out;
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= uncached.length) return;
      const id = uncached[i];
      try {
        const { album } = await getAlbum(id);
        const r = parseSubsonicEntityStarRating(album);
        if (r !== undefined && r > 0) {
          setCachedRating(`album:${ENTITY_RATING_CACHE_KEY_VER}:${id}`, r);
          out.set(id, r);
        }
      } catch {
        /* ignore */
      }
    }
  }
  const nWorkers = Math.min(concurrency, uncached.length);
  await Promise.all(Array.from({ length: nWorkers }, () => worker()));
  return out;
}
