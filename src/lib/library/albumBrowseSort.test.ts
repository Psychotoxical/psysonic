import { describe, expect, it } from 'vitest';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { albumSortClauses, sortSubsonicAlbums } from './albumBrowseSort';

const album = (artist: string, name: string, year?: number): SubsonicAlbum =>
  ({ id: `${artist}-${name}`, artist, name, year }) as SubsonicAlbum;

describe('albumSortClauses', () => {
  it('sorts by artist then album name', () => {
    expect(albumSortClauses('alphabeticalByArtist')).toEqual([
      { field: 'artist', dir: 'asc' },
      { field: 'name', dir: 'asc' },
    ]);
  });

  it('sorts by album name then artist', () => {
    expect(albumSortClauses('alphabeticalByName')).toEqual([
      { field: 'name', dir: 'asc' },
      { field: 'artist', dir: 'asc' },
    ]);
  });

  it('sorts by artist, then year, then album name', () => {
    expect(albumSortClauses('byArtistThenYear')).toEqual([
      { field: 'artist', dir: 'asc' },
      { field: 'year', dir: 'asc' },
      { field: 'name', dir: 'asc' },
    ]);
  });
});

describe('sortSubsonicAlbums', () => {
  it('orders each artist group by album name when sorting by artist', () => {
    const input = [
      album('Artist B', 'Solitude'),
      album('Artist A', 'Mirage'),
      album('Artist B', 'Cascade'),
      album('Artist A', 'Ember'),
      album('Artist A', 'Vertex'),
    ];
    const ordered = sortSubsonicAlbums(input, 'alphabeticalByArtist').map(a => `${a.artist} - ${a.name}`);
    expect(ordered).toEqual([
      'Artist A - Ember',
      'Artist A - Mirage',
      'Artist A - Vertex',
      'Artist B - Cascade',
      'Artist B - Solitude',
    ]);
  });

  it('breaks album-name ties by artist when sorting by name', () => {
    const input = [
      album('Artist Z', 'Greatest Hits'),
      album('Artist A', 'Greatest Hits'),
    ];
    const ordered = sortSubsonicAlbums(input, 'alphabeticalByName').map(a => a.artist);
    expect(ordered).toEqual(['Artist A', 'Artist Z']);
  });

  it('orders each artist chronologically (then by title) when sorting by artist+year', () => {
    const input = [
      album('Artist A', 'Mirage', 1982),
      album('Artist B', 'Nocturne', 1997),
      album('Artist A', 'Debut', 1981),
      album('Artist B', 'Aftermath', 2001),
      album('Artist A', 'Reprise', 1982), // same year as Mirage → title tiebreak
    ];
    const ordered = sortSubsonicAlbums(input, 'byArtistThenYear').map(a => `${a.artist} - ${a.name}`);
    expect(ordered).toEqual([
      'Artist A - Debut',
      'Artist A - Mirage',
      'Artist A - Reprise',
      'Artist B - Nocturne',
      'Artist B - Aftermath',
    ]);
  });
});
