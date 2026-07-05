import { libraryReconcileAlbumStars } from '@/lib/api/library';
import { getStarred } from '@/lib/api/subsonicStarRating';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import {
  invalidateStarredAlbumBrowseCache,
  setStarredAlbumBrowseCache,
} from './albumBrowseStarredCache';

function parseAlbumStarredAtMs(album: SubsonicAlbum): number {
  if (!album.starred) return Date.now();
  const parsed = Date.parse(album.starred);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function markServerStarredAlbums(albums: SubsonicAlbum[]): SubsonicAlbum[] {
  return albums.map(a => ({ ...a, starred: a.starred ?? 'true' }));
}

/**
 * `getStarred2` → `album.starred_at` in the local index (UPDATE only).
 * Updates the in-memory favorites cache used for instant Albums browse.
 */
export async function refreshStarredAlbumIndexFromServer(
  serverId: string,
  indexEnabled: boolean,
): Promise<SubsonicAlbum[]> {
  const { albums } = await getStarred();
  const mapped = markServerStarredAlbums(albums);
  if (indexEnabled) {
    await libraryReconcileAlbumStars({
      serverId,
      starredAlbums: mapped.map(a => ({
        id: a.id,
        starredAt: parseAlbumStarredAtMs(a),
      })),
    });
  }
  setStarredAlbumBrowseCache(serverId, mapped);
  return mapped;
}

export function invalidateStarredAlbumBrowse(serverId: string | null | undefined): void {
  invalidateStarredAlbumBrowseCache(serverId);
}
