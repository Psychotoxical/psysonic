import { libraryListAlbumsByGenre } from '../../api/library';
import { libraryScopeForServer } from '../../api/subsonicClient';
import { albumToAlbum } from './advancedSearchLocal';
import { albumSortClauses, type AlbumBrowseSort } from './albumBrowseSort';
import type { AlbumBrowsePageResult } from './albumBrowseTypes';
import { libraryIsReady } from './libraryReady';

/** Background SQL chunk size — matches All Albums local slice mode. */
export const GENRE_ALBUM_CATALOG_CHUNK = 200;
export const GENRE_ALBUM_PAGE_SIZE = GENRE_ALBUM_CATALOG_CHUNK;

/** Album grid for genre detail — local index only (`library_list_albums_by_genre`). */
export async function fetchGenreAlbumPage(
  serverId: string,
  genre: string,
  indexEnabled: boolean,
  offset: number,
  pageSize: number,
  sort: AlbumBrowseSort,
): Promise<AlbumBrowsePageResult> {
  const scope = libraryScopeForServer(serverId) ?? undefined;
  if (!indexEnabled || !serverId || !genre.trim() || !(await libraryIsReady(serverId))) {
    return { albums: [], hasMore: false };
  }
  try {
    const resp = await libraryListAlbumsByGenre({
      serverId,
      genre,
      libraryScope: scope,
      sort: albumSortClauses(sort),
      limit: pageSize,
      offset,
    });
    if (resp.source !== 'local') return { albums: [], hasMore: false };
    return {
      albums: resp.albums.map(albumToAlbum),
      hasMore: resp.hasMore,
    };
  } catch {
    return { albums: [], hasMore: false };
  }
}

export async function fetchGenreAlbumTotal(
  serverId: string,
  genre: string,
  indexEnabled: boolean,
  sort: AlbumBrowseSort,
): Promise<number | null> {
  if (!genre.trim()) return null;
  const scope = libraryScopeForServer(serverId) ?? undefined;
  if (indexEnabled && serverId && (await libraryIsReady(serverId))) {
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
