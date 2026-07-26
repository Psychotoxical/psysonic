/**
 * Multi-library scope merge read commands (WO-4 backend, WO-5 wrappers).
 * Raw-JSON browse envelopes remain hand-typed; typeable commands use Specta.
 */
import { invoke } from '@tauri-apps/api/core';
import {
  commands,
  type LibraryMostPlayedAlbumDto as LibraryScopeMostPlayedAlbum,
  type LibraryMostPlayedArtistDto as LibraryScopeMostPlayedArtist,
  type LibraryMostPlayedResponse as LibraryScopeMostPlayedResponse,
  type LibraryAlbumOverlayResolutionDto,
  type LibraryEntitySourceDto,
  type LibraryResolveAlbumOverlayRequest,
  type LibraryResolveEntitySourcesRequest,
  type LibrarySourceEntityType,
} from '@/generated/bindings';
import { librarySelectionForServer } from '@/lib/api/subsonicClient';
import {
  mapServerIdFromIndexKey,
  mapTracksServerId,
  serverIndexKeyForId,
} from './internal';
import type {
  LibraryAlbumDto,
  LibraryArtistDto,
  GenreAlbumCountRow,
  LibraryScopePair,
  LibraryTrackDto,
  LibraryScopeBrowseRequest,
  LibraryScopeBrowseResponse,
} from './dto';

export type { LibraryScopePair };

export interface LibraryScopeListRequest {
  scopes: LibraryScopePair[];
  sort?: string;
  limit?: number;
  offset?: number;
}

export interface LibraryStatisticsScope {
  serverId: string;
  /** Empty means every indexed folder on this server. */
  libraryIds: string[];
}

export interface LibraryScopeStatisticsResponse {
  artistCount: number;
  albumCount: number;
  songCount: number;
  playtimeSec: number;
  genres: GenreAlbumCountRow[];
  formats: { value: string; songCount: number }[];
}

export interface LibraryScopeMostPlayedRequest {
  scopes: LibraryStatisticsScope[];
  limit: number;
  offset: number;
}

export type {
  LibraryAlbumOverlayResolutionDto,
  LibraryEntitySourceDto,
  LibraryResolveAlbumOverlayRequest,
  LibraryResolveEntitySourcesRequest,
  LibraryScopeMostPlayedAlbum,
  LibraryScopeMostPlayedArtist,
  LibraryScopeMostPlayedResponse,
  LibrarySourceEntityType,
};

export async function libraryResolveAlbumOverlay(
  request: LibraryResolveAlbumOverlayRequest,
): Promise<LibraryAlbumOverlayResolutionDto[]> {
  const ownerByIndexKey = new Map(
    request.scopes.map(scope => [serverIndexKeyForId(scope.serverId), scope.serverId]),
  );
  const result = await commands.libraryResolveAlbumOverlay({
    scopes: request.scopes.map(scope => ({
      ...scope,
      serverId: serverIndexKeyForId(scope.serverId),
    })),
    albums: request.albums.map(album => ({
      ...album,
      serverId: serverIndexKeyForId(album.serverId),
    })),
  });
  if (result.status === 'error') throw new Error(result.error);
  return result.data.map(resolution => ({
    ...resolution,
    representativeServerId: resolution.representativeServerId
      ? ownerByIndexKey.get(resolution.representativeServerId)
        ?? mapServerIdFromIndexKey(resolution.representativeServerId)
      : null,
  }));
}

export interface LibraryScopeSearchRequest {
  scopes: LibraryScopePair[];
  query: string;
  limit?: number;
}

export interface LibraryScopeMainstageAlbumsRequest {
  scopes: LibraryScopePair[];
  feed: 'newReleases' | 'recentlyPlayed';
  limit: number;
  offset: number;
  genres?: string[];
  includeGenreCounts?: boolean;
}

export interface LibraryScopeMainstageAlbumsResponse {
  albums: LibraryAlbumDto[];
  hasMore: boolean;
  genreCounts: GenreAlbumCountRow[];
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
  /** Skip tracks when the caller needs only artist metadata and discography. */
  includeTracks?: boolean;
  /** Return a bounded personal-play-count fallback for the Top Tracks section. */
  topTracksLimit?: number;
}

export interface LibraryScopeComposerDetailRequest {
  scopes: LibraryScopePair[];
  composerId: string;
  serverId: string;
}

export interface LibraryScopeAlbumDetailResponse {
  album: LibraryAlbumDto;
  tracks: LibraryTrackDto[];
}

export interface LibraryScopeArtistDetailResponse {
  artist: LibraryArtistDto;
  albums: LibraryAlbumDto[];
  /** Albums the artist only appears on (compilations, guest tracks). Always sent, empty when none. */
  appearsOnAlbums: LibraryAlbumDto[];
  tracks: LibraryTrackDto[];
  topTracksServerId?: string | null;
  topTracksFingerprint?: string | null;
}

