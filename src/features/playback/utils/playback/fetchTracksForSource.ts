import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { DeviceSyncSource } from '@/features/deviceSync';
import {
  resolveAlbum,
  resolveArtist,
  resolveMediaServerId,
  resolvePlaylist,
} from '@/store/mediaResolver';

export async function fetchTracksForSource(source: DeviceSyncSource): Promise<SubsonicSong[]> {
  const serverId = resolveMediaServerId();
  if (!serverId) return [];

  if (source.type === 'playlist') {
    const result = await resolvePlaylist(serverId, source.id);
    return result?.songs ?? [];
  }
  if (source.type === 'album') {
    const result = await resolveAlbum(serverId, source.id);
    return result?.songs ?? [];
  }

  const artistData = await resolveArtist(serverId, source.id);
  if (!artistData) return [];

  const results = await Promise.all(
    artistData.albums.map(a =>
      resolveAlbum(serverId, a.id).then(r => r?.songs ?? []).catch(() => [] as SubsonicSong[]),
    ),
  );
  return results.flat();
}
