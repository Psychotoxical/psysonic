import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import { api, apiForServer } from '@/lib/api/subsonicClient';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { ndListPlaylists, type NdSmartPlaylist } from '@/lib/api/navidromeSmart';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import { isNavidromeServer } from '@/lib/server/subsonicServerIdentity';
import { hasNavidromeSmartRules } from '@/lib/format/playlistClassification';

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

function callPlaylistApi<T>(
  serverId: string | undefined,
  endpoint: string,
  params: Record<string, unknown>,
): Promise<T> {
  return serverId ? apiForServer<T>(serverId, endpoint, params) : api<T>(endpoint, params);
}

export function applyNativePlaylistSmartMetadata(
  playlists: readonly SubsonicPlaylist[],
  nativePlaylists: readonly Pick<NdSmartPlaylist, 'id' | 'rules'>[],
): SubsonicPlaylist[] {
  const nativeById = new Map(nativePlaylists.map(playlist => [playlist.id, playlist]));
  return playlists.map(playlist => ({
    ...playlist,
    smart: hasNavidromeSmartRules(nativeById.get(playlist.id)?.rules),
  }));
}

function shouldFetchNativePlaylistMetadata(serverId: string | undefined): boolean {
  const auth = useAuthStore.getState();
  const server = serverId ? findServerByIdOrIndexKey(serverId) : auth.getActiveServer();
  return Boolean(server && isNavidromeServer(auth.subsonicServerIdentityByServer[server.id]));
}

async function addNativePlaylistSmartMetadata(
  playlists: SubsonicPlaylist[],
  serverId: string | undefined,
): Promise<SubsonicPlaylist[]> {
  if (!shouldFetchNativePlaylistMetadata(serverId)) return playlists;
  try {
    return applyNativePlaylistSmartMetadata(playlists, await ndListPlaylists(serverId));
  } catch {
    // Classification remains unknown so callers can use the legacy name fallback.
    return playlists;
  }
}

async function clearPlaylistSongs(id: string, prevCount: number, serverId?: string): Promise<void> {
  for (const indices of chunkIndicesForSubsonicGet(prevCount)) {
    await callPlaylistApi(serverId, 'updatePlaylist.view', { playlistId: id, songIndexToRemove: indices });
  }
}

export async function getPlaylists(includeOrbit = false): Promise<SubsonicPlaylist[]> {
  const data = await api<{ playlists: { playlist: SubsonicPlaylist[] } }>('getPlaylists.view', { _t: Date.now() });
  const all = data.playlists?.playlist ?? [];
  // Orbit session + outbox playlists are technical internals. They're `public`
  // so guests can reach them, which means they leak into every UI picker and
  // even into the Navidrome web client. Filter them out of every UI call;
  // orbit's own sweep passes `includeOrbit=true`.
  const visible = includeOrbit ? all : all.filter(p => !p.name.startsWith('__psyorbit_'));
  return addNativePlaylistSmartMetadata(visible, useAuthStore.getState().activeServerId ?? undefined);
}

export async function getPlaylistsForServer(
  serverId: string,
  includeOrbit = false,
): Promise<SubsonicPlaylist[]> {
  if (!shouldAttemptSubsonicForServer(serverId)) throw new Error('Subsonic unavailable');
  const data = await apiForServer<{ playlists: { playlist: SubsonicPlaylist[] } }>(
    serverId,
    'getPlaylists.view',
    { _t: Date.now() },
  );
  const all = data.playlists?.playlist ?? [];
  const visible = includeOrbit ? all : all.filter(p => !p.name.startsWith('__psyorbit_'));
  return addNativePlaylistSmartMetadata(
    visible.map(playlist => ({ ...playlist, serverId })),
    serverId,
  );
}

export interface PlaylistsForServersResult {
  playlists: SubsonicPlaylist[];
  failedServerIds: string[];
}

/** Aggregate playlists in server-priority order while retaining failed-owner metadata. */
export async function getPlaylistsForServersSettled(serverIds: string[]): Promise<PlaylistsForServersResult> {
  const uniqueServerIds = [...new Set(serverIds.filter(Boolean))];
  const results = await Promise.allSettled(uniqueServerIds.map(serverId => getPlaylistsForServer(serverId)));
  return {
    playlists: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    failedServerIds: uniqueServerIds.filter((_serverId, index) => results[index]?.status === 'rejected'),
  };
}

