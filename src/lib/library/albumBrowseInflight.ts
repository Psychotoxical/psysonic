import type { AlbumBrowsePageResult, AlbumBrowseQuery } from './albumBrowseTypes';

/** Stable key for the initial All Albums catalog chunk (survives Strict Mode remount). */
export function albumBrowseInitialLoadKey(
  serverId: string,
  libraryFilterVersion: number,
  query: AlbumBrowseQuery,
  offlineBrowseActive: boolean,
): string {
  const year = query.year ? `${query.year.from ?? ''}:${query.year.to ?? ''}` : '';
  return [
    serverId,
    String(libraryFilterVersion),
    offlineBrowseActive ? 'offline' : 'online',
    query.sort,
    query.genres.join('\u0001'),
    year,
    String(query.losslessOnly),
    String(query.starredOnly),
    query.compFilter,
  ].join('|');
}

const inflight = new Map<string, Promise<AlbumBrowsePageResult | null>>();
const cache = new Map<string, AlbumBrowsePageResult>();

export function readAlbumBrowseCatalogCache(
  key: string,
): AlbumBrowsePageResult | undefined {
  return cache.get(key);
}

export function albumBrowseCatalogInflight(key: string): boolean {
  return inflight.has(key);
}

export function storeAlbumBrowseCatalogCache(
  key: string,
  result: AlbumBrowsePageResult,
): void {
  cache.set(key, result);
}

export function albumBrowseCatalogCacheKey(
  loadKey: string,
  chunkSize: number,
  fullChunkSize = 200,
): string {
  return chunkSize >= fullChunkSize ? loadKey : `${loadKey}|boot:${chunkSize}`;
}

/** First paint without filters — two virtual-grid pages before the full buffer fetch. */
export const ALBUM_BROWSE_BOOTSTRAP_CHUNK = 60;

export function fetchAlbumBrowseCatalogDeduped(
  key: string,
  run: () => Promise<AlbumBrowsePageResult | null>,
): Promise<AlbumBrowsePageResult | null> {
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
