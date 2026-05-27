import { getAlbumList } from '../../api/subsonicLibrary';
import { getAlbumsByGenre } from '../../api/subsonicGenres';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import type { LibraryFilterClause } from '../../api/library';
import { libraryAdvancedSearch } from '../../api/library';
import { libraryScopeForServer } from '../../api/subsonicClient';
import { dedupeById } from '../dedupeById';
import {
  albumYearFilterClauses,
  albumYearSubsonicParams,
  type AlbumYearBounds,
} from './albumYearFilter';
import { peekStarredAlbumBrowseCache } from './albumBrowseStarredCache';
import { refreshStarredAlbumIndexFromServer } from './starredAlbumIndexSync';
import { albumToAlbum } from './advancedSearchLocal';
import { libraryIsReady } from './libraryReady';
import { albumSortClauses, sortSubsonicAlbums, type AlbumBrowseSort } from './albumBrowseSort';

const GENRE_ALBUM_FETCH_LIMIT = 500;

export type AlbumBrowseQuery = {
  sort: AlbumBrowseSort;
  genres: string[];
  year?: AlbumYearBounds;
  losslessOnly: boolean;
  starredOnly: boolean;
};

export type AlbumBrowsePageResult = {
  albums: SubsonicAlbum[];
  hasMore: boolean;
};

export type AlbumBrowseFetchCallbacks = {
  /** Earlier page (cache / local index) before server favorites refresh finishes. */
  onPartial?: (page: AlbumBrowsePageResult) => void;
};

export function albumBrowseHasGenreFilter(query: AlbumBrowseQuery): boolean {
  return query.genres.length > 0;
}

export function albumBrowseHasServerFilters(query: AlbumBrowseQuery): boolean {
  return (
    albumBrowseHasGenreFilter(query)
    || query.year != null
    || query.losslessOnly
    || query.starredOnly
  );
}

/** Favorites need the local index when combined with lossless or genre (AND). */
export function albumBrowseStarredNeedsLocalIntersect(
  query: AlbumBrowseQuery,
  indexEnabled: boolean,
  serverId: string | null | undefined,
): boolean {
  return !!(
    query.starredOnly
    && indexEnabled
    && serverId
    && (query.losslessOnly || query.genres.length > 0)
  );
}

function sharedServerFilters(
  query: AlbumBrowseQuery,
  useServerStarredIds: boolean,
): LibraryFilterClause[] {
  const filters: LibraryFilterClause[] = [];
  if (query.year) filters.push(...albumYearFilterClauses(query.year));
  if (query.losslessOnly) filters.push({ field: 'lossless', op: 'is_true' });
  if (query.starredOnly && !useServerStarredIds) {
    filters.push({ field: 'starred', op: 'is_true' });
  }
  return filters;
}

/** Client-side starred filter (star/unstar overrides in-session). */
export function filterAlbumsByStarred(
  albums: SubsonicAlbum[],
  starredOverrides: Record<string, boolean>,
): SubsonicAlbum[] {
  return albums.filter(a => {
    if (a.id in starredOverrides) return starredOverrides[a.id];
    return !!a.starred;
  });
}

export function filterAlbumsByYearBounds(
  albums: SubsonicAlbum[],
  bounds: AlbumYearBounds,
): SubsonicAlbum[] {
  return albums.filter(a => {
    if (a.year == null) return false;
    if (bounds.from != null && a.year < bounds.from) return false;
    if (bounds.to != null && a.year > bounds.to) return false;
    return true;
  });
}

export type AlbumCompFilter = 'all' | 'only' | 'hide';

export function filterAlbumsByCompilation(
  albums: SubsonicAlbum[],
  compFilter: AlbumCompFilter,
): SubsonicAlbum[] {
  if (compFilter === 'only') return albums.filter(a => a.isCompilation);
  if (compFilter === 'hide') return albums.filter(a => !a.isCompilation);
  return albums;
}

export type GenreFilterOption = {
  genre: string;
  count: number;
};

/** Album counts per non-empty `genre`, highest count first. */
export function countGenresFromAlbums(albums: SubsonicAlbum[]): GenreFilterOption[] {
  const counts = new Map<string, number>();
  for (const a of albums) {
    const g = (a.genre ?? '').trim();
    if (!g) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre));
}

/** Unique non-empty `genre` values from album rows (sorted by count, then name). */
export function extractGenresFromAlbums(albums: SubsonicAlbum[]): string[] {
  return countGenresFromAlbums(albums).map(o => o.genre);
}

/** OR match against album `genre` (same spirit as genre-filtered browse). */
export function filterAlbumsByGenres(albums: SubsonicAlbum[], genres: string[]): SubsonicAlbum[] {
  if (genres.length === 0) return albums;
  const sel = genres.map(g => g.toLowerCase());
  return albums.filter(a => {
    const ag = (a.genre ?? '').toLowerCase();
    return sel.some(g => ag === g || ag.includes(g));
  });
}

