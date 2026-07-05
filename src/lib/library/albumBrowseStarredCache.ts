import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';

type StarredCacheEntry = {
  albums: SubsonicAlbum[];
  fetchedAt: number;
};

const starredAlbumsByServer = new Map<string, StarredCacheEntry>();

/** Drop cached favorites for a server (after star/unstar or server switch). */
export function invalidateStarredAlbumBrowseCache(serverId: string | null | undefined): void {
  if (!serverId) return;
  starredAlbumsByServer.delete(serverId);
}

export function peekStarredAlbumBrowseCache(serverId: string): SubsonicAlbum[] | null {
  const entry = starredAlbumsByServer.get(serverId);
  return entry?.albums ?? null;
}

export function setStarredAlbumBrowseCache(serverId: string, albums: SubsonicAlbum[]): void {
  starredAlbumsByServer.set(serverId, { albums, fetchedAt: Date.now() });
}
