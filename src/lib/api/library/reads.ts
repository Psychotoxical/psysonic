/**
 * Read commands (PR-5a) — typed wrappers around the `library_*` read/query Tauri
 * commands. Split out of the former single `lib/api/library.ts`; re-exported via
 * the `@/lib/api/library` barrel.
 */
import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/generated/bindings';
import { serverIndexKeyForId, mapServerIdFromIndexKey, mapTracksServerId } from './internal';
import type {
  SyncStateDto,
  LibraryTracksEnvelope,
  LibraryAdvancedSearchRequest,
  LibraryAdvancedSearchResponse,
  LibraryLiveSearchRequest,
  LibraryLiveSearchResponse,
  LibraryLosslessAlbumsRequest,
  LibraryLosslessAlbumsResponse,
  LibraryArtistLosslessBrowseRequest,
  LibraryArtistLosslessBrowseResponse,
  LibraryCrossServerSearchResponse,
  LibraryTrackDto,
  TrackRefDto,
  TrackArtifactDto,
  TrackFactDto,
  OfflinePathDto,
} from './dto';

export async function libraryGetStatus(
  serverId: string,
  libraryScope?: string,
): Promise<SyncStateDto> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.libraryGetStatus(indexKey, libraryScope ?? null);
  if (res.status === 'error') throw new Error(res.error);
  return { ...res.data, serverId } as SyncStateDto;
}

export function librarySearch(
  serverId: string,
  query: string,
  options?: { limit?: number; offset?: number; libraryScope?: string },
): Promise<LibraryTracksEnvelope> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<LibraryTracksEnvelope>('library_search', {
    serverId: indexKey,
    query,
    limit: options?.limit,
    offset: options?.offset,
    libraryScope: options?.libraryScope,
  }).then(envelope => ({
    ...envelope,
    tracks: mapTracksServerId(envelope.tracks, serverId),
  }));
}

/**
 * Advanced Search against the local index (§5.13). The frontend fallback
 * (PR-7 F2) decides local vs network and maps the same `LibraryFilterClause`
 * shape onto the network path; this wrapper only talks to the local builder.
 */
export function libraryAdvancedSearch(
  request: LibraryAdvancedSearchRequest,
): Promise<LibraryAdvancedSearchResponse> {
  const indexKey = serverIndexKeyForId(request.serverId);
  return invoke<LibraryAdvancedSearchResponse>('library_advanced_search', {
    request: { ...request, serverId: indexKey },
  }).then(response => ({
    ...response,
    artists: response.artists.map(artist => ({
      ...artist,
      serverId: mapServerIdFromIndexKey(artist.serverId, request.serverId),
    })),
    albums: response.albums.map(album => ({
      ...album,
      serverId: mapServerIdFromIndexKey(album.serverId, request.serverId),
    })),
    tracks: mapTracksServerId(response.tracks, request.serverId),
  }));
}

export function libraryLiveSearch(request: LibraryLiveSearchRequest): Promise<LibraryLiveSearchResponse> {
  const indexKey = serverIndexKeyForId(request.serverId);
  return invoke<LibraryLiveSearchResponse>('library_live_search', {
    request: { ...request, serverId: indexKey },
  }).then(response => ({
    ...response,
    artists: response.artists.map(artist => ({
      ...artist,
      serverId: mapServerIdFromIndexKey(artist.serverId, request.serverId),
    })),
    albums: response.albums.map(album => ({
      ...album,
      serverId: mapServerIdFromIndexKey(album.serverId, request.serverId),
    })),
    tracks: mapTracksServerId(response.tracks, request.serverId),
  }));
}

/** Paginated lossless albums from the local track index. */
export function libraryListLosslessAlbums(
  request: LibraryLosslessAlbumsRequest,
): Promise<LibraryLosslessAlbumsResponse> {
  const indexKey = serverIndexKeyForId(request.serverId);
  return invoke<LibraryLosslessAlbumsResponse>('library_list_lossless_albums', {
    request: {
      serverId: indexKey,
      libraryScope: request.libraryScope ?? undefined,
      limit: request.limit,
      offset: request.offset,
    },
  }).then(response => ({
    ...response,
    albums: response.albums.map(album => ({
      ...album,
      serverId: mapServerIdFromIndexKey(album.serverId, request.serverId),
    })),
  }));
}

/** Lossless albums + tracks for one artist from the local index. */
export function libraryGetArtistLosslessBrowse(
  request: LibraryArtistLosslessBrowseRequest,
): Promise<LibraryArtistLosslessBrowseResponse> {
  const indexKey = serverIndexKeyForId(request.serverId);
  return invoke<LibraryArtistLosslessBrowseResponse>('library_get_artist_lossless_browse', {
    request: {
      serverId: indexKey,
      artistId: request.artistId,
      libraryScope: request.libraryScope ?? undefined,
    },
  }).then(response => ({
    ...response,
    albums: response.albums.map(album => ({
      ...album,
      serverId: mapServerIdFromIndexKey(album.serverId, request.serverId),
    })),
    tracks: mapTracksServerId(response.tracks, request.serverId),
  }));
}

