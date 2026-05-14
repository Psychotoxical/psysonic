import { describe, expect, it } from 'vitest';
import { filterSearchArtistsWithNoAlbums } from './subsonicSearch';
import type { SubsonicArtist } from './subsonicTypes';

describe('filterSearchArtistsWithNoAlbums', () => {
  it('removes artists with albumCount 0', () => {
    const artists: SubsonicArtist[] = [
      { id: '1', name: 'Real', albumCount: 2 },
      { id: '2', name: 'Ghost', albumCount: 0 },
    ];
    expect(filterSearchArtistsWithNoAlbums(artists)).toEqual([artists[0]]);
  });

  it('keeps artists when albumCount is omitted', () => {
    const artists: SubsonicArtist[] = [{ id: '1', name: 'Unknown count' }];
    expect(filterSearchArtistsWithNoAlbums(artists)).toEqual(artists);
  });
});
