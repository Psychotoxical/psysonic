import type { SubsonicAlbum } from '../../api/subsonicTypes';
import type { LibraryFilterClause } from '../../api/library';
import { albumIsCompilation, type AlbumCompFilter } from './albumCompilation';
import { albumYearFilterClauses, type AlbumYearBounds } from './albumYearFilter';
import type { AlbumBrowseQuery, GenreFilterOption } from './albumBrowseTypes';

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

export function filterAlbumsByGenres(
  albums: SubsonicAlbum[],
  genres: string[],
): SubsonicAlbum[] {
  if (genres.length === 0) return albums;
  const wanted = new Set(genres.map(g => g.toLowerCase()));
  return albums.filter(a => {
    const g = (a.genre ?? '').trim().toLowerCase();
    return g !== '' && wanted.has(g);
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
    const g = (a.genre ?? '').trim();
    if (!g) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([genre, count]) => ({ genre, count }))
    .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre));
}
