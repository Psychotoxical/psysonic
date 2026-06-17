import { describe, expect, it } from 'vitest';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import { albumSortClauses, sortSubsonicAlbums } from './albumBrowseSort';

const album = (artist: string, name: string): SubsonicAlbum =>
  ({ id: `${artist}-${name}`, artist, name }) as SubsonicAlbum;

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
});

describe('sortSubsonicAlbums', () => {
  it('orders each artist group by album name when sorting by artist', () => {
    const input = [
      album('Rammstein', 'Sehnsucht'),
      album('Duran Duran', 'Rio'),
      album('Rammstein', 'Mutter'),
      album('Duran Duran', 'DD'),
      album('Duran Duran', 'The Wedding Album'),
    ];
    const ordered = sortSubsonicAlbums(input, 'alphabeticalByArtist').map(a => `${a.artist} - ${a.name}`);
    expect(ordered).toEqual([
      'Duran Duran - DD',
      'Duran Duran - Rio',
      'Duran Duran - The Wedding Album',
      'Rammstein - Mutter',
      'Rammstein - Sehnsucht',
    ]);
  });

  it('breaks album-name ties by artist when sorting by name', () => {
    const input = [
      album('Zebra', 'Greatest Hits'),
      album('Alpha', 'Greatest Hits'),
    ];
    const ordered = sortSubsonicAlbums(input, 'alphabeticalByName').map(a => a.artist);
    expect(ordered).toEqual(['Alpha', 'Zebra']);
  });
});
