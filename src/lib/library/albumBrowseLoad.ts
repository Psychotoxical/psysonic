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
export { runLocalAlbumBrowse, runLocalAlbumScopeBrowse } from './albumBrowseLocal';

import { albumBrowseHasServerFilters, countGenresFromAlbums, filterAlbumsByCompilation } from './albumBrowseFilters';
import { runLocalAlbumBrowse, runLocalAlbumScopeBrowse } from './albumBrowseLocal';
import { fetchAlbumBrowseNetwork } from './albumBrowseNetwork';
import { fetchStarredAlbumBrowse } from './albumBrowseStarredFetch';
import { librarySelectionForServer } from '@/lib/api/subsonicClient';
import { readyLibraryServerKeys } from './libraryReady';
import type {
  AlbumBrowseFetchCallbacks,
  AlbumBrowsePageResult,
  AlbumBrowseQuery,
  GenreFilterOption,
} from './albumBrowseTypes';
import { GENRE_ALBUM_FETCH_LIMIT } from './albumBrowseTypes';
import { albumBrowseTimed, emitAlbumBrowseDebug } from './albumBrowseDebug';
import { fetchGenreAlbumCountsDeduped } from './albumBrowseGenreCountsCache';
import { getLibraryBrowseScope } from './libraryBrowseScope';

function mergeScopedGenreOptions(
  catalogs: readonly GenreFilterOption[][],
): GenreFilterOption[] {
  const merged = new Map<string, GenreFilterOption>();
  for (const catalog of catalogs) {
    for (const row of catalog) {
      const key = row.genre.toLocaleLowerCase();
      const previous = merged.get(key);
      merged.set(key, {
        genre: previous?.genre ?? row.genre,
        count: (previous?.count ?? 0) + row.count,
      });
    }
  }
  return [...merged.values()].sort(
    (a, b) => b.count - a.count || a.genre.localeCompare(b.genre),
  );
}

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
  cursor?: string | null,
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
  if (albumBrowseBootstrapEligible(query)) {
    const scoped = await runLocalAlbumScopeBrowse(serverId, query.sort, limit, cursor);
    if (scoped) return scoped;
  }
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
  const browseScope = getLibraryBrowseScope();
  const hasCombinedFilters =
    albumBrowseHasServerFilters(withoutGenre) || query.compFilter !== 'all';

  // Sidebar library scope only: build the genre catalog from the light per-library
  // `track_genre` index query instead of getGenres() (server-wide) or a 500-album
  // multi-scope CTE sample. For multi-library selection we sum counts per library —
  // cross-library album duplicates are counted once per library (a cosmetic hint),
  // but the genre set stays correct and each query is an indexed GROUP BY.
  if (
    indexEnabled
    && serverId
    && !hasCombinedFilters
    && await readyLibraryServerKeys(browseScope.serverIds.length > 0 ? browseScope.serverIds : [serverId])
  ) {
    try {
      if (browseScope.pairs.length > 0) {
        const catalogs = await Promise.all(browseScope.serverIds.map(async scopedServerId => {
          const pairs = browseScope.pairs.filter(pair => pair.serverId === scopedServerId);
          const wholeServer = pairs.some(pair => pair.libraryId == null);
          const libraryIds = wholeServer
            ? []
            : [...new Set(pairs.flatMap(pair => pair.libraryId ? [pair.libraryId] : []))];
          const rows = await fetchGenreAlbumCountsDeduped({
            serverId: scopedServerId,
            ...(libraryIds.length === 1
              ? { libraryScope: libraryIds[0] }
              : libraryIds.length > 1
                ? { libraryScopes: libraryIds }
                : {}),
          });
          return rows.map(row => ({ genre: row.value, count: row.albumCount }));
        }));
        return mergeScopedGenreOptions(catalogs);
      }
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
  const multiServer = getLibraryBrowseScope().multiServer;
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

  if (multiServer) return { albums: [], hasMore: false };

  return fetchAlbumBrowseNetwork(query, offset, pageSize);
}
