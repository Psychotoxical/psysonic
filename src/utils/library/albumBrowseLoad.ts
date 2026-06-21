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
import { libraryGetGenreAlbumCounts } from '../../api/library';
import { libraryScopeForServer } from '../../api/subsonicClient';
import { libraryIsReady } from './libraryReady';
import type {
  AlbumBrowseFetchCallbacks,
  AlbumBrowsePageResult,
  AlbumBrowseQuery,
  GenreFilterOption,
} from './albumBrowseTypes';
import { GENRE_ALBUM_FETCH_LIMIT } from './albumBrowseTypes';

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
  const scope = libraryScopeForServer(serverId);
  const hasCombinedFilters =
    albumBrowseHasServerFilters(withoutGenre) || query.compFilter !== 'all';

  // Sidebar library scope only: use the full scoped genre catalog from the local
  // index instead of getGenres() (server-wide) or a 500-album sample.
  if (indexEnabled && serverId && scope && !hasCombinedFilters && (await libraryIsReady(serverId))) {
    try {
      const rows = await libraryGetGenreAlbumCounts({
        serverId,
        libraryScope: scope,
      });
      return rows.map(row => ({ genre: row.value, count: row.albumCount }));
    } catch {
      /* fall through to album-derived options */
    }
  }

  const page = await fetchAlbumBrowsePage(
    serverId,
    indexEnabled,
    withoutGenre,
    0,
    GENRE_ALBUM_FETCH_LIMIT,
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
