import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import {
  api,
  apiForServer,
  libraryFilterParams,
  libraryFilterParamsForServer,
  librarySelectionForServer,
} from '@/lib/api/subsonicClient';
import { filterSongsToServerLibrary, similarSongsRequestCount } from '@/lib/api/subsonicLibrary';
import {
  FEATURE_AUDIOMUSE_SIMILAR_TRACKS,
  OP_SIMILAR_TRACKS,
} from '@/lib/serverCapabilities/catalog';
import { resolveCallRoutesForServer } from '@/lib/serverCapabilities/storeView';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import type {
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicArtistInfo,
  SubsonicSong,
} from '@/lib/api/subsonicTypes';

export type SubsonicArtistInfoForServer = Omit<SubsonicArtistInfo, 'similarArtist'> & {
  similarArtist?: Array<NonNullable<SubsonicArtistInfo['similarArtist']>[number] & { serverId: string }>;
};

export async function getArtists(): Promise<SubsonicArtist[]> {
  return fetchArtistsWithParams(libraryFilterParams());
}

/** Merge artist indexes from several music folders (many servers ignore multi `musicFolderId`). */
export async function getArtistsAcrossLibraries(libraryIds: string[]): Promise<SubsonicArtist[]> {
  if (libraryIds.length === 0) return getArtists();
  if (libraryIds.length === 1) {
    return fetchArtistsWithParams({ musicFolderId: libraryIds[0]! });
  }
  const byId = new Map<string, SubsonicArtist>();
  for (const libraryId of libraryIds) {
    const batch = await fetchArtistsWithParams({ musicFolderId: libraryId }).catch(() => []);
    for (const artist of batch) byId.set(artist.id, artist);
  }
  return [...byId.values()];
}

async function fetchArtistsWithParams(
  params: Record<string, string | number | string[]>,
): Promise<SubsonicArtist[]> {
  type ArtistIndexEntry = { artist?: SubsonicArtist | SubsonicArtist[] };
  const data = await api<{ artists?: { index?: ArtistIndexEntry | ArtistIndexEntry[] } }>('getArtists.view', params);
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

async function fetchArtistsForServerWithParams(
  serverId: string,
  params: Record<string, string | number | string[]>,
  timeout: number,
): Promise<SubsonicArtist[]> {
  type ArtistIndexEntry = { artist?: SubsonicArtist | SubsonicArtist[] };
  const data = await apiForServer<{ artists?: { index?: ArtistIndexEntry | ArtistIndexEntry[] } }>(
    serverId,
    'getArtists.view',
    params,
    timeout,
  );
  const rawIdx = data.artists?.index;
  const indices = Array.isArray(rawIdx) ? rawIdx : (rawIdx ? [rawIdx] : []);
  const artists: SubsonicArtist[] = [];
  for (const idx of indices) {
    const rawArt = idx.artist;
    const arr = Array.isArray(rawArt) ? rawArt : (rawArt ? [rawArt] : []);
    artists.push(...arr.map(artist => ({ ...artist, serverId })));
  }
  return artists;
}

/** Merge explicit-server artist indexes per folder because many servers ignore multi `musicFolderId`. */
export async function getArtistsForServer(
  serverId: string,
  timeout = 15000,
  explicitLibraryIds?: readonly string[],
): Promise<SubsonicArtist[]> {
  const libraryIds = explicitLibraryIds ?? librarySelectionForServer(serverId);
  if (libraryIds.length <= 1) {
    return fetchArtistsForServerWithParams(
      serverId,
      libraryIds.length === 1 ? { musicFolderId: libraryIds[0]! } : libraryFilterParamsForServer(serverId),
      timeout,
    );
  }
  const byId = new Map<string, SubsonicArtist>();
  for (const libraryId of libraryIds) {
    const batch = await fetchArtistsForServerWithParams(serverId, { musicFolderId: libraryId }, timeout).catch(() => []);
    for (const artist of batch) byId.set(artist.id, artist);
  }
  return [...byId.values()];
}

export async function getArtist(id: string): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] }> {
  const data = await api<{ artist: SubsonicArtist & { album: SubsonicAlbum[] } }>('getArtist.view', {
    id,
    ...libraryFilterParams(),
  });
  const { album, ...artist } = data.artist;
  return { artist, albums: album ?? [] };
}

