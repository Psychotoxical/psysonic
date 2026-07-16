import type { QueueItemRef } from '@/lib/media/trackTypes';
import type { ServerProfile } from '@/store/authStoreTypes';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import { apiForServer } from '@/lib/api/subsonicClient';
import {
  addSongsToPlaylistForServer,
  chunkIndicesForSubsonicGet,
  getPlaylistForServer,
  PLAYLIST_SONG_ID_GET_BATCH,
} from '@/lib/api/subsonicPlaylists';

export interface QueueServerSlice {
  server: ServerProfile;
  trackIds: string[];
}

/** Group queue refs by concrete saved server while preserving queue order. */
export function queueServerSlices(refs: QueueItemRef[]): QueueServerSlice[] {
  const slices = new Map<string, QueueServerSlice>();
  for (const ref of refs) {
    const server = findServerByIdOrIndexKey(ref.serverId);
    if (!server) continue;
    const existing = slices.get(server.id);
    if (existing) existing.trackIds.push(ref.trackId);
    else slices.set(server.id, { server, trackIds: [ref.trackId] });
  }
  return [...slices.values()];
}

export async function updateQueuePlaylistForServer(
  serverId: string,
  playlistId: string,
  trackIds: string[],
): Promise<void> {
  if (trackIds.length <= PLAYLIST_SONG_ID_GET_BATCH) {
    await apiForServer(serverId, 'createPlaylist.view', { playlistId, songId: trackIds });
    return;
  }

  const { songs } = await getPlaylistForServer(serverId, playlistId);
  for (const indices of chunkIndicesForSubsonicGet(songs.length)) {
    await apiForServer(serverId, 'updatePlaylist.view', { playlistId, songIndexToRemove: indices });
  }
  await addSongsToPlaylistForServer(serverId, playlistId, trackIds);
}
