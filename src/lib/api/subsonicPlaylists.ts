import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import { api, apiForServer } from '@/lib/api/subsonicClient';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';

/** Max song-id params per Subsonic GET call (auth + ~8 KiB URL ceiling). */
export const PLAYLIST_SONG_ID_GET_BATCH = 150;

export function chunkIndicesForSubsonicGet(count: number, batchSize = PLAYLIST_SONG_ID_GET_BATCH): number[][] {
  if (count <= 0) return [];
  const batches: number[][] = [];
  let remaining = count;
  while (remaining > 0) {
    const size = Math.min(batchSize, remaining);
    const start = remaining - size;
    batches.push(Array.from({ length: size }, (_, i) => start + i));
    remaining -= size;
  }
  return batches;
}

export function chunkSongIdsForSubsonicGet(ids: string[], batchSize = PLAYLIST_SONG_ID_GET_BATCH): string[][] {
  if (ids.length === 0) return [];
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    batches.push(ids.slice(i, i + batchSize));
  }
  return batches;
}

/** Batch arbitrary removal indices high-to-low so earlier positions stay valid between calls. */
export function chunkRemovalIndicesForSubsonicGet(
  indices: number[],
  batchSize = PLAYLIST_SONG_ID_GET_BATCH,
): number[][] {
  if (indices.length === 0) return [];
  const sorted = [...indices].sort((a, b) => b - a);
  const batches: number[][] = [];
  for (let i = 0; i < sorted.length; i += batchSize) {
    batches.push(sorted.slice(i, i + batchSize));
  }
  return batches;
}

function schedulePinnedPlaylistSync(playlistId: string, serverId?: string): void {
  void import('@/features/offline')
    .then(m => m.schedulePinnedPlaylistSync(playlistId, serverId))
    .catch(() => {});
}

function withoutOrbit(playlists: SubsonicPlaylist[], includeOrbit: boolean): SubsonicPlaylist[] {
  return includeOrbit ? playlists : playlists.filter(p => !p.name.startsWith('__psyorbit_'));
}

async function clearPlaylistSongs(id: string, prevCount: number): Promise<void> {
  for (const indices of chunkIndicesForSubsonicGet(prevCount)) {
    await api('updatePlaylist.view', { playlistId: id, songIndexToRemove: indices });
  }
}

async function clearPlaylistSongsForServer(serverId: string, id: string, prevCount: number): Promise<void> {
  for (const indices of chunkIndicesForSubsonicGet(prevCount)) {
    await apiForServer(serverId, 'updatePlaylist.view', { playlistId: id, songIndexToRemove: indices });
  }
}

export async function getPlaylists(includeOrbit = false): Promise<SubsonicPlaylist[]> {
  const data = await api<{ playlists: { playlist: SubsonicPlaylist[] } }>('getPlaylists.view', { _t: Date.now() });
  const all = data.playlists?.playlist ?? [];
  // Orbit session + outbox playlists are technical internals. They're `public`
  // so guests can reach them, which means they leak into every UI picker and
  // even into the Navidrome web client. Filter them out of every UI call;
  // orbit's own sweep passes `includeOrbit=true`.
  return withoutOrbit(all, includeOrbit);
}

export async function getPlaylistsForServer(
  serverId: string,
  includeOrbit = false,
): Promise<SubsonicPlaylist[]> {
  const data = await apiForServer<{ playlists: { playlist: SubsonicPlaylist[] } }>(
    serverId,
    'getPlaylists.view',
    { _t: Date.now() },
  );
  return withoutOrbit(data.playlists?.playlist ?? [], includeOrbit)
    .map(playlist => ({ ...playlist, serverId }));
}

export async function getPlaylist(id: string): Promise<{ playlist: SubsonicPlaylist; songs: SubsonicSong[] }> {
  const data = await api<{ playlist: SubsonicPlaylist & { entry: SubsonicSong[] } }>('getPlaylist.view', { id });
  const { entry, ...playlist } = data.playlist;
  return { playlist, songs: entry ?? [] };
}

export async function getPlaylistForServer(
  serverId: string,
  id: string,
): Promise<{ playlist: SubsonicPlaylist; songs: SubsonicSong[] }> {
  if (!shouldAttemptSubsonicForServer(serverId)) {
    throw new Error('Subsonic unavailable');
  }
  const data = await apiForServer<{ playlist: SubsonicPlaylist & { entry: SubsonicSong[] } }>(
    serverId,
    'getPlaylist.view',
    { id },
  );
  const { entry, ...playlist } = data.playlist;
  return {
    playlist: { ...playlist, serverId },
    songs: (entry ?? []).map(song => ({ ...song, serverId })),
  };
}

export async function createPlaylist(name: string, songIds?: string[]): Promise<SubsonicPlaylist> {
  const params: Record<string, unknown> = { name };
  if (songIds && songIds.length > 0) {
    params.songId = songIds;
  }
  const data = await api<{ playlist: SubsonicPlaylist }>('createPlaylist.view', params);
  return data.playlist;
}

export async function createPlaylistForServer(
  serverId: string,
  name: string,
  songIds?: string[],
): Promise<SubsonicPlaylist> {
  const params: Record<string, unknown> = { name };
  if (songIds?.length) params.songId = songIds;
  const data = await apiForServer<{ playlist: SubsonicPlaylist }>(serverId, 'createPlaylist.view', params);
  return { ...data.playlist, serverId };
}

