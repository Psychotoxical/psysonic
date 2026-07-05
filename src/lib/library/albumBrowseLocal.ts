import { libraryAdvancedSearch, libraryListAlbumsByGenre } from '@/lib/api/library';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { libraryScopeForServer } from '@/lib/api/subsonicClient';
import { dedupeById } from '@/lib/util/dedupeById';
import { albumToAlbum } from './advancedSearchLocal';
import { sharedServerFilters } from './albumBrowseFilters';
import { albumSortClauses, sortSubsonicAlbums } from './albumBrowseSort';
import { libraryIsReady } from './libraryReady';
import type { AlbumBrowsePageResult, AlbumBrowseQuery } from './albumBrowseTypes';
import { GENRE_ALBUM_FETCH_LIMIT } from './albumBrowseTypes';

function markServerStarredAlbums(albums: SubsonicAlbum[]) {
  return albums.map(a => ({ ...a, starred: a.starred ?? 'true' }));
}

/** Local index: combined genre + year + lossless filters (AND), genres OR union. */
export async function runLocalAlbumBrowse(
  serverId: string,
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
  restrictAlbumIds?: string[],
): Promise<AlbumBrowsePageResult | null> {
  if (!serverId || !(await libraryIsReady(serverId))) return null;

  const scope = libraryScopeForServer(serverId) ?? undefined;
  const useServerStarredIds = restrictAlbumIds != null;
  const shared = sharedServerFilters(query, useServerStarredIds);
  const starredOnly = useServerStarredIds ? undefined : (query.starredOnly || undefined);

  if (query.genres.length > 0) {
    if (query.genres.length === 1) {
      // Genre-only fast path; combined filters (year / lossless / compilation) need advanced search.
      if (shared.length === 0) {
        try {
          const resp = await libraryListAlbumsByGenre({
            serverId,
            genre: query.genres[0],
            libraryScope: scope,
            sort: albumSortClauses(query.sort),
            limit: pageSize,
            offset,
          });
          if (resp.source !== 'local') return null;
          let albums = resp.albums.map(albumToAlbum);
          if (useServerStarredIds) albums = markServerStarredAlbums(albums);
          return { albums, hasMore: resp.hasMore };
        } catch {
          return null;
        }
      }
      try {
        const resp = await libraryAdvancedSearch({
          serverId,
          libraryScope: scope,
          entityTypes: ['album'],
          filters: [{ field: 'genre', op: 'eq', value: query.genres[0] }, ...shared],
          starredOnly,
          restrictAlbumIds: useServerStarredIds ? restrictAlbumIds : undefined,
          sort: albumSortClauses(query.sort),
          limit: pageSize,
          offset,
          skipTotals: true,
        });
        if (resp.source !== 'local') return null;
        let albums = resp.albums.map(albumToAlbum);
        if (useServerStarredIds) albums = markServerStarredAlbums(albums);
        return { albums, hasMore: albums.length === pageSize };
      } catch {
        return null;
      }
    }
    if (offset > 0) return { albums: [], hasMore: false };
    try {
      const pages = await Promise.all(
        query.genres.map(genre =>
          libraryAdvancedSearch({
            serverId,
            libraryScope: scope,
            entityTypes: ['album'],
            filters: [{ field: 'genre', op: 'eq', value: genre }, ...shared],
            starredOnly,
            restrictAlbumIds: useServerStarredIds ? restrictAlbumIds : undefined,
            sort: albumSortClauses(query.sort),
            limit: GENRE_ALBUM_FETCH_LIMIT,
            offset: 0,
            skipTotals: true,
          }),
        ),
      );
      if (pages.some(p => p.source !== 'local')) return null;
      let merged = dedupeById(pages.flatMap(p => p.albums.map(albumToAlbum)));
      if (useServerStarredIds) merged = markServerStarredAlbums(merged);
      return {
        albums: sortSubsonicAlbums(merged, query.sort),
        hasMore: false,
      };
    } catch {
      return null;
    }
  }

  try {
    const resp = await libraryAdvancedSearch({
      serverId,
      libraryScope: scope,
      entityTypes: ['album'],
      filters: shared,
      starredOnly,
      restrictAlbumIds: useServerStarredIds ? restrictAlbumIds : undefined,
      sort: albumSortClauses(query.sort),
      limit: pageSize,
      offset,
      skipTotals: true,
    });
    if (resp.source !== 'local') return null;
    let albums = resp.albums.map(albumToAlbum);
    if (useServerStarredIds) albums = markServerStarredAlbums(albums);
    return { albums, hasMore: albums.length === pageSize };
  } catch {
    return null;
  }
}