export async function getArtistForServer(
  serverId: string,
  id: string,
  options?: { timeout?: number; libraryIds?: readonly string[] },
): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] }> {
  const libraryIds = options?.libraryIds ?? librarySelectionForServer(serverId);
  const fetchForLibrary = async (libraryId?: string) => {
    const data = await apiForServer<{ artist: SubsonicArtist & { album: SubsonicAlbum[] } }>(
      serverId,
      'getArtist.view',
      {
        id,
        ...(libraryId
          ? { musicFolderId: libraryId }
          : options?.libraryIds
            ? {}
            : libraryFilterParamsForServer(serverId)),
      },
      options?.timeout,
    );
    const { album, ...rawArtist } = data.artist;
    return {
      artist: { ...rawArtist, serverId },
      albums: (album ?? []).map(entry => ({ ...entry, serverId })),
    };
  };
  if (options?.libraryIds === undefined) return fetchForLibrary();
  if (libraryIds.length <= 1) return fetchForLibrary(libraryIds[0]);

  const responses = await Promise.all(libraryIds.map(libraryId => (
    fetchForLibrary(libraryId).catch(() => null)
  )));
  const first = responses.find(response => response != null);
  if (!first) throw new Error('Artist unavailable in selected libraries');
  const albums = new Map<string, SubsonicAlbum>();
  for (const response of responses) {
    for (const album of response?.albums ?? []) albums.set(album.id, album);
  }
  return { artist: first.artist, albums: [...albums.values()] };
}

export async function getArtistInfo(id: string, options?: { similarArtistCount?: number }): Promise<SubsonicArtistInfo> {
  const count = options?.similarArtistCount ?? 5;
  const data = await api<{ artistInfo2: SubsonicArtistInfo }>('getArtistInfo2.view', { id, count, ...libraryFilterParams() });
  return data.artistInfo2 ?? {};
}

export async function getArtistInfoForServer(
  serverId: string,
  id: string,
  options?: { similarArtistCount?: number; timeout?: number },
): Promise<SubsonicArtistInfoForServer> {
  const count = options?.similarArtistCount ?? 5;
  const data = await apiForServer<{ artistInfo2: SubsonicArtistInfo }>(
    serverId,
    'getArtistInfo2.view',
    { id, count, ...libraryFilterParamsForServer(serverId) },
    options?.timeout,
  );
  const info = data.artistInfo2 ?? {};
  const { similarArtist: rawSimilarArtist, ...baseInfo } = info;
  const similarArtist: SubsonicArtistInfoForServer['similarArtist'] = rawSimilarArtist?.map(artist => ({
    ...artist,
    serverId,
  }));
  return similarArtist ? { ...baseInfo, similarArtist } : baseInfo;
}

export async function getTopSongs(artist: string): Promise<SubsonicSong[]> {
  const { activeServerId } = useAuthStore.getState();
  if (!activeServerId) return [];
  return getTopSongsForServer(activeServerId, artist);
}

export interface GetTopSongsForServerOptions {
  /** Number requested from the server before local scope validation. */
  requestCount?: number;
  /** Maximum returned to the caller. */
  limit?: number;
  timeout?: number;
  /** Explicit browse folders; useful when the Library page scope differs from the legacy filter. */
  libraryIds?: string[];
  /** Disable the legacy single-folder filter when the caller validates against the local index. */
  filterToLibrary?: boolean;
}

export async function getTopSongsForServer(
  serverId: string,
  artist: string,
  options: GetTopSongsForServerOptions = {},
): Promise<SubsonicSong[]> {
  try {
    const libraryIds = options.libraryIds ?? librarySelectionForServer(serverId);
    const scoped = libraryIds.length > 0;
    const limit = options.limit ?? 5;
    const requestCount = Math.max(limit, options.requestCount ?? (scoped ? 20 : 5));
    const libraryParams = options.libraryIds
      ? (libraryIds.length > 0 ? { musicFolderId: libraryIds } : {})
      : libraryFilterParamsForServer(serverId);
    const data = await apiForServer<{ topSongs: { song: SubsonicSong[] } }>(
      serverId,
      'getTopSongs.view',
      { artist, count: requestCount, ...libraryParams },
      options.timeout,
    );
    const raw = data.topSongs?.song ?? [];
    const filtered = options.filterToLibrary === false
      ? raw
      : await filterSongsToServerLibrary(raw, serverId);
    return filtered.slice(0, limit).map(song => ({ ...song, serverId }));
  } catch {
    return [];
  }
}

