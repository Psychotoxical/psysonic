import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import type { LibraryFilterClause } from '@/lib/api/library';
import { albumIsCompilation, type AlbumCompFilter } from './albumCompilation';
import { albumYearFilterClauses, type AlbumYearBounds } from './albumYearFilter';
import type { AlbumBrowseQuery, GenreFilterOption } from './albumBrowseTypes';
import { genreTagsFor } from './genreTags';

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

export function compilationFilterClauses(compFilter: AlbumCompFilter): LibraryFilterClause[] {
  if (compFilter === 'only') return [{ field: 'compilation', op: 'is_true' }];
  if (compFilter === 'hide') return [{ field: 'compilation', op: 'eq', value: false }];
  return [];
}

export function sharedServerFilters(
  query: AlbumBrowseQuery,
  useServerStarredIds: boolean,
): LibraryFilterClause[] {
  const filters: LibraryFilterClause[] = [];
  if (query.year) filters.push(...albumYearFilterClauses(query.year));
  if (query.losslessOnly) filters.push({ field: 'lossless', op: 'is_true' });
  filters.push(...compilationFilterClauses(query.compFilter));
  if (query.starredOnly && !useServerStarredIds) {
    filters.push({ field: 'starred', op: 'is_true' });
  }
  return filters;
}

export function filterAlbumsByStarred(
  albums: SubsonicAlbum[],
  starredOverrides: Record<string, boolean>,
): SubsonicAlbum[] {
  return albums.filter(a => {
    if (a.id in starredOverrides) return starredOverrides[a.id];
    return !!a.starred;
  });
}

/** Slice favorites grid: fetch is authoritative; only apply optimistic star/unstar overrides. */
export function applyStarredOverridesInSlice(
  albums: SubsonicAlbum[],
  starredOverrides: Record<string, boolean>,
): SubsonicAlbum[] {
  return albums.filter(a => {
    if (a.id in starredOverrides) return starredOverrides[a.id];
    return true;
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

export function filterAlbumsByCompilation(
  albums: SubsonicAlbum[],
  compFilter: AlbumCompFilter,
): SubsonicAlbum[] {
  if (compFilter === 'only') return albums.filter(albumIsCompilation);
  if (compFilter === 'hide') return albums.filter(a => !albumIsCompilation(a));
  return albums;
}

/**
 * Client post-filters for the All Albums grid. Slice mode (local index or offline
 * catalog) already applied compilation / favorites in SQL or `applyAlbumBrowseQuery`.
 */
export function applyAlbumBrowseClientFilters(
  albums: SubsonicAlbum[],
  query: Pick<AlbumBrowseQuery, 'compFilter' | 'starredOnly'>,
  starredOverrides: Record<string, boolean>,
  browseMode: 'slice' | 'page',
): SubsonicAlbum[] {
  const fetchAlreadyFiltered = browseMode === 'slice';
  let out = albums;
  if (query.compFilter !== 'all' && !fetchAlreadyFiltered) {
    out = filterAlbumsByCompilation(out, query.compFilter);
  }
  if (query.starredOnly && fetchAlreadyFiltered) {
    out = applyStarredOverridesInSlice(out, starredOverrides);
  } else if (query.starredOnly) {
    out = filterAlbumsByStarred(out, starredOverrides);
  }
  return out;
}

export function filterAlbumsByGenres(
  albums: SubsonicAlbum[],
  genres: string[],
): SubsonicAlbum[] {
  if (genres.length === 0) return albums;
  const wanted = new Set(genres.map(g => g.toLowerCase()));
  return albums.filter(a => {
    const tags = genreTagsFor(a);
    return tags.some(tag => wanted.has(tag.toLowerCase()));
  });
}

/** Scoped All Albums text search — album title/name only (not performer). */
export function filterAlbumsByNameTextQuery(
  albums: SubsonicAlbum[],
  query: string,
): SubsonicAlbum[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return albums;
  return albums.filter(a => a.name.toLowerCase().includes(needle));
}

export function countGenresFromAlbums(albums: SubsonicAlbum[]): GenreFilterOption[] {
  const counts = new Map<string, number>();
  for (const a of albums) {
    for (const g of genreTagsFor(a)) {
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre));
}
