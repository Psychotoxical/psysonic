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
  filterAlbumsByCompilation,
  filterAlbumsByStarred,
} from './albumBrowseFilters';
export { runLocalAlbumBrowse } from './albumBrowseLocal';

import { countGenresFromAlbums, filterAlbumsByCompilation } from './albumBrowseFilters';
import { runLocalAlbumBrowse } from './albumBrowseLocal';
import { fetchAlbumBrowseNetwork } from './albumBrowseNetwork';
import { fetchStarredAlbumBrowse } from './albumBrowseStarredFetch';
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
  query: AlbumBrowseQuery,
  offset: number,
  chunkSize: number,
): Promise<AlbumBrowsePageResult | null> {
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
