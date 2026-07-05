import { getAlbumsByGenre } from '@/lib/api/subsonicGenres';
import { libraryListAlbumsByGenre } from '@/lib/api/library';
import { libraryScopeForServer } from '@/lib/api/subsonicClient';
import { albumToAlbum } from './advancedSearchLocal';
import { albumSortClauses, sortSubsonicAlbums, type AlbumBrowseSort } from './albumBrowseSort';
import type { AlbumBrowsePageResult } from './albumBrowseTypes';
import { libraryIsReady } from './libraryReady';

/** First paint — one visible slice only. */
export const GENRE_ALBUM_FIRST_PAGE = 60;
/** Background SQL chunk when the in-memory buffer is exhausted. */
export const GENRE_ALBUM_CATALOG_CHUNK = 200;

async function fetchLocalGenreAlbumPage(
  serverId: string,
  genre: string,
  offset: number,
  pageSize: number,
  sort: AlbumBrowseSort,
): Promise<AlbumBrowsePageResult | null> {
  const scope = libraryScopeForServer(serverId) ?? undefined;
  if (!(await libraryIsReady(serverId))) return null;
  try {
    const resp = await libraryListAlbumsByGenre({
      serverId,
      genre,
      libraryScope: scope,
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
): Promise<AlbumBrowsePageResult> {
  if (!serverId || !genre.trim()) {
    return { albums: [], hasMore: false };
  }

  if (indexEnabled) {
    const local = await fetchLocalGenreAlbumPage(serverId, genre, offset, pageSize, sort);
    if (local != null) return local;
  }

  return fetchNetworkGenreAlbumPage(genre, offset, pageSize, sort);
}

export async function fetchGenreAlbumTotal(
  serverId: string,
  genre: string,
  indexEnabled: boolean,
  sort: AlbumBrowseSort,
): Promise<number | null> {
  if (!genre.trim()) return null;
  if (indexEnabled && serverId && (await libraryIsReady(serverId))) {
    const scope = libraryScopeForServer(serverId) ?? undefined;
    try {
      const resp = await libraryListAlbumsByGenre({
        serverId,
        genre,
        libraryScope: scope,
        sort: albumSortClauses(sort),
        limit: 1,
        offset: 0,
        includeTotal: true,
      });
      if (resp.source === 'local' && resp.total != null) return resp.total;
    } catch {
      return null;
    }
  }
  return null;
}
