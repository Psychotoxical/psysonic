import { getAlbumForServer } from '@/lib/api/subsonicLibrary';
import { getArtistForServer } from '@/lib/api/subsonicArtists';
import { getPlaylistForServer } from '@/lib/api/subsonicPlaylists';
import type {
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicPlaylist,
  SubsonicSong,
} from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import { isOfflineBrowseActive } from '@/features/offline/utils/offlineBrowseMode';
import { libraryIsReady } from '@/lib/library/libraryReady';
import { registerMediaResolver } from '@/store/mediaResolver';
import {
  loadAlbumFromLibraryIndex,
  loadArtistFromLibraryIndex,
} from '@/features/offline/utils/offlineLibraryIndexLoad';
import {
  loadAlbumFromLocalPlayback,
  loadArtistFromLocalPlayback,
  offlineLocalBrowseEnabled,
} from '@/features/offline/utils/offlineLocalBrowse';
import {
  loadOfflineBrowsablePlaylist,
  playlistsOfflineBrowseEnabled,
} from '@/features/offline/utils/offlinePlaylistBrowse';

// resolveAlbumForServer / resolveMediaServerId / resolveAlbumForActiveServer +
// the ResolvedAlbum type now live in the core seam; re-exported so the
// @/features/offline barrel keeps surfacing them for UI consumers.
import type { ResolvedAlbum } from '@/store/mediaResolver';
export type { ResolvedAlbum };
export {
  resolveAlbumForServer,
  resolveMediaServerId,
  resolveAlbumForActiveServer,
} from '@/store/mediaResolver';

/**
 * Album detail / play / enqueue: the local SQLite index first when it is ready
 * (same data genre browse reads, no network round-trip, works offline), then the
 * network album when reachable (complete track list), then the index as fallback.
 * Local bytes when offline browse is active.
 */
export async function resolveAlbum(
  serverId: string,
  albumId: string,
): Promise<ResolvedAlbum | null> {
  if (isOfflineBrowseActive() && offlineLocalBrowseEnabled(serverId)) {
    return loadAlbumFromLocalPlayback(serverId, albumId);
  }
  if (await libraryIsReady(serverId)) {
    try {
      const hit = await loadAlbumFromLibraryIndex(serverId, albumId);
      if (hit) return hit;
    } catch { /* index error → network fallback */ }
  }
  const favoritesOffline = useAuthStore.getState().favoritesOfflineEnabled;
  const networkAllowed = shouldAttemptSubsonicForServer(serverId);

  if (networkAllowed) {
    try {
      const data = await getAlbumForServer(serverId, albumId);
      return { album: data.album, songs: data.songs };
    } catch {
      /* fall through to library index */
    }
  } else if (!favoritesOffline) {
    return null;
  }

  try {
    return await loadAlbumFromLibraryIndex(serverId, albumId);
  } catch {
    return null;
  }
}

export async function resolveArtist(
  serverId: string,
  artistId: string,
): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] } | null> {
  if (isOfflineBrowseActive() && offlineLocalBrowseEnabled(serverId)) {
    return loadArtistFromLocalPlayback(serverId, artistId);
  }
  const favoritesOffline = useAuthStore.getState().favoritesOfflineEnabled;
  const networkAllowed = shouldAttemptSubsonicForServer(serverId);

  if (networkAllowed) {
    try {
      return await getArtistForServer(serverId, artistId);
    } catch {
      /* fall through */
    }
  } else if (!favoritesOffline) {
    return null;
  }

  try {
    return await loadArtistFromLibraryIndex(serverId, artistId);
  } catch {
    return null;
  }
}

export async function resolvePlaylist(
  serverId: string,
  playlistId: string,
): Promise<{ playlist: SubsonicPlaylist; songs: SubsonicSong[] } | null> {
  if (isOfflineBrowseActive() && playlistsOfflineBrowseEnabled(serverId)) {
    const offline = await loadOfflineBrowsablePlaylist(playlistId, serverId);
    if (offline) return offline;
  }

  if (!shouldAttemptSubsonicForServer(serverId)) return null;

  try {
    return await getPlaylistForServer(serverId, playlistId);
  } catch {
    return null;
  }
}

// Install the offline-aware policy into the core seam. Runs at module init,
// which happens at boot because AppShell eagerly imports the @/features/offline
// barrel (export * evaluates this module).
registerMediaResolver({ resolveAlbum, resolveArtist, resolvePlaylist });