export interface LibraryScopeComposerDetailResponse {
  composer: LibraryArtistDto;
  albums: LibraryAlbumDto[];
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
  const selection = librarySelectionForServer(serverId);
  return selection.length > 0
    ? selection.map(libraryId => ({ serverId: indexKey, libraryId }))
    : [{ serverId: indexKey, libraryId: null }];
}

/** Aggregate selected index scopes without cross-server entity merging. */
export function libraryScopeStatistics(
  scopes: LibraryStatisticsScope[],
): Promise<LibraryScopeStatisticsResponse> {
  return invoke<LibraryScopeStatisticsResponse>('library_scope_statistics', {
    request: {
      scopes: scopes.map(scope => ({
        ...scope,
        serverId: serverIndexKeyForId(scope.serverId),
      })),
    },
  });
}

/** Aggregate ranked albums from every selected Statistics-style index scope. */
export async function libraryScopeMostPlayed(
  request: LibraryScopeMostPlayedRequest,
): Promise<LibraryScopeMostPlayedResponse> {
  const result = await commands.libraryScopeMostPlayed({
    ...request,
    scopes: request.scopes.map(scope => ({
      ...scope,
      serverId: serverIndexKeyForId(scope.serverId),
    })),
  });
  if (result.status === 'error') throw new Error(result.error);
  return {
    ...result.data,
    albums: result.data.albums.map(album => ({
      ...album,
      serverId: mapServerIdFromIndexKey(album.serverId),
    })),
    artists: result.data.artists.map(artist => ({
      ...artist,
      serverId: mapServerIdFromIndexKey(artist.serverId),
    })),
  };
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

export function libraryScopeBrowse(
  serverId: string,
  request: LibraryScopeBrowseRequest,
): Promise<LibraryScopeBrowseResponse> {
  return invoke<LibraryScopeBrowseResponse>('library_scope_browse', {
    request: {
      ...request,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(response => ({
    ...response,
    albums: mapAlbumsServerId(response.albums, serverId),
    artists: mapArtistsServerId(response.artists, serverId),
    tracks: mapTracksServerId(response.tracks, serverId),
  }));
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

export function libraryScopeListComposers(
  serverId: string,
  request: LibraryScopeListRequest,
): Promise<LibraryArtistDto[]> {
  return invoke<LibraryArtistDto[]>('library_scope_list_composers', {
    request: {
      ...request,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(artists => mapArtistsServerId(artists, serverId));
}

export function libraryScopeListMainstageAlbums(
  serverId: string,
  request: LibraryScopeMainstageAlbumsRequest,
): Promise<LibraryScopeMainstageAlbumsResponse> {
  return invoke<LibraryScopeMainstageAlbumsResponse>('library_scope_list_mainstage_albums', {
    request: {
      ...request,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(response => ({
    albums: mapAlbumsServerId(response.albums, serverId),
    hasMore: response.hasMore,
    genreCounts: response.genreCounts,
  }));
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

export function libraryResolveEntitySources(
  serverId: string,
  request: LibraryResolveEntitySourcesRequest,
): Promise<LibraryEntitySourceDto[]> {
  const ownerByIndexKey = new Map(
    request.scopes.map(scope => [serverIndexKeyForId(scope.serverId), scope.serverId]),
  );
  const anchorIndexKey = serverIndexKeyForId(request.anchorServerId);
  return invoke<LibraryEntitySourceDto[]>('library_resolve_entity_sources', {
    request: {
      ...request,
      anchorServerId: anchorIndexKey,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(sources =>
    sources.map(source => ({
      ...source,
      serverId:
        ownerByIndexKey.get(source.serverId) ?? mapServerIdFromIndexKey(source.serverId),
    })),
  );
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
    appearsOnAlbums: mapAlbumsServerId(response.appearsOnAlbums, serverId),
    tracks: mapTracksServerId(response.tracks, serverId),
    topTracksServerId: response.topTracksServerId
      ? mapServerIdFromIndexKey(response.topTracksServerId, serverId)
      : null,
    topTracksFingerprint: response.topTracksFingerprint ?? null,
  }));
}

export function libraryScopeComposerDetail(
  serverId: string,
  request: LibraryScopeComposerDetailRequest,
): Promise<LibraryScopeComposerDetailResponse> {
  const indexKey = serverIndexKeyForId(serverId);
  const anchorIndexKey =
    request.serverId === serverId ? indexKey : serverIndexKeyForId(request.serverId);
  return invoke<LibraryScopeComposerDetailResponse>('library_scope_composer_detail', {
    request: {
      ...request,
      serverId: anchorIndexKey,
      scopes: mapScopePairs(request.scopes, serverId),
    },
  }).then(response => ({
    composer: {
      ...response.composer,
      serverId: mapServerIdFromIndexKey(response.composer.serverId, serverId),
    },
    albums: mapAlbumsServerId(response.albums, serverId),
  }));
}