/** Aggregate playlists in server-priority order; one failed server does not hide the rest. */
export async function getPlaylistsForServers(serverIds: string[]): Promise<SubsonicPlaylist[]> {
  return (await getPlaylistsForServersSettled(serverIds)).playlists;
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

export async function createPlaylist(name: string, songIds?: string[], serverId?: string): Promise<SubsonicPlaylist> {
  const params: Record<string, unknown> = { name };
  if (songIds && songIds.length > 0) {
    params.songId = songIds;
  }
  const data = await callPlaylistApi<{ playlist: SubsonicPlaylist }>(serverId, 'createPlaylist.view', params);
  return serverId ? { ...data.playlist, serverId } : data.playlist;
}

/** Append tracks without re-sending the full playlist (avoids GET URL length limits). */
export async function addSongsToPlaylist(id: string, songIdsToAdd: string[], serverId?: string): Promise<void> {
  if (songIdsToAdd.length === 0) return;
  for (const batch of chunkSongIdsForSubsonicGet(songIdsToAdd)) {
    await callPlaylistApi(serverId, 'updatePlaylist.view', { playlistId: id, songIdToAdd: batch });
  }
  schedulePinnedPlaylistSync(id, serverId);
}

/** Remove tracks by 0-based playlist indices (batched for large playlists). */
export async function removePlaylistSongsAtIndices(id: string, indices: number[], serverId?: string): Promise<void> {
  if (indices.length === 0) return;
  for (const batch of chunkRemovalIndicesForSubsonicGet(indices)) {
    await callPlaylistApi(serverId, 'updatePlaylist.view', { playlistId: id, songIndexToRemove: batch });
  }
  schedulePinnedPlaylistSync(id, serverId);
}

export async function updatePlaylist(id: string, songIds: string[], prevCount = 0, serverId?: string): Promise<void> {
  if (songIds.length > 0) {
    if (songIds.length <= PLAYLIST_SONG_ID_GET_BATCH) {
      // createPlaylist with playlistId replaces the existing playlist's songs (Subsonic API 1.14+)
      await callPlaylistApi(serverId, 'createPlaylist.view', { playlistId: id, songId: songIds });
    } else {
      // Lists over the GET batch cap can't replace atomically (URL length limit),
      // so we clear then re-append. A failure between the two steps leaves the
      // server playlist truncated; the caller invalidates the membership cache so
      // the client re-reads truth on next load. This is the unavoidable trade-off
      // for supporting playlists larger than one request can carry.
      let priorCount = prevCount;
      if (priorCount <= 0) {
        const { songs } = serverId ? await getPlaylistForServer(serverId, id) : await getPlaylist(id);
        priorCount = songs.length;
      }
      if (priorCount > 0) {
        await clearPlaylistSongs(id, priorCount, serverId);
      }
      await addSongsToPlaylist(id, songIds, serverId);
    }
  } else if (prevCount > 0) {
    await clearPlaylistSongs(id, prevCount, serverId);
  }
  schedulePinnedPlaylistSync(id, serverId);
}

export async function updatePlaylistMeta(
  id: string,
  name: string,
  comment: string,
  isPublic: boolean,
  serverId?: string,
): Promise<void> {
  await callPlaylistApi(serverId, 'updatePlaylist.view', { playlistId: id, name, comment, public: isPublic });
}

export async function uploadPlaylistCoverArt(id: string, file: File, serverId?: string): Promise<void> {
  // Navidrome-specific endpoint — handled in Rust to bypass browser CORS restrictions.
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = serverId ? findServerByIdOrIndexKey(serverId) : getActiveServer();
  if (!server) throw new Error('Server unavailable');
  const baseUrl = serverId ? connectBaseUrlForServer(server) : getBaseUrl();
  const buffer = await file.arrayBuffer();
  const fileBytes = Array.from(new Uint8Array(buffer));
  const res = await commands.uploadPlaylistCover(baseUrl, id, server?.username ?? '', server?.password ?? '', fileBytes, file.type || 'image/jpeg');
  if (res.status === 'error') throw new Error(res.error);
}

export async function deletePlaylist(id: string, serverId?: string): Promise<void> {
  await callPlaylistApi(serverId, 'deletePlaylist.view', { id });
}
