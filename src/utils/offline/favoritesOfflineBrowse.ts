import { libraryAdvancedSearch } from '../../api/library';
import type { StarredResults } from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import type { OfflineAlbumMeta } from '../../store/offlineStore';
import {
  albumToAlbum,
  artistToArtist,
  trackToSong,
} from '../library/advancedSearchLocal';
import { countFavoriteAutoTracks, hasAnyOfflineAlbums } from './offlineLibraryHelpers';

/** Favorites page may be browsed offline when auto-save is enabled and the library index exists. */
export function favoritesOfflineBrowseEnabled(): boolean {
  const auth = useAuthStore.getState();
  if (!auth.favoritesOfflineEnabled || !auth.activeServerId) return false;
  return useLibraryIndexStore.getState().isIndexEnabled(auth.activeServerId);
}

export function isOfflineSidebarLibraryNavAllowed(
  navId: string,
  favoritesOfflineBrowse: boolean,
): boolean {
  if (navId === 'favorites') return favoritesOfflineBrowse;
  return false;
}

/** Any offline browsing surface: manual pins and/or saved favorite-auto bytes. */
export function hasOfflineBrowsingContent(
  offlineAlbums: Record<string, OfflineAlbumMeta>,
): boolean {
  if (hasAnyOfflineAlbums(offlineAlbums)) return true;
  if (favoritesOfflineBrowseEnabled() && countFavoriteAutoTracks() > 0) return true;
  return false;
}

export async function loadStarredFromLibraryIndex(serverId: string): Promise<StarredResults> {
  const response = await libraryAdvancedSearch({
    serverId,
    entityTypes: ['artist', 'album', 'track'],
    starredOnly: true,
    limit: 10_000,
  });
  return {
    artists: response.artists.map(artistToArtist),
    albums: response.albums.map(albumToAlbum),
    songs: response.tracks.map(trackToSong),
  };
}