/** Cross-server FTS union over the given servers, or all `ready` ones (§5.5B). */
export function librarySearchCrossServer(args: {
  query: string;
  limit?: number;
  servers?: string[];
}): Promise<LibraryCrossServerSearchResponse> {
  const indexServers = args.servers?.map(serverIndexKeyForId);
  return invoke<LibraryCrossServerSearchResponse>('library_search_cross_server', {
    ...args,
    servers: indexServers,
  }).then(response => ({
    ...response,
    hits: mapTracksServerId(response.hits),
    fuzzy: mapTracksServerId(response.fuzzy),
    serversSearched: response.serversSearched.map(id => mapServerIdFromIndexKey(id)),
  }));
}

export function libraryGetTrack(
  serverId: string,
  trackId: string,
): Promise<LibraryTrackDto | null> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<LibraryTrackDto | null>('library_get_track', { serverId: indexKey, trackId })
    .then(track => (track ? { ...track, serverId } : track));
}

/** Seed library index rows from live Subsonic song payloads (pin/download cold miss). */
export function libraryUpsertSongsFromApi(
  serverId: string,
  songs: unknown[],
): Promise<number> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<number>('library_upsert_songs_from_api', { serverId: indexKey, songs });
}

/** `library_get_tracks_batch` cap (spec §7.1). */
export const LIBRARY_TRACKS_BATCH_LIMIT = 100;

export function libraryGetTracksBatch(refs: TrackRefDto[]): Promise<LibraryTrackDto[]> {
  const indexKeyMap = new Map<string, string>();
  const remapped = refs.map(ref => {
    const indexKey = serverIndexKeyForId(ref.serverId);
    if (!indexKeyMap.has(indexKey)) indexKeyMap.set(indexKey, ref.serverId);
    return { ...ref, serverId: indexKey };
  });
  return invoke<LibraryTrackDto[]>('library_get_tracks_batch', { refs: remapped })
    .then(tracks => tracks.map(track => ({
      ...track,
      serverId: mapServerIdFromIndexKey(track.serverId, indexKeyMap.get(track.serverId)),
    })));
}

/** Chunked batch fetch — safe when `refs.length` exceeds {@link LIBRARY_TRACKS_BATCH_LIMIT}. */
export async function libraryGetTracksBatchChunked(refs: TrackRefDto[]): Promise<LibraryTrackDto[]> {
  if (refs.length === 0) return [];
  const out: LibraryTrackDto[] = [];
  for (let i = 0; i < refs.length; i += LIBRARY_TRACKS_BATCH_LIMIT) {
    const chunk = refs.slice(i, i + LIBRARY_TRACKS_BATCH_LIMIT);
    const batch = await libraryGetTracksBatch(chunk).catch(() => []);
    out.push(...batch);
  }
  return out;
}

export function libraryGetTracksByAlbum(
  serverId: string,
  albumId: string,
): Promise<LibraryTrackDto[]> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<LibraryTrackDto[]>('library_get_tracks_by_album', { serverId: indexKey, albumId })
    .then(tracks => mapTracksServerId(tracks, serverId));
}

export async function libraryGetArtifact(
  serverId: string,
  trackId: string,
  artifactKind: string,
  options?: { sourceKind?: string; sourceId?: string; format?: string },
): Promise<TrackArtifactDto | null> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.libraryGetArtifact(
    indexKey,
    trackId,
    artifactKind,
    options?.sourceKind ?? null,
    options?.sourceId ?? null,
    options?.format ?? null,
  );
  if (res.status === 'error') throw new Error(res.error);
  const artifact = res.data;
  return artifact ? ({ ...artifact, serverId } as TrackArtifactDto) : artifact;
}

export async function libraryGetFacts(
  serverId: string,
  trackId: string,
  factKinds?: string[],
): Promise<TrackFactDto[]> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.libraryGetFacts(indexKey, trackId, factKinds ?? null);
  if (res.status === 'error') throw new Error(res.error);
  return res.data.map(fact => ({ ...fact, serverId })) as TrackFactDto[];
}

export async function libraryGetOfflinePath(
  serverId: string,
  trackId: string,
): Promise<OfflinePathDto> {
  const indexKey = serverIndexKeyForId(serverId);
  const res = await commands.libraryGetOfflinePath(indexKey, trackId);
  if (res.status === 'error') throw new Error(res.error);
  return { ...res.data, serverId };
}
