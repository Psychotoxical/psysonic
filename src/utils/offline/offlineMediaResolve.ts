import { getAlbumForServer } from '../../api/subsonicLibrary';
import { getArtistForServer } from '../../api/subsonicArtists';
import { getPlaylistForServer } from '../../api/subsonicPlaylists';
import type {
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicPlaylist,
  SubsonicSong,
} from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';
import { shouldAttemptSubsonicForServer } from '../network/subsonicNetworkGuard';
import { isOfflineBrowseActive } from './offlineBrowseMode';
import { libraryIsReady } from '../library/libraryReady';
import {
  loadAlbumFromLibraryIndex,
  loadArtistFromLibraryIndex,
} from './offlineLibraryIndexLoad';
import {
  loadAlbumFromLocalPlayback,
  loadArtistFromLocalPlayback,
  offlineLocalBrowseEnabled,
} from './offlineLocalBrowse';
import {
  loadOfflineBrowsablePlaylist,
  playlistsOfflineBrowseEnabled,
} from './offlinePlaylistBrowse';

export type ResolvedAlbum = { album: SubsonicAlbum; songs: SubsonicSong[] };

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

/** @deprecated Use {@link resolveAlbum}. */
export const resolveAlbumForServer = resolveAlbum;

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

export function resolveMediaServerId(explicit?: string | null): string | null {
  return explicit ?? useAuthStore.getState().activeServerId;
}

/** Resolve album for active server when `serverId` omitted. */
export async function resolveAlbumForActiveServer(
  albumId: string,
  serverId?: string,
): Promise<ResolvedAlbum | null> {
  const sid = serverId ?? useAuthStore.getState().activeServerId;
  if (!sid) return null;
  return resolveAlbum(sid, albumId);
}
