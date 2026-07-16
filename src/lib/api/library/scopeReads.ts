/**
 * Multi-library scope merge read commands (WO-4 backend, WO-5 wrappers).
 * Hand-typed IPC — not in specta `bindings.ts`.
 */
import { invoke } from '@tauri-apps/api/core';
import { librarySelectionForServer } from '@/lib/api/subsonicClient';
import {
  mapServerIdFromIndexKey,
  mapTracksServerId,
  serverIndexKeyForId,
} from './internal';
import type {
  LibraryAlbumDto,
  LibraryArtistDto,
  LibraryScopePair,
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
  return scopes.map(pair => mapScopePairServerId(pair, profileServerId));
}

function mapAlbumsServerId(
  albums: LibraryAlbumDto[],
  profileServerId: string,
): LibraryAlbumDto[] {
  return albums.map(album => ({
    ...album,
    serverId: mapServerIdFromIndexKey(album.serverId, profileServerId),
  }));
}

function mapArtistsServerId(
  artists: LibraryArtistDto[],
  profileServerId: string,
): LibraryArtistDto[] {
  return artists.map(artist => ({
    ...artist,
    serverId: mapServerIdFromIndexKey(artist.serverId, profileServerId),
  }));
}

/** Build ordered scope pairs from the persisted library selection for one server. */
export function scopePairsFromLibrarySelection(serverId: string): LibraryScopePair[] {
  const indexKey = serverIndexKeyForId(serverId);
  return librarySelectionForServer(serverId).map(libraryId => ({
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
  }).then(albums => mapAlbumsServerId(albums, serverId));
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
  }).then(artists => mapArtistsServerId(artists, serverId));
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
  }).then(tracks => mapTracksServerId(tracks, serverId));
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
      serverId: mapServerIdFromIndexKey(response.album.serverId, serverId),
    },
    tracks: mapTracksServerId(response.tracks, serverId),
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
      serverId: mapServerIdFromIndexKey(response.artist.serverId, serverId),
    },
    albums: mapAlbumsServerId(response.albums, serverId),
    tracks: mapTracksServerId(response.tracks, serverId),
  }));
}
