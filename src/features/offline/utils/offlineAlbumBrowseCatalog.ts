import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import type { AlbumBrowseQuery } from '@/lib/library/albumBrowseTypes';
import { isOfflineBrowseActive } from '@/features/offline/utils/offlineBrowseMode';
import {
  fetchOfflineLocalAlbumCatalogChunk,
  offlineLocalBrowseEnabled,
} from '@/features/offline/utils/offlineLocalBrowse';

type OfflineAlbumCatalogChunk = {
  albums: SubsonicAlbum[];
  hasMore: boolean;
};

/** Offline album grid catalog chunk; null when offline browse or local bytes are unavailable. */
export async function loadOfflineAlbumCatalogChunk(
  serverId: string,
  browseQuery: AlbumBrowseQuery,
  offset: number,
  chunkSize: number,
  starredOverrides: Record<string, boolean>,
): Promise<OfflineAlbumCatalogChunk | null> {
  if (!isOfflineBrowseActive() || !offlineLocalBrowseEnabled(serverId)) return null;
  const chunk = await fetchOfflineLocalAlbumCatalogChunk(
    serverId,
    browseQuery,
    offset,
    chunkSize,
    starredOverrides,
  );
  if (chunk == null) return null;
  return { albums: chunk.albums, hasMore: chunk.hasMore };
}

/** Initial offline album browse load for the albums grid. */
export async function loadOfflineAlbumBrowseInitial(
  serverId: string,
  browseQuery: AlbumBrowseQuery,
  chunkSize: number,
  starredOverrides: Record<string, boolean>,
): Promise<OfflineAlbumCatalogChunk> {
  const first = await loadOfflineAlbumCatalogChunk(
    serverId,
    browseQuery,
    0,
    chunkSize,
    starredOverrides,
  );
  return first ?? { albums: [], hasMore: false };
}
