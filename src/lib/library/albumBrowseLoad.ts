/**
 * Albums browse: local index + Subsonic network paths.
 * Filters and types live in sibling modules; this file is the fetch entry point.
 */
export type { AlbumCompFilter } from './albumCompilation';
export type {
  AlbumBrowseFetchCallbacks,
  AlbumBrowsePageResult,
  AlbumBrowseQuery,
  GenreFilterOption,
} from './albumBrowseTypes';
export {
  albumBrowseHasGenreFilter,
  albumBrowseHasServerFilters,
  applyAlbumBrowseClientFilters,
  filterAlbumsByCompilation,
  filterAlbumsByStarred,
} from './albumBrowseFilters';
export { runLocalAlbumBrowse } from './albumBrowseLocal';

import { albumBrowseHasServerFilters, countGenresFromAlbums, filterAlbumsByCompilation } from './albumBrowseFilters';
import { runLocalAlbumBrowse } from './albumBrowseLocal';
import { fetchAlbumBrowseNetwork } from './albumBrowseNetwork';
import { fetchStarredAlbumBrowse } from './albumBrowseStarredFetch';
import { librarySelectionForServer } from '@/lib/api/subsonicClient';
import { libraryIsReady } from './libraryReady';
import type {
  AlbumBrowseFetchCallbacks,
  AlbumBrowsePageResult,
  AlbumBrowseQuery,
  GenreFilterOption,
} from './albumBrowseTypes';
import { GENRE_ALBUM_FETCH_LIMIT } from './albumBrowseTypes';
import { albumBrowseTimed, emitAlbumBrowseDebug } from './albumBrowseDebug';
import { fetchGenreAlbumCountsDeduped } from './albumBrowseGenreCountsCache';

/** Unfiltered browse: paint a small SQL page first, then grow the catalog buffer. */
export function albumBrowseBootstrapEligible(query: AlbumBrowseQuery): boolean {
  return !albumBrowseHasServerFilters(query) && query.compFilter === 'all';
}

/** One local-index chunk for lazy catalog loading (All Albums slice mode). */
export async function fetchLocalAlbumCatalogChunk(
  serverId: string,
  indexEnabled: boolean,
  query: AlbumBrowseQuery,
  offset: number,
  chunkSize: number,
): Promise<AlbumBrowsePageResult | null> {
  if (query.starredOnly) {
    return fetchAlbumBrowsePage(serverId, indexEnabled, query, offset, chunkSize);
  }
  const singleGenre = query.genres.length === 1;
  if (query.genres.length > 1 && offset > 0) {
    return { albums: [], hasMore: false };
  }
  const limit = singleGenre
    ? chunkSize
    : query.genres.length > 0 && offset === 0
      ? GENRE_ALBUM_FETCH_LIMIT
      : chunkSize;
  return runLocalAlbumBrowse(serverId, query, offset, limit);
}

/** Genres in albums matching all filters except genre (for combined-filter UI). */
export async function fetchAlbumBrowseGenreOptions(
  serverId: string,
  indexEnabled: boolean,
  query: AlbumBrowseQuery,
): Promise<GenreFilterOption[]> {
  const withoutGenre: AlbumBrowseQuery = { ...query, genres: [] };
  const selection = librarySelectionForServer(serverId);
  const hasCombinedFilters =
    albumBrowseHasServerFilters(withoutGenre) || query.compFilter !== 'all';

  // Sidebar library scope only: build the genre catalog from the light per-library
  // `track_genre` index query instead of getGenres() (server-wide) or a 500-album
  // multi-scope CTE sample. For multi-library selection we sum counts per library —
  // cross-library album duplicates are counted once per library (a cosmetic hint),
  // but the genre set stays correct and each query is an indexed GROUP BY.
  if (indexEnabled && serverId && !hasCombinedFilters && (await libraryIsReady(serverId))) {
    try {
      if (selection.length === 0) {
        const rows = await albumBrowseTimed(
          'genre_album_counts',
          () => fetchGenreAlbumCountsDeduped({ serverId }),
          { libraryCount: 0 },
        );
        return rows.map(row => ({ genre: row.value, count: row.albumCount }));
      }
      if (selection.length === 1) {
        const rows = await albumBrowseTimed(
          'genre_album_counts',
          () => fetchGenreAlbumCountsDeduped({ serverId, libraryScope: selection[0] }),
          { libraryCount: 1 },
        );
        return rows.map(row => ({ genre: row.value, count: row.albumCount }));
      }
      const rows = await albumBrowseTimed(
        'genre_album_counts_multi',
        () => fetchGenreAlbumCountsDeduped({ serverId, libraryScopes: selection }),
        { libraryCount: selection.length },
      );
      return rows.map(row => ({ genre: row.value, count: row.albumCount })).sort(
        (a, b) => b.count - a.count || a.genre.localeCompare(b.genre),
      );
    } catch {
      emitAlbumBrowseDebug('genre_album_counts_fallback', { reason: 'error' });
      /* fall through to album-derived options */
    }
  }

  const page = await albumBrowseTimed(
    'genre_options_album_page',
    () => fetchAlbumBrowsePage(
      serverId,
      indexEnabled,
      withoutGenre,
      0,
      GENRE_ALBUM_FETCH_LIMIT,
    ),
    { limit: GENRE_ALBUM_FETCH_LIMIT },
  );
  return countGenresFromAlbums(filterAlbumsByCompilation(page.albums, query.compFilter));
}

export async function fetchAlbumBrowsePage(
  serverId: string,
  indexEnabled: boolean,
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
  callbacks?: AlbumBrowseFetchCallbacks,
): Promise<AlbumBrowsePageResult> {
  if (query.losslessOnly && (!indexEnabled || !serverId)) {
    return { albums: [], hasMore: false };
  }

  if (query.starredOnly) {
    return fetchStarredAlbumBrowse(serverId, indexEnabled, query, offset, pageSize, callbacks);
  }

  if (indexEnabled && serverId) {
    const local = await runLocalAlbumBrowse(serverId, query, offset, pageSize);
    if (local != null) return local;
  }

  return fetchAlbumBrowseNetwork(query, offset, pageSize);
}
