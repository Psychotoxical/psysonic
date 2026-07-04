import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import { api, apiForServer, libraryFilterParams, libraryFilterParamsForServer } from '@/lib/api/subsonicClient';
import { filterSongsToServerLibrary } from '@/lib/api/subsonicLibrary';
import { filterSongsToActiveLibrary, similarSongsRequestCount } from '@/lib/api/subsonicLibrary';
import {
  FEATURE_AUDIOMUSE_SIMILAR_TRACKS,
  OP_SIMILAR_TRACKS,
} from '@/lib/serverCapabilities/catalog';
import { resolveCallRoutesForServer } from '@/lib/serverCapabilities/storeView';
import type {
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicArtistInfo,
  SubsonicSong,
} from '@/lib/api/subsonicTypes';

export async function getArtists(): Promise<SubsonicArtist[]> {
  type ArtistIndexEntry = { artist?: SubsonicArtist | SubsonicArtist[] };
  const data = await api<{ artists?: { index?: ArtistIndexEntry | ArtistIndexEntry[] } }>('getArtists.view', {
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

export async function getArtistForServer(
  serverId: string,
  id: string,
): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] }> {
  const data = await apiForServer<{ artist: SubsonicArtist & { album: SubsonicAlbum[] } }>(serverId, 'getArtist.view', { id });
  const { album, ...artist } = data.artist;
  return { artist, albums: album ?? [] };
}

export async function getArtistInfo(id: string, options?: { similarArtistCount?: number }): Promise<SubsonicArtistInfo> {
  const count = options?.similarArtistCount ?? 5;
  const data = await api<{ artistInfo2: SubsonicArtistInfo }>('getArtistInfo2.view', { id, count, ...libraryFilterParams() });
  return data.artistInfo2 ?? {};
}

export async function getArtistInfoForServer(
  serverId: string,
  id: string,
  options?: { similarArtistCount?: number },
): Promise<SubsonicArtistInfo> {
  const count = options?.similarArtistCount ?? 5;
  const data = await apiForServer<{ artistInfo2: SubsonicArtistInfo }>(
    serverId,
    'getArtistInfo2.view',
    { id, count, ...libraryFilterParamsForServer(serverId) },
  );
  return data.artistInfo2 ?? {};
}

export async function getTopSongs(artist: string): Promise<SubsonicSong[]> {
  const { activeServerId } = useAuthStore.getState();
  if (!activeServerId) return [];
  return getTopSongsForServer(activeServerId, artist);
}

export async function getTopSongsForServer(serverId: string, artist: string): Promise<SubsonicSong[]> {
  try {
    const { musicLibraryFilterByServer } = useAuthStore.getState();
    const scoped = musicLibraryFilterByServer[serverId] && musicLibraryFilterByServer[serverId] !== 'all';
    const topCount = scoped ? 20 : 5;
    const data = await apiForServer<{ topSongs: { song: SubsonicSong[] } }>(
      serverId,
      'getTopSongs.view',
      { artist, count: topCount, ...libraryFilterParamsForServer(serverId) },
    );
    const raw = data.topSongs?.song ?? [];
    const filtered = await filterSongsToServerLibrary(raw, serverId);
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

/**
 * Sonic (audio-analysis) similar tracks via the OpenSubsonic `sonicSimilarity`
 * extension (Navidrome ≥ 0.62 + AudioMuse plugin). Returns `[]` when the server
 * has no provider (HTTP 404) so callers can fall back.
 */
export async function getSonicSimilarTracks(id: string, count = 50): Promise<SubsonicSong[]> {
  try {
    const requestCount = similarSongsRequestCount(count);
    const data = await api<{ sonicMatch: Array<{ entry?: SubsonicSong }> | { entry?: SubsonicSong } }>(
      'getSonicSimilarTracks.view',
      { id, count: requestCount, ...libraryFilterParams() },
    );
    const raw = data.sonicMatch;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const songs = list.map(m => m.entry).filter((e): e is SubsonicSong => !!e);
    if (songs.length === 0) return [];
    const filtered = await filterSongsToActiveLibrary(songs);
    return filtered.slice(0, count);
  } catch {
    return [];
  }
}

/**
 * Capability-routed similar tracks for the active server. Prefers the sonic
 * similarity endpoint when the AudioMuse plugin is detected (Navidrome ≥ 0.62),
 * falling back to legacy `getSimilarSongs` on empty/unavailable.
 */
export async function fetchSimilarTracksRouted(songId: string, count = 50): Promise<SubsonicSong[]> {
  const { activeServerId } = useAuthStore.getState();
  if (!activeServerId) return getSimilarSongs(songId, count);
  const routes = resolveCallRoutesForServer(activeServerId, FEATURE_AUDIOMUSE_SIMILAR_TRACKS, OP_SIMILAR_TRACKS);
  if (routes.length === 0) return getSimilarSongs(songId, count);
  for (const route of routes) {
    const songs = route.transport === 'opensubsonic'
      ? await getSonicSimilarTracks(songId, count)
      : await getSimilarSongs(songId, count);
    if (songs.length > 0) return songs;
  }
  return [];
}

export async function uploadArtistImage(id: string, file: File): Promise<void> {
  // Navidrome-specific endpoint — handled in Rust to bypass browser CORS restrictions.
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const buffer = await file.arrayBuffer();
  const fileBytes = Array.from(new Uint8Array(buffer));
  const res = await commands.uploadArtistImage(baseUrl, id, server?.username ?? '', server?.password ?? '', fileBytes, file.type || 'image/jpeg');
  if (res.status === 'error') throw new Error(res.error);
}
