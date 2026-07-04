import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import { api, apiForServer } from '@/lib/api/subsonicClient';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';

export async function getPlaylists(includeOrbit = false): Promise<SubsonicPlaylist[]> {
  const data = await api<{ playlists: { playlist: SubsonicPlaylist[] } }>('getPlaylists.view', { _t: Date.now() });
  const all = data.playlists?.playlist ?? [];
  // Orbit session + outbox playlists are technical internals. They're `public`
  // so guests can reach them, which means they leak into every UI picker and
  // even into the Navidrome web client. Filter them out of every UI call;
  // orbit's own sweep passes `includeOrbit=true`.
  return includeOrbit ? all : all.filter(p => !p.name.startsWith('__psyorbit_'));
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
  return { playlist, songs: entry ?? [] };
}

export async function createPlaylist(name: string, songIds?: string[]): Promise<SubsonicPlaylist> {
  const params: Record<string, unknown> = { name };
  if (songIds && songIds.length > 0) {
    params.songId = songIds;
  }
  const data = await api<{ playlist: SubsonicPlaylist }>('createPlaylist.view', params);
  return data.playlist;
}

export async function updatePlaylist(id: string, songIds: string[], prevCount = 0): Promise<void> {
  if (songIds.length > 0) {
    // createPlaylist with playlistId replaces the existing playlist's songs (Subsonic API 1.14+)
    await api('createPlaylist.view', { playlistId: id, songId: songIds });
  } else if (prevCount > 0) {
    // Axios serialises empty arrays as no params — createPlaylist.view would leave songs unchanged.
    // Use updatePlaylist.view with explicit index removal to clear the list instead.
    await api('updatePlaylist.view', {
      playlistId: id,
      songIndexToRemove: Array.from({ length: prevCount }, (_, i) => i),
    });
  }
  void import('@/features/offline')
    .then(m => m.schedulePinnedPlaylistSync(id))
    .catch(() => {});
}

export async function updatePlaylistMeta(
  id: string,
  name: string,
  comment: string,
  isPublic: boolean,
): Promise<void> {
  await api('updatePlaylist.view', { playlistId: id, name, comment, public: isPublic });
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

export async function deletePlaylist(id: string): Promise<void> {
  await api('deletePlaylist.view', { id });
}
