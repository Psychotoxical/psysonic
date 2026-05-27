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

function sharedServerFilters(query: AlbumBrowseQuery): LibraryFilterClause[] {
  const filters: LibraryFilterClause[] = [];
  if (query.year) filters.push(...albumYearFilterClauses(query.year));
  if (query.losslessOnly) filters.push({ field: 'lossless', op: 'is_true' });
  if (query.starredOnly) filters.push({ field: 'starred', op: 'is_true' });
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

/** Local index: combined genre + year + lossless filters (AND), genres OR union. */
export async function runLocalAlbumBrowse(
  serverId: string,
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
): Promise<{ albums: SubsonicAlbum[]; hasMore: boolean } | null> {
  if (!serverId || !(await libraryIsReady(serverId))) return null;

  const scope = libraryScopeForServer(serverId) ?? undefined;
  const shared = sharedServerFilters(query);

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
            starredOnly: query.starredOnly || undefined,
            sort: albumSortClauses(query.sort),
            limit: GENRE_ALBUM_FETCH_LIMIT,
            offset: 0,
            skipTotals: true,
          }),
        ),
      );
      if (pages.some(p => p.source !== 'local')) return null;
      const merged = dedupeById(pages.flatMap(p => p.albums.map(albumToAlbum)));
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
      starredOnly: query.starredOnly || undefined,
      sort: albumSortClauses(query.sort),
      limit: pageSize,
      offset,
      skipTotals: true,
    });
    if (resp.source !== 'local') return null;
    const albums = resp.albums.map(albumToAlbum);
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
): Promise<{ albums: SubsonicAlbum[]; hasMore: boolean }> {
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

export type AlbumBrowsePageResult = {
  albums: SubsonicAlbum[];
  hasMore: boolean;
};

/**
 * One entry point for Albums browse: local advanced search when possible, else Subsonic.
 * Lossless without a local index returns an empty page (no network walk on this screen).
 * Starred filter uses album-level stars only (`album.starred_at` / `getAlbumList.starred`).
 */
export async function fetchAlbumBrowsePage(
  serverId: string,
  indexEnabled: boolean,
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
): Promise<AlbumBrowsePageResult> {
  if (query.losslessOnly && (!indexEnabled || !serverId)) {
    return { albums: [], hasMore: false };
  }

  if (indexEnabled && serverId) {
    const local = await runLocalAlbumBrowse(serverId, query, offset, pageSize);
    if (local != null) {
      const localStarredEmpty =
        query.starredOnly && local.albums.length === 0 && offset === 0;
      if (!localStarredEmpty) return local;
    }
  }

  return fetchAlbumBrowseNetwork(query, offset, pageSize);
}
