import { libraryGetTracksBatchChunked } from '@/lib/api/library';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import type { PinnedGroup } from '@/store/localPlaybackStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { trackToSong } from '@/lib/library/advancedSearchLocal';
import { isManualOfflinePlaylist } from '@/features/offline/utils/pinnedOfflineSync';
import {
  hasLocalLibraryBytes,
  indexKeyBelongsToServer,
} from '@/store/localPlaybackResolve';
import { resolveOfflineAlbumMeta } from '@/features/offline/utils/offlineLibraryHelpers';

function listPlaylistPinnedGroupsForServer(serverId: string): PinnedGroup[] {
  return useLocalPlaybackStore.getState()
    .listPinnedGroups()
    .filter(g => g.pinSource.kind === 'playlist' && indexKeyBelongsToServer(g.serverIndexKey, serverId));
}

function orderedPlayableTrackIds(
  playlistId: string,
  serverId: string,
  group: PinnedGroup,
): string[] {
  const meta = resolveOfflineAlbumMeta(playlistId, serverId);
  const ordered = meta?.trackIds?.length ? meta.trackIds : group.trackIds;
  return ordered.filter(tid => hasLocalLibraryBytes(tid, serverId));
}

/** Cached regular playlists with on-disk bytes for the active server. */
export function playlistsOfflineBrowseEnabled(serverId: string | null | undefined): boolean {
  if (!serverId) return false;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return false;
  return listPlaylistPinnedGroupsForServer(serverId).some(g => {
    if (!isManualOfflinePlaylist(g.pinSource.sourceId, serverId, g.pinSource.displayName)) {
      return false;
    }
    return orderedPlayableTrackIds(g.pinSource.sourceId, serverId, g).length > 0;
  });
}

export async function fetchOfflineBrowsablePlaylists(serverId: string): Promise<SubsonicPlaylist[]> {
  const groups = listPlaylistPinnedGroupsForServer(serverId)
    .filter(g => isManualOfflinePlaylist(g.pinSource.sourceId, serverId, g.pinSource.displayName));

  const playlists: SubsonicPlaylist[] = [];
  for (const group of groups) {
    const playlistId = group.pinSource.sourceId;
    const trackIds = orderedPlayableTrackIds(playlistId, serverId, group);
    if (trackIds.length === 0) continue;

    const meta = resolveOfflineAlbumMeta(playlistId, serverId);
    const refs = trackIds.map(trackId => ({ serverId, trackId }));
    const dtos = await libraryGetTracksBatchChunked(refs);
    const byId = new Map(dtos.map(d => [d.id, d]));
    let duration = 0;
    for (const trackId of trackIds) {
      duration += byId.get(trackId)?.durationSec ?? 0;
    }

    playlists.push({
      id: playlistId,
      name: group.pinSource.displayName ?? meta?.name ?? playlistId,
      songCount: trackIds.length,
      duration,
      created: '',
      changed: '',
      coverArt: meta?.coverArt,
    });
  }

  return playlists.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadOfflineBrowsablePlaylist(
  playlistId: string,
  serverId: string,
): Promise<{ playlist: SubsonicPlaylist; songs: SubsonicSong[] } | null> {
  const group = listPlaylistPinnedGroupsForServer(serverId)
    .find(g => g.pinSource.sourceId === playlistId);
  if (!group) return null;
  if (!isManualOfflinePlaylist(playlistId, serverId, group.pinSource.displayName)) return null;

  const trackIds = orderedPlayableTrackIds(playlistId, serverId, group);
  if (trackIds.length === 0) return null;

  const meta = resolveOfflineAlbumMeta(playlistId, serverId);
  const refs = trackIds.map(trackId => ({ serverId, trackId }));
  const dtos = await libraryGetTracksBatchChunked(refs);
  const byId = new Map(dtos.map(d => [d.id, d]));
  const songs = trackIds
    .map(id => byId.get(id))
    .filter((dto): dto is NonNullable<typeof dto> => !!dto)
    .map(dto => ({ ...trackToSong(dto), serverId }));

  const duration = songs.reduce((sum, song) => sum + (song.duration ?? 0), 0);
  return {
    playlist: {
      id: playlistId,
      name: group.pinSource.displayName ?? meta?.name ?? playlistId,
      songCount: songs.length,
      duration,
      created: '',
      changed: '',
      coverArt: meta?.coverArt,
    },
    songs,
  };
}
