import { describe, expect, it } from 'vitest';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import {
  albumBrowseHasGenreFilter,
  albumBrowseHasServerFilters,
  filterAlbumsByYearBounds,
  type AlbumBrowseQuery,
} from './albumBrowseLoad';

describe('albumBrowseLoad', () => {
  const base: AlbumBrowseQuery = {
    sort: 'alphabeticalByName',
    genres: [],
    losslessOnly: false,
  };

  it('detects combined server filters', () => {
    expect(albumBrowseHasServerFilters(base)).toBe(false);
    expect(albumBrowseHasServerFilters({ ...base, genres: ['Rock'] })).toBe(true);
    expect(albumBrowseHasServerFilters({ ...base, year: { from: 1990 } })).toBe(true);
    expect(albumBrowseHasServerFilters({ ...base, losslessOnly: true })).toBe(true);
    expect(
      albumBrowseHasServerFilters({
        ...base,
        genres: ['Jazz'],
        year: { to: 2000 },
        losslessOnly: true,
      }),
    ).toBe(true);
  });

  it('genre filter disables pagination path', () => {
    expect(albumBrowseHasGenreFilter({ ...base, genres: ['Rock'] })).toBe(true);
  });
});

describe('filterAlbumsByYearBounds', () => {
  const albums: SubsonicAlbum[] = [
    { id: '1', name: 'A', artist: 'X', artistId: 'a', songCount: 1, duration: 1, year: 1985 },
    { id: '2', name: 'B', artist: 'Y', artistId: 'b', songCount: 1, duration: 1, year: 1995 },
    { id: '3', name: 'C', artist: 'Z', artistId: 'c', songCount: 1, duration: 1, year: 2005 },
  ];

  it('filters with only from bound', () => {
    expect(filterAlbumsByYearBounds(albums, { from: 1990 }).map(a => a.id)).toEqual(['2', '3']);
  });

  it('filters with only to bound', () => {
    expect(filterAlbumsByYearBounds(albums, { to: 1995 }).map(a => a.id)).toEqual(['1', '2']);
  });
});
