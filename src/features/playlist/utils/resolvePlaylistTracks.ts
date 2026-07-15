import { isOfflineBrowseActive, resolveMediaServerId, resolvePlaylist } from '@/features/offline';
import { filterSongsToActiveLibrary } from '@/lib/api/subsonicLibrary';
import { songToTrack } from '@/lib/media/songToTrack';
import type { Track } from '@/lib/media/trackTypes';
import { useAuthStore } from '@/store/authStore';

/**
 * Resolve a playlist's playable tracks from its id alone — the same way the
 * Playlists overview "Play" button does: offline-browse aware via
 * {@link resolvePlaylist}, then scoped to the active library (#1241) when
 * online. Shared by the overview play control and the playlist context-menu
 * queue actions so those paths cannot drift.
 *
 * Best-effort: returns `[]` when the server is unknown or the playlist cannot
 * be resolved, so callers can treat empty as "nothing to enqueue".
 */
export async function resolvePlaylistTracks(playlistId: string): Promise<Track[]> {
  const serverId = resolveMediaServerId(useAuthStore.getState().activeServerId);
  if (!serverId) return [];
  try {
    const data = await resolvePlaylist(serverId, playlistId);
    if (!data) return [];
    // The library-scope filter fetches the album list over the network, so it
    // can reject; swallow to [] so context-menu callers (which run via a
    // no-catch handler) never leak an unhandled rejection.
    const songs = isOfflineBrowseActive()
      ? data.songs
      : await filterSongsToActiveLibrary(data.songs);
    return songs.map(songToTrack);
  } catch {
    return [];
  }
}