export async function getSimilarSongs2(id: string, count = 50): Promise<SubsonicSong[]> {
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) return [];
  return getSimilarSongs2ForServer(serverId, id, count);
}

export async function getSimilarSongs2ForServer(
  serverId: string,
  id: string,
  count = 50,
): Promise<SubsonicSong[]> {
  try {
    const requestCount = similarSongsRequestCount(count, serverId);
    const data = await apiForServer<{ similarSongs2: { song: SubsonicSong[] } }>(
      serverId,
      'getSimilarSongs2.view',
      { id, count: requestCount, ...libraryFilterParamsForServer(serverId) },
    );
    const raw = data.similarSongs2?.song ?? [];
    const filtered = await filterSongsToServerLibrary(raw, serverId);
    return filtered.slice(0, count).map(song => ({ ...song, serverId }));
  } catch {
    return [];
  }
}

/** Similar tracks for a song id (Subsonic `getSimilarSongs`) — Navidrome + AudioMuse Instant Mix. */
export async function getSimilarSongs(id: string, count = 50): Promise<SubsonicSong[]> {
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) return [];
  return getSimilarSongsForServer(serverId, id, count);
}

export async function getSimilarSongsForServer(
  serverId: string,
  id: string,
  count = 50,
): Promise<SubsonicSong[]> {
  try {
    const requestCount = similarSongsRequestCount(count, serverId);
    const data = await apiForServer<{ similarSongs: { song: SubsonicSong | SubsonicSong[] } }>(
      serverId,
      'getSimilarSongs.view',
      { id, count: requestCount, ...libraryFilterParamsForServer(serverId) },
    );
    const raw = data.similarSongs?.song;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const filtered = await filterSongsToServerLibrary(list, serverId);
    return filtered.slice(0, count).map(song => ({ ...song, serverId }));
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
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) return [];
  return getSonicSimilarTracksForServer(serverId, id, count);
}

export async function getSonicSimilarTracksForServer(
  serverId: string,
  id: string,
  count = 50,
): Promise<SubsonicSong[]> {
  try {
    const requestCount = similarSongsRequestCount(count);
    const data = await apiForServer<{ sonicMatch: Array<{ entry?: SubsonicSong }> | { entry?: SubsonicSong } }>(
      serverId,
      'getSonicSimilarTracks.view',
      { id, count: requestCount, ...libraryFilterParamsForServer(serverId) },
    );
    const raw = data.sonicMatch;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const songs = list.map(m => m.entry).filter((e): e is SubsonicSong => !!e);
    if (songs.length === 0) return [];
    const filtered = await filterSongsToServerLibrary(songs, serverId);
    return filtered.slice(0, count).map(song => ({ ...song, serverId }));
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
  if (!activeServerId) return [];
  return fetchSimilarTracksRoutedForServer(activeServerId, songId, count);
}

export async function fetchSimilarTracksRoutedForServer(
  serverId: string,
  songId: string,
  count = 50,
): Promise<SubsonicSong[]> {
  const routes = resolveCallRoutesForServer(serverId, FEATURE_AUDIOMUSE_SIMILAR_TRACKS, OP_SIMILAR_TRACKS);
  if (routes.length === 0) return getSimilarSongsForServer(serverId, songId, count);
  for (const route of routes) {
    const songs = route.transport === 'opensubsonic'
      ? await getSonicSimilarTracksForServer(serverId, songId, count)
      : await getSimilarSongsForServer(serverId, songId, count);
    if (songs.length > 0) return songs;
  }
  return [];
}

export async function uploadArtistImage(id: string, file: File): Promise<void> {
  const serverId = useAuthStore.getState().activeServerId;
  if (!serverId) throw new Error('No active server');
  return uploadArtistImageForServer(serverId, id, file);
}

export async function uploadArtistImageForServer(
  serverId: string,
  id: string,
  file: File,
): Promise<void> {
  // Navidrome-specific endpoint — handled in Rust to bypass browser CORS restrictions.
  const server = findServerByIdOrIndexKey(serverId);
  if (!server) throw new Error('Server not found');
  const baseUrl = connectBaseUrlForServer(server);
  const buffer = await file.arrayBuffer();
  const fileBytes = Array.from(new Uint8Array(buffer));
  const res = await commands.uploadArtistImage(baseUrl, id, server.username, server.password, fileBytes, file.type || 'image/jpeg');
  if (res.status === 'error') throw new Error(res.error);
}
