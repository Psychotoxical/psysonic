import type { ArtistCatalogChunkResult } from '@/lib/library/browseTextSearch';

/** Stable key for the initial Artists catalog chunk (survives Strict Mode remount). */
export function artistBrowseInitialLoadKey(
  serverId: string,
  libraryFilterVersion: number,
  libraryScopeKey: string,
  creditMode: string,
  letterFilter: string,
  starredOnly: boolean,
  offlineBrowseActive: boolean,
): string {
  return [
    serverId,
    String(libraryFilterVersion),
    libraryScopeKey,
    offlineBrowseActive ? 'offline' : 'online',
    creditMode,
    letterFilter,
    String(starredOnly),
  ].join('|');
}

export function clearArtistBrowseCatalogCache(): void {
  inflight.clear();
  cache.clear();
}

const inflight = new Map<string, Promise<ArtistCatalogChunkResult | null>>();
const cache = new Map<string, ArtistCatalogChunkResult>();

export function readArtistBrowseCatalogCache(
  key: string,
): ArtistCatalogChunkResult | undefined {
  return cache.get(key);
}

export function artistBrowseCatalogInflight(key: string): boolean {
  return inflight.has(key);
}

export function storeArtistBrowseCatalogCache(
  key: string,
  result: ArtistCatalogChunkResult,
): void {
  cache.set(key, result);
}

export function artistBrowseCatalogCacheKey(
  loadKey: string,
  chunkSize: number,
  fullChunkSize = 200,
): string {
  return chunkSize >= fullChunkSize ? loadKey : `${loadKey}|boot:${chunkSize}`;
}

/** First grid paint before the full 200-row catalog buffer. */
export const ARTIST_BROWSE_BOOTSTRAP_CHUNK = 60;

export function artistBrowseBootstrapEligible(
  letterFilter: string,
  starredOnly: boolean,
): boolean {
  return !starredOnly && letterFilter === 'ALL';
}

export function fetchArtistBrowseCatalogDeduped(
  key: string,
  run: () => Promise<ArtistCatalogChunkResult | null>,
): Promise<ArtistCatalogChunkResult | null> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = run()
    .then(result => {
      inflight.delete(key);
      if (result != null) cache.set(key, result);
      return result;
    })
    .catch(err => {
      inflight.delete(key);
      throw err;
    });

  inflight.set(key, promise);
  return promise;
}
