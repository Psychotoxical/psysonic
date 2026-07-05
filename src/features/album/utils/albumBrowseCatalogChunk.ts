import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { dedupeById } from '@/lib/util/dedupeById';
import { isOfflineBrowseActive } from '@/features/offline';
import { loadOfflineAlbumCatalogChunk } from '@/features/offline';
import type { AlbumBrowseQuery } from '@/lib/library/albumBrowseTypes';
import { fetchLocalAlbumCatalogChunk } from '@/lib/library/albumBrowseLoad';

export type AlbumCatalogChunk = {
  albums: SubsonicAlbum[];
  hasMore: boolean;
};

export function mergeAlbumCatalogChunk(
  prev: SubsonicAlbum[],
  chunk: AlbumCatalogChunk,
  append: boolean,
): { albums: SubsonicAlbum[]; offset: number } {
  if (!append) {
    return { albums: chunk.albums, offset: chunk.albums.length };
  }
  const merged = dedupeById([...prev, ...chunk.albums]);
  return { albums: merged, offset: merged.length };
}

/** Local-index or offline-bytes catalog chunk for the albums grid. */
export async function fetchAlbumBrowseCatalogChunk(
  serverId: string,
  indexEnabled: boolean,
  query: AlbumBrowseQuery,
  offset: number,
  chunkSize: number,
  starredOverrides: Record<string, boolean>,
): Promise<AlbumCatalogChunk | null> {
  if (isOfflineBrowseActive()) {
    return loadOfflineAlbumCatalogChunk(
      serverId,
      query,
      offset,
      chunkSize,
      starredOverrides,
    );
  }
  return fetchLocalAlbumCatalogChunk(serverId, indexEnabled, query, offset, chunkSize);
}
