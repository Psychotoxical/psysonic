import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import type { LibrarySortClause } from '@/lib/api/library';

export type AlbumBrowseSort = 'alphabeticalByName' | 'alphabeticalByArtist' | 'byArtistThenYear';

export function albumSortClauses(sort: AlbumBrowseSort): LibrarySortClause[] {
  // Always append secondary keys so albums sharing the primary key keep a stable
  // order (mirrors `sortSubsonicAlbums`).
  if (sort === 'byArtistThenYear') {
    // Artist, then chronological (oldest first), then title as a same-year tiebreak.
    return [
      { field: 'artist', dir: 'asc' },
      { field: 'year', dir: 'asc' },
      { field: 'name', dir: 'asc' },
    ];
  }
  if (sort === 'alphabeticalByArtist') {
    return [
      { field: 'artist', dir: 'asc' },
      { field: 'name', dir: 'asc' },
    ];
  }
  return [
    { field: 'name', dir: 'asc' },
    { field: 'artist', dir: 'asc' },
  ];
}

/**
 * Subsonic `getAlbumList` type to fetch with for a browse sort (server fallback
 * path only — the local index handles sorting itself). `byArtistThenYear` has
 * no server equivalent, so fetch by artist and let `sortSubsonicAlbums` apply
 * the per-page year ordering on top.
 */
export function albumListFetchType(
  sort: AlbumBrowseSort,
): 'alphabeticalByName' | 'alphabeticalByArtist' {
  return sort === 'alphabeticalByName' ? 'alphabeticalByName' : 'alphabeticalByArtist';
}

export function sortSubsonicAlbums(albums: SubsonicAlbum[], sort: AlbumBrowseSort): SubsonicAlbum[] {
  const out = [...albums];
  out.sort((a, b) => {
    if (sort === 'byArtistThenYear') {
      return (
        a.artist.localeCompare(b.artist) ||
        (a.year ?? 0) - (b.year ?? 0) ||
        a.name.localeCompare(b.name)
      );
    }
    return sort === 'alphabeticalByArtist'
      ? a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name)
      : a.name.localeCompare(b.name) || a.artist.localeCompare(b.artist);
  });
  return out;
}
