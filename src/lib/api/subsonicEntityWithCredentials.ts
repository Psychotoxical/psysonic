import { apiWithCredentials, type ServerHttpHeaderProfile } from '@/lib/api/subsonicClient';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '@/lib/api/subsonicTypes';

export async function getSongWithCredentials(
  serverUrl: string,
  username: string,
  password: string,
  id: string,
  headerProfile?: ServerHttpHeaderProfile,
): Promise<SubsonicSong | null> {
  try {
    const data = await apiWithCredentials<{ song: SubsonicSong }>(
      serverUrl,
      username,
      password,
      'getSong.view',
      { id },
      15000,
      headerProfile,
    );
    return data.song ?? null;
  } catch {
    return null;
  }
}

export async function getAlbumWithCredentials(
  serverUrl: string,
  username: string,
  password: string,
  id: string,
  headerProfile?: ServerHttpHeaderProfile,
): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] }> {
  const data = await apiWithCredentials<{ album: SubsonicAlbum & { song: SubsonicSong[] } }>(
    serverUrl,
    username,
    password,
    'getAlbum.view',
    { id },
    15000,
    headerProfile,
  );
  const { song, ...album } = data.album;
  return { album, songs: song ?? [] };
}

export async function getArtistWithCredentials(
  serverUrl: string,
  username: string,
  password: string,
  id: string,
  headerProfile?: ServerHttpHeaderProfile,
): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] }> {
  const data = await apiWithCredentials<{ artist: SubsonicArtist & { album: SubsonicAlbum[] } }>(
    serverUrl,
    username,
    password,
    'getArtist.view',
    { id },
    15000,
    headerProfile,
  );
  const { album, ...artist } = data.artist;
  return { artist, albums: album ?? [] };
}
