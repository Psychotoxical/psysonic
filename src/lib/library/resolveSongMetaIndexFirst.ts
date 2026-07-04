import { libraryGetTrack } from '@/lib/api/library';
import { getSongForServer } from '@/lib/api/subsonicLibrary';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { trackToSong } from '@/lib/library/trackDtoMapping';
import { libraryIsReady } from '@/lib/library/libraryReady';

/**
 * Index-first song metadata: local SQLite (`libraryGetTrack`) when the index is
 * ready, else Subsonic `getSong.view`. Shared by playback prefetch, Now Playing,
 * and the queue resolver's network fallback family.
 */
export async function resolveSongMetaIndexFirst(
  serverId: string,
  songId: string,
): Promise<SubsonicSong | null> {
  if (await libraryIsReady(serverId)) {
    try {
      const dto = await libraryGetTrack(serverId, songId);
      if (dto) return trackToSong(dto);
    } catch { /* index error → network fallback */ }
  }
  return getSongForServer(serverId, songId);
}
