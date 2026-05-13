import { getArtist } from '../api/subsonicArtists';
import { getAlbum } from '../api/subsonicLibrary';
import { getPlaylist } from '../api/subsonicPlaylists';
import type { SubsonicSong } from '../api/subsonicTypes';
import type { DeviceSyncSource } from '../store/deviceSyncStore';

export async function fetchTracksForSource(source: DeviceSyncSource): Promise<SubsonicSong[]> {
  if (source.type === 'playlist') { const { songs } = await getPlaylist(source.id); return songs; }
  if (source.type === 'album')    { const { songs } = await getAlbum(source.id);    return songs; }
  const { albums } = await getArtist(source.id);
  // Parallel album fetches — Navidrome handles getAlbum requests in flight
  // without serialising. Sequential awaits here multiplied a 50-album artist
  // sync into 50 round-trips (~7 s blocking) before any device write started.
  const results = await Promise.all(
    albums.map(a => getAlbum(a.id).then(r => r.songs).catch(() => [] as SubsonicSong[])),
  );
  return results.flat();
}
