/**
 * Multi-library scope merge read commands (WO-4 backend, WO-5 wrappers).
 * Hand-typed IPC — not in specta `bindings.ts`.
 */
import { invoke } from '@tauri-apps/api/core';
import { librarySelectionForServer } from '@/lib/api/subsonicClient';
import {
  mapServerIdFromIndexKey,
  serverIndexKeyForId,
} from './internal';
import type {
  LibraryAlbumDto,
  LibraryArtistDto,
  LibraryEntitySourceDto,
  LibraryResolveEntitySourcesRequest,
  LibraryScopePair,
  LibraryScopeCatalogStatisticsDto,
  LibraryScopeCatalogStatisticsRequest,
  LibraryScopeMostPlayedAlbumDto,
  LibraryTrackDto,
} from './dto';

export type { LibraryScopePair };

export interface LibraryScopeListRequest {
  scopes: LibraryScopePair[];
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface LibraryScopeSearchRequest {
  scopes: LibraryScopePair[];
  query: string;
  limit?: number;
}

export interface LibraryScopeAlbumDetailRequest {
  scopes: LibraryScopePair[];
  albumId: string;
  serverId: string;
}

export interface LibraryScopeArtistDetailRequest {
  scopes: LibraryScopePair[];
  artistId: string;
  serverId: string;
}

export interface LibraryScopeAlbumDetailResponse {
  album: LibraryAlbumDto;
  tracks: LibraryTrackDto[];
}

export interface LibraryScopeArtistDetailResponse {
  artist: LibraryArtistDto;
  albums: LibraryAlbumDto[];
  tracks: LibraryTrackDto[];
}

function mapScopePairServerId(pair: LibraryScopePair, profileServerId: string): LibraryScopePair {
  const profileIndexKey = serverIndexKeyForId(profileServerId);
  if (pair.serverId === profileServerId || pair.serverId === profileIndexKey) {
    return { serverId: profileIndexKey, libraryId: pair.libraryId };
  }
  return { serverId: serverIndexKeyForId(pair.serverId), libraryId: pair.libraryId };
}

export function mapScopePairs(scopes: LibraryScopePair[], profileServerId: string): LibraryScopePair[] {
  const byIndexKey = new Map<string, { whole: boolean; libraryIds: string[]; seen: Set<string> }>();
  for (const pair of scopes) {
    const next = mapScopePairServerId(pair, profileServerId);
    const existing = byIndexKey.get(next.serverId);
    if (!existing) {
      byIndexKey.set(next.serverId, {
        whole: next.libraryId === null,
        libraryIds: next.libraryId === null ? [] : [next.libraryId],
        seen: new Set(next.libraryId === null ? [] : [next.libraryId]),
      });
      continue;
    }
    if (existing.whole) continue;
    if (next.libraryId === null) {
      existing.whole = true;
      existing.libraryIds = [];
      existing.seen.clear();
      continue;
    }
    if (!existing.seen.has(next.libraryId)) {
      existing.seen.add(next.libraryId);
      existing.libraryIds.push(next.libraryId);
    }
  }
  return [...byIndexKey.entries()].flatMap<LibraryScopePair>(([serverId, scope]) =>
    scope.whole
      ? [{ serverId, libraryId: null }]
      : scope.libraryIds.map(libraryId => ({ serverId, libraryId })),
  );
}

function scopeOwnerServerId(
  indexKey: string,
  scopes: LibraryScopePair[],
  fallbackServerId: string,
): string {
  return scopes.find(pair => serverIndexKeyForId(pair.serverId) === indexKey)?.serverId
    ?? mapServerIdFromIndexKey(indexKey, fallbackServerId);
}

function mapAlbumsServerId(
  albums: LibraryAlbumDto[],
  profileServerId: string,
  scopes: LibraryScopePair[],
): LibraryAlbumDto[] {
  return albums.map(album => ({
    ...album,
    serverId: scopeOwnerServerId(album.serverId, scopes, profileServerId),
  }));
}

function mapArtistsServerId(
  artists: LibraryArtistDto[],
  profileServerId: string,
  scopes: LibraryScopePair[],
): LibraryArtistDto[] {
  return artists.map(artist => ({
    ...artist,
    serverId: scopeOwnerServerId(artist.serverId, scopes, profileServerId),
  }));
}

/** Build ordered scope pairs from the persisted library selection for one server. */
export function scopePairsFromLibrarySelection(serverId: string): LibraryScopePair[] {
  const indexKey = serverIndexKeyForId(serverId);
  const selection = librarySelectionForServer(serverId);
  if (selection.length === 0) return [{ serverId: indexKey, libraryId: null }];
  return selection.map(libraryId => ({
    serverId: indexKey,
    libraryId,
  }));
}

export function libraryScopeListAlbums(
  serverId: string,
  request: LibraryScopeListRequest,
): Promise<LibraryAlbumDto[]> {
  return invoke<LibraryAlbumDto[]>('library_scope_list_albums', {
    request: {
      ...request,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(albums => mapAlbumsServerId(albums, serverId, request.scopes));
}

export function libraryScopeListArtists(
  serverId: string,
  request: LibraryScopeListRequest,
): Promise<LibraryArtistDto[]> {
  return invoke<LibraryArtistDto[]>('library_scope_list_artists', {
    request: {
      ...request,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(artists => mapArtistsServerId(artists, serverId, request.scopes));
}

export function libraryScopeCatalogStatistics(
  serverId: string,
  request: LibraryScopeCatalogStatisticsRequest,
): Promise<LibraryScopeCatalogStatisticsDto> {
  return invoke<LibraryScopeCatalogStatisticsDto>('library_scope_catalog_statistics', {
    request: {
      ...request,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  });
}

export function libraryScopeMostPlayedAlbums(
  serverId: string,
  request: { scopes: LibraryScopePair[]; limit?: number; offset?: number },
): Promise<LibraryScopeMostPlayedAlbumDto[]> {
  return invoke<LibraryScopeMostPlayedAlbumDto[]>('library_scope_most_played_albums', {
    request: {
      ...request,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(rows => rows.map(row => ({
    ...row,
    album: {
      ...row.album,
      serverId: scopeOwnerServerId(row.album.serverId, request.scopes, serverId),
    },
  })));
}

export function libraryScopeListArtistsByRole(
  serverId: string,
  request: { scopes: LibraryScopePair[]; role: string; limit?: number },
): Promise<LibraryArtistDto[]> {
  return invoke<LibraryArtistDto[]>('library_scope_list_artists_by_role', {
    request: {
      ...request,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(artists => mapArtistsServerId(artists, serverId, request.scopes));
}

export function libraryScopeSearchTracks(
  serverId: string,
  request: LibraryScopeSearchRequest,
): Promise<LibraryTrackDto[]> {
  return invoke<LibraryTrackDto[]>('library_scope_search_tracks', {
    request: {
      ...request,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(tracks => tracks.map(track => ({
    ...track,
    serverId: scopeOwnerServerId(track.serverId, request.scopes, serverId),
  })));
}

export function libraryScopeAlbumDetail(
  serverId: string,
  request: LibraryScopeAlbumDetailRequest,
): Promise<LibraryScopeAlbumDetailResponse> {
  const indexKey = serverIndexKeyForId(serverId);
  const anchorIndexKey =
    request.serverId === serverId ? indexKey : serverIndexKeyForId(request.serverId);
  return invoke<LibraryScopeAlbumDetailResponse>('library_scope_album_detail', {
    request: {
      ...request,
      serverId: anchorIndexKey,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(response => ({
    album: {
      ...response.album,
      serverId: scopeOwnerServerId(response.album.serverId, request.scopes, serverId),
    },
    tracks: response.tracks.map(track => ({
      ...track,
      serverId: scopeOwnerServerId(track.serverId, request.scopes, serverId),
    })),
  }));
}

export function libraryScopeArtistDetail(
  serverId: string,
  request: LibraryScopeArtistDetailRequest,
): Promise<LibraryScopeArtistDetailResponse> {
  const indexKey = serverIndexKeyForId(serverId);
  const anchorIndexKey =
    request.serverId === serverId ? indexKey : serverIndexKeyForId(request.serverId);
  return invoke<LibraryScopeArtistDetailResponse>('library_scope_artist_detail', {
    request: {
      ...request,
      serverId: anchorIndexKey,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(response => ({
    artist: {
      ...response.artist,
      serverId: scopeOwnerServerId(response.artist.serverId, request.scopes, serverId),
    },
    albums: mapAlbumsServerId(response.albums, serverId, request.scopes),
    tracks: response.tracks.map(track => ({
      ...track,
      serverId: scopeOwnerServerId(track.serverId, request.scopes, serverId),
    })),
  }));
}

export function libraryResolveEntitySources(
  serverId: string,
  request: LibraryResolveEntitySourcesRequest,
): Promise<LibraryEntitySourceDto[]> {
  const anchorIndexKey =
    request.anchorServerId === serverId
      ? serverIndexKeyForId(serverId)
      : serverIndexKeyForId(request.anchorServerId);
  return invoke<LibraryEntitySourceDto[]>('library_resolve_entity_sources', {
    request: {
      ...request,
      anchorServerId: anchorIndexKey,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(sources => sources.map(source => ({
    ...source,
    serverId: scopeOwnerServerId(source.serverId, request.scopes, serverId),
  })));
}
