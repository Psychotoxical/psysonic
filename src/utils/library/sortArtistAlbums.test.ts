import { describe, expect, it } from 'vitest';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { sortArtistAlbums } from './sortArtistAlbums';

const album = (id: string, name: string, year?: number): SubsonicAlbum => ({
  id,
  name,
  artist: 'A',
  artistId: 'a',
  songCount: 1,
  duration: 1,
  year,
});

describe('sortArtistAlbums', () => {
  const albums = [
    album('3', 'Gamma', 2000),
    album('1', 'Alpha', 1990),
    album('2', 'Beta', 2000),
  ];

  it('returns input order for releaseType', () => {
    expect(sortArtistAlbums(albums, 'releaseType').map(a => a.id)).toEqual(['3', '1', '2']);
  });

  it('sorts by year descending then name', () => {
    expect(sortArtistAlbums(albums, 'yearDesc').map(a => a.id)).toEqual(['2', '3', '1']);
  });

  it('sorts by year ascending then name', () => {
    expect(sortArtistAlbums(albums, 'yearAsc').map(a => a.id)).toEqual(['1', '2', '3']);
  });
});