async function fetchByGenres(genres: string[]): Promise<SubsonicAlbum[]> {
  const results = await Promise.all(genres.map(g => getAlbumsByGenre(g, GENRE_ALBUM_FETCH_LIMIT, 0)));
  return dedupeById(results.flat());
}

function markServerStarredAlbums(albums: SubsonicAlbum[]): SubsonicAlbum[] {
  return albums.map(a => ({ ...a, starred: a.starred ?? 'true' }));
}

function paginateStarredAlbums(
  all: SubsonicAlbum[],
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
): AlbumBrowsePageResult {
  const filtered = applyNetworkPostFilters(all, query);
  const page = filtered.slice(offset, offset + pageSize);
  return { albums: page, hasMore: offset + pageSize < filtered.length };
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

function applyNetworkPostFilters(
  albums: SubsonicAlbum[],
  query: AlbumBrowseQuery,
): SubsonicAlbum[] {
  let out = albums;
  if (query.year) out = filterAlbumsByYearBounds(out, query.year);
  if (query.starredOnly) out = out.filter(a => !!a.starred);
  return sortSubsonicAlbums(out, query.sort);
}

async function fetchAlbumBrowseNetwork(
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
): Promise<AlbumBrowsePageResult> {
  if (query.genres.length > 0) {
    if (offset > 0) return { albums: [], hasMore: false };
    const data = applyNetworkPostFilters(await fetchByGenres(query.genres), query);
    return { albums: data, hasMore: false };
  }

  if (query.starredOnly) {
    const extra = query.year ? albumYearSubsonicParams(query.year) : {};
    const data = applyNetworkPostFilters(
      await getAlbumList('starred', pageSize, offset, extra),
      query,
    );
    return { albums: data, hasMore: data.length === pageSize };
  }

  if (query.year) {
    const data = await getAlbumList(
      'byYear',
      pageSize,
      offset,
      albumYearSubsonicParams(query.year),
    );
    return { albums: data, hasMore: data.length === pageSize };
  }

  const data = await getAlbumList(query.sort, pageSize, offset, {});
  return { albums: data, hasMore: data.length === pageSize };
}

async function fetchStarredAlbumBrowse(
  serverId: string,
  indexEnabled: boolean,
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
  callbacks?: AlbumBrowseFetchCallbacks,
): Promise<AlbumBrowsePageResult> {
  const emitPartial = (page: AlbumBrowsePageResult | null) => {
    if (page && offset === 0 && page.albums.length > 0) {
      callbacks?.onPartial?.(page);
    }
  };

  if (offset === 0) {
    const cached = peekStarredAlbumBrowseCache(serverId);
    if (cached?.length) {
      if (albumBrowseStarredNeedsLocalIntersect(query, indexEnabled, serverId)) {
        const fromCache = await runLocalAlbumBrowse(
          serverId,
          query,
          0,
          pageSize,
          cached.map(a => a.id),
        );
        emitPartial(fromCache);
      } else {
        emitPartial(paginateStarredAlbums(cached, query, 0, pageSize));
      }
    }
  }

  const serverAlbums = await refreshStarredAlbumIndexFromServer(serverId, indexEnabled);

  if (albumBrowseStarredNeedsLocalIntersect(query, indexEnabled, serverId)) {
    const serverIds = serverAlbums.map(a => a.id);
    const authoritative = await runLocalAlbumBrowse(serverId, query, offset, pageSize, serverIds);
    if (authoritative != null) return authoritative;
    if (query.losslessOnly) return { albums: [], hasMore: false };
  }

  return paginateStarredAlbums(serverAlbums, query, offset, pageSize);
}

/**
 * One entry point for Albums browse: local advanced search when possible, else Subsonic.
 * Favorites: reconciled cache (`onPartial`), then `getStarred2` → DB reconcile → final list.
 */
/**
 * Genres present in albums matching all filters except genre (for combined-filter UI).
 * Returns `null` when the caller should use the full server genre list.
 */
export async function fetchAlbumBrowseGenreOptions(
  serverId: string,
  indexEnabled: boolean,
  query: AlbumBrowseQuery,
  compFilter: AlbumCompFilter,
): Promise<GenreFilterOption[]> {
  const withoutGenre: AlbumBrowseQuery = { ...query, genres: [] };
  const page = await fetchAlbumBrowsePage(
    serverId,
    indexEnabled,
    withoutGenre,
    0,
    GENRE_ALBUM_FETCH_LIMIT,
  );
  return countGenresFromAlbums(filterAlbumsByCompilation(page.albums, compFilter));
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
