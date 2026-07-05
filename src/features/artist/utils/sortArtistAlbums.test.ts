import { describe, expect, it } from 'vitest';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { sortArtistAlbumsByYear } from '@/features/artist/utils/sortArtistAlbums';

const album = (id: string, name: string, year?: number): SubsonicAlbum => ({
  id,
  name,
  artist: 'A',
  artistId: 'a',
  songCount: 1,
  duration: 1,
  year,
});

describe('sortArtistAlbumsByYear', () => {
  const albums = [
    album('3', 'Gamma', 2000),
    album('1', 'Alpha', 1990),
    album('2', 'Beta', 2000),
  ];

  it('sorts by year descending then name', () => {
    expect(sortArtistAlbumsByYear(albums, 'yearDesc').map(a => a.id)).toEqual(['2', '3', '1']);
  });

  it('sorts by year ascending then name', () => {
    expect(sortArtistAlbumsByYear(albums, 'yearAsc').map(a => a.id)).toEqual(['1', '2', '3']);
  });
});