/** Append tracks without re-sending the full playlist (avoids GET URL length limits). */
export async function addSongsToPlaylist(id: string, songIdsToAdd: string[]): Promise<void> {
  if (songIdsToAdd.length === 0) return;
  for (const batch of chunkSongIdsForSubsonicGet(songIdsToAdd)) {
    await api('updatePlaylist.view', { playlistId: id, songIdToAdd: batch });
  }
  schedulePinnedPlaylistSync(id);
}

export async function addSongsToPlaylistForServer(
  serverId: string,
  id: string,
  songIdsToAdd: string[],
): Promise<void> {
  if (songIdsToAdd.length === 0) return;
  for (const batch of chunkSongIdsForSubsonicGet(songIdsToAdd)) {
    await apiForServer(serverId, 'updatePlaylist.view', { playlistId: id, songIdToAdd: batch });
  }
  schedulePinnedPlaylistSync(id, serverId);
}

/** Remove tracks by 0-based playlist indices (batched for large playlists). */
export async function removePlaylistSongsAtIndices(id: string, indices: number[]): Promise<void> {
  if (indices.length === 0) return;
  for (const batch of chunkRemovalIndicesForSubsonicGet(indices)) {
    await api('updatePlaylist.view', { playlistId: id, songIndexToRemove: batch });
  }
  schedulePinnedPlaylistSync(id);
}

export async function removePlaylistSongsAtIndicesForServer(
  serverId: string,
  id: string,
  indices: number[],
): Promise<void> {
  if (indices.length === 0) return;
  for (const batch of chunkRemovalIndicesForSubsonicGet(indices)) {
    await apiForServer(serverId, 'updatePlaylist.view', { playlistId: id, songIndexToRemove: batch });
  }
  schedulePinnedPlaylistSync(id, serverId);
}

export async function updatePlaylist(id: string, songIds: string[], prevCount = 0): Promise<void> {
  if (songIds.length > 0) {
    if (songIds.length <= PLAYLIST_SONG_ID_GET_BATCH) {
      // createPlaylist with playlistId replaces the existing playlist's songs (Subsonic API 1.14+)
      await api('createPlaylist.view', { playlistId: id, songId: songIds });
    } else {
      // Lists over the GET batch cap can't replace atomically (URL length limit),
      // so we clear then re-append. A failure between the two steps leaves the
      // server playlist truncated; the caller invalidates the membership cache so
      // the client re-reads truth on next load. This is the unavoidable trade-off
      // for supporting playlists larger than one request can carry.
      let priorCount = prevCount;
      if (priorCount <= 0) {
        const { songs } = await getPlaylist(id);
        priorCount = songs.length;
      }
      if (priorCount > 0) {
        await clearPlaylistSongs(id, priorCount);
      }
      await addSongsToPlaylist(id, songIds);
    }
  } else if (prevCount > 0) {
    await clearPlaylistSongs(id, prevCount);
  }
  schedulePinnedPlaylistSync(id);
}

export async function updatePlaylistForServer(
  serverId: string,
  id: string,
  songIds: string[],
  prevCount = 0,
): Promise<void> {
  if (songIds.length > 0) {
    if (songIds.length <= PLAYLIST_SONG_ID_GET_BATCH) {
      await apiForServer(serverId, 'createPlaylist.view', { playlistId: id, songId: songIds });
    } else {
      let priorCount = prevCount;
      if (priorCount <= 0) {
        const { songs } = await getPlaylistForServer(serverId, id);
        priorCount = songs.length;
      }
      if (priorCount > 0) await clearPlaylistSongsForServer(serverId, id, priorCount);
      await addSongsToPlaylistForServer(serverId, id, songIds);
    }
  } else if (prevCount > 0) {
    await clearPlaylistSongsForServer(serverId, id, prevCount);
  }
  schedulePinnedPlaylistSync(id, serverId);
}

export async function updatePlaylistMeta(
  id: string,
  name: string,
  comment: string,
  isPublic: boolean,
): Promise<void> {
  await api('updatePlaylist.view', { playlistId: id, name, comment, public: isPublic });
}

export async function updatePlaylistMetaForServer(
  serverId: string,
  id: string,
  name: string,
  comment: string,
  isPublic: boolean,
): Promise<void> {
  await apiForServer(serverId, 'updatePlaylist.view', { playlistId: id, name, comment, public: isPublic });
}

export async function uploadPlaylistCoverArt(id: string, file: File): Promise<void> {
  // Navidrome-specific endpoint — handled in Rust to bypass browser CORS restrictions.
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const buffer = await file.arrayBuffer();
  const fileBytes = Array.from(new Uint8Array(buffer));
  const res = await commands.uploadPlaylistCover(baseUrl, id, server?.username ?? '', server?.password ?? '', fileBytes, file.type || 'image/jpeg');
  if (res.status === 'error') throw new Error(res.error);
}

export async function uploadPlaylistCoverArtForServer(serverId: string, id: string, file: File): Promise<void> {
  const server = findServerByIdOrIndexKey(serverId);
  if (!server) throw new Error('Playlist owner unavailable');
  const buffer = await file.arrayBuffer();
  const fileBytes = Array.from(new Uint8Array(buffer));
  const res = await commands.uploadPlaylistCover(
    connectBaseUrlForServer(server),
    id,
    server.username,
    server.password,
    fileBytes,
    file.type || 'image/jpeg',
  );
  if (res.status === 'error') throw new Error(res.error);
}

export async function deletePlaylist(id: string): Promise<void> {
  await api('deletePlaylist.view', { id });
}

export async function deletePlaylistForServer(serverId: string, id: string): Promise<void> {
  await apiForServer(serverId, 'deletePlaylist.view', { id });
}
