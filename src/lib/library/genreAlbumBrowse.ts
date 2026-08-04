import { getAlbumsByGenre } from '@/lib/api/subsonicGenres';
import { libraryListAlbumsByGenre } from '@/lib/api/library';
import { libraryScopeForServer, libraryScopePairsForServer } from '@/lib/api/subsonicClient';
import { albumToAlbum } from './advancedSearchLocal';
import { albumSortClauses, sortSubsonicAlbums, type AlbumBrowseSort } from './albumBrowseSort';
import type { AlbumBrowsePageResult } from './albumBrowseTypes';
import type { LibraryBrowseScope } from './libraryBrowseScope';
import { readyLibraryServerKeys } from './libraryReady';

/** First paint — one visible slice only. */
export const GENRE_ALBUM_FIRST_PAGE = 60;
/** Background SQL chunk when the in-memory buffer is exhausted. */
export const GENRE_ALBUM_CATALOG_CHUNK = 200;

const localPageInflight = new Map<string, Promise<AlbumBrowsePageResult | null>>();

async function fetchLocalGenreAlbumPage(
  serverId: string,
  genre: string,
  offset: number,
  pageSize: number,
  sort: AlbumBrowseSort,
  browseScope?: LibraryBrowseScope,
): Promise<AlbumBrowsePageResult | null> {
  const scope = browseScope ? undefined : libraryScopeForServer(serverId) ?? undefined;
  const libraryScopes = browseScope?.pairs.length
    ? browseScope.pairs
    : libraryScopePairsForServer(serverId);
  const serverIds = browseScope?.serverIds.length ? browseScope.serverIds : [serverId];
  if (!(await readyLibraryServerKeys(serverIds))) return null;
  const requestKey = JSON.stringify({ serverId, genre, offset, pageSize, sort, scope, libraryScopes });
  const existing = localPageInflight.get(requestKey);
  if (existing) return existing;

  const request = (async (): Promise<AlbumBrowsePageResult | null> => {
    try {
      const resp = await libraryListAlbumsByGenre({
        serverId,
        genre,
        libraryScope: scope,
        libraryScopes,
        sort: albumSortClauses(sort),
        limit: pageSize,
        offset,
      });
      if (resp.source !== 'local') return null;
      return {
        albums: resp.albums.map(albumToAlbum),
        hasMore: resp.hasMore,
      };
    } catch {
      return null;
    }
  })();
  localPageInflight.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (localPageInflight.get(requestKey) === request) localPageInflight.delete(requestKey);
  }
}

async function fetchNetworkGenreAlbumPage(
  genre: string,
  offset: number,
  pageSize: number,
  sort: AlbumBrowseSort,
): Promise<AlbumBrowsePageResult> {
  try {
    const albums = await getAlbumsByGenre(genre, pageSize, offset);
    return {
      albums: sortSubsonicAlbums(albums, sort),
      hasMore: albums.length === pageSize,
    };
  } catch {
    return { albums: [], hasMore: false };
  }
}

/** Album grid for genre detail — local index when ready, else Subsonic `byGenre`. */
export async function fetchGenreAlbumPage(
  serverId: string,
  genre: string,
  indexEnabled: boolean,
  offset: number,
  pageSize: number,
  sort: AlbumBrowseSort,
  browseScope?: LibraryBrowseScope,
): Promise<AlbumBrowsePageResult> {
  if (!serverId || !genre.trim()) {
    return { albums: [], hasMore: false };
  }

  if (indexEnabled) {
    const local = await fetchLocalGenreAlbumPage(
      serverId,
      genre,
      offset,
      pageSize,
      sort,
      browseScope,
    );
    if (local != null) return local;
  }

  return fetchNetworkGenreAlbumPage(genre, offset, pageSize, sort);
}

export async function fetchGenreAlbumTotal(
  serverId: string,
  genre: string,
  indexEnabled: boolean,
  sort: AlbumBrowseSort,
  browseScope?: LibraryBrowseScope,
): Promise<number | null> {
  if (!genre.trim() || !indexEnabled || !serverId) return null;
  const serverIds = browseScope?.serverIds.length ? browseScope.serverIds : [serverId];
  if (await readyLibraryServerKeys(serverIds)) {
    const scope = browseScope ? undefined : libraryScopeForServer(serverId) ?? undefined;
    const libraryScopes = browseScope?.pairs.length
      ? browseScope.pairs
      : libraryScopePairsForServer(serverId);
    try {
      const resp = await libraryListAlbumsByGenre({
        serverId,
        genre,
        libraryScope: scope,
        libraryScopes,
        sort: albumSortClauses(sort),
        limit: 1,
        offset: 0,
        includeTotal: true,
        countOnly: true,
      });
      if (resp.source === 'local' && resp.total != null) return resp.total;
    } catch {
      return null;
    }
  }
  return null;
}
