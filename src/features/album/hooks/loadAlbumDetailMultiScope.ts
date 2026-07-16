import {
  libraryScopeAlbumDetail,
} from '@/lib/api/library/scopeReads';
import type { LibraryScopePair } from '@/lib/api/library';
import { albumToAlbum, trackToSong } from '@/lib/library/advancedSearchLocal';
import type { ResolvedAlbum } from '@/features/offline';

/**
 * Load priority-deduped album detail across the user's selected libraries
 * (one or more). Returns null on IPC failure or when the merged album anchor is missing.
 */
export async function tryLoadAlbumDetailMultiScope(
  serverId: string,
  albumId: string,
  scopes: LibraryScopePair[],
): Promise<ResolvedAlbum | null> {
  try {
    const response = await libraryScopeAlbumDetail(serverId, {
      scopes,
      albumId,
      serverId,
    });
    if (!response.album?.id) return null;
    return {
      album: albumToAlbum(response.album),
      songs: response.tracks.map(trackToSong),
    };
  } catch {
    return null;
  }
}
