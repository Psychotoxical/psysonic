import { useAuthStore } from '../store/authStore';
import { api, libraryFilterParams } from './subsonicClient';
import { filterSongsToActiveLibrary, similarSongsRequestCount } from './subsonicLibrary';
import type {
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicArtistInfo,
  SubsonicSong,
} from './subsonicTypes';

export async function getArtists(): Promise<SubsonicArtist[]> {
  const data = await api<{ artists: { index: any } }>('getArtists.view', {
    ...libraryFilterParams(),
  });
  const rawIdx = data.artists?.index;
  const indices = Array.isArray(rawIdx) ? rawIdx : (rawIdx ? [rawIdx] : []);
  const artists: SubsonicArtist[] = [];
  for (const idx of indices) {
    const rawArt = idx.artist;
    const arr = Array.isArray(rawArt) ? rawArt : (rawArt ? [rawArt] : []);
    artists.push(...arr);
  }
  return artists;
}

export async function getArtist(id: string): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] }> {
  const data = await api<{ artist: SubsonicArtist & { album: SubsonicAlbum[] } }>('getArtist.view', { id });
  const { album, ...artist } = data.artist;
  return { artist, albums: album ?? [] };
}

export async function getArtistInfo(id: string, options?: { similarArtistCount?: number }): Promise<SubsonicArtistInfo> {
  const count = options?.similarArtistCount ?? 5;
  const data = await api<{ artistInfo2: SubsonicArtistInfo }>('getArtistInfo2.view', { id, count, ...libraryFilterParams() });
  return data.artistInfo2 ?? {};
}

export async function getTopSongs(artist: string): Promise<SubsonicSong[]> {
  try {
    const { activeServerId, musicLibraryFilterByServer } = useAuthStore.getState();
    const scoped = activeServerId && musicLibraryFilterByServer[activeServerId] && musicLibraryFilterByServer[activeServerId] !== 'all';
    const topCount = scoped ? 20 : 5;
    const data = await api<{ topSongs: { song: SubsonicSong[] } }>('getTopSongs.view', { artist, count: topCount, ...libraryFilterParams() });
    const raw = data.topSongs?.song ?? [];
    const filtered = await filterSongsToActiveLibrary(raw);
    return filtered.slice(0, 5);
  } catch {
    return [];
  }
}

export async function getSimilarSongs2(id: string, count = 50): Promise<SubsonicSong[]> {
  try {
    const requestCount = similarSongsRequestCount(count);
    const data = await api<{ similarSongs2: { song: SubsonicSong[] } }>('getSimilarSongs2.view', { id, count: requestCount, ...libraryFilterParams() });
    const raw = data.similarSongs2?.song ?? [];
    const filtered = await filterSongsToActiveLibrary(raw);
    return filtered.slice(0, count);
  } catch {
    return [];
  }
}

/** Similar tracks for a song id (Subsonic `getSimilarSongs`) — Navidrome + AudioMuse Instant Mix. */
export async function getSimilarSongs(id: string, count = 50): Promise<SubsonicSong[]> {
  try {
    const requestCount = similarSongsRequestCount(count);
    const data = await api<{ similarSongs: { song: SubsonicSong | SubsonicSong[] } }>('getSimilarSongs.view', { id, count: requestCount, ...libraryFilterParams() });
    const raw = data.similarSongs?.song;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const filtered = await filterSongsToActiveLibrary(list);
    return filtered.slice(0, count);
  } catch {
    return [];
  }
}
