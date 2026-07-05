import {
  libraryScopeArtistDetail,
  scopePairsFromLibrarySelection,
} from '@/lib/api/library/scopeReads';
import { albumToAlbum, artistToArtist, trackToSong } from '@/lib/library/advancedSearchLocal';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '@/lib/api/subsonicTypes';

export interface ArtistDetailMultiScopePayload {
  artist: SubsonicArtist;
  albums: SubsonicAlbum[];
  topSongs: SubsonicSong[];
}

/**
 * Load priority-deduped artist detail across the user's selected libraries
 * (one or more). Returns null on IPC failure or when the merged artist anchor is missing.
 */
export async function tryLoadArtistDetailMultiScope(
  serverId: string,
  artistId: string,
): Promise<ArtistDetailMultiScopePayload | null> {
  try {
    const response = await libraryScopeArtistDetail(serverId, {
      scopes: scopePairsFromLibrarySelection(serverId),
      artistId,
      serverId,
    });
    if (!response.artist?.id) return null;
    return {
      artist: artistToArtist(response.artist),
      albums: response.albums.map(albumToAlbum),
      topSongs: [...response.tracks.map(trackToSong)].sort(
        (a, b) => (b.playCount ?? 0) - (a.playCount ?? 0),
      ),
    };
  } catch {
    return null;
  }
}
