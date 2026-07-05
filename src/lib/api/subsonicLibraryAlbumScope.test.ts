import { describe, expect, it } from 'vitest';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { filterAlbumsByScopedAlbumIds } from '@/lib/api/subsonicLibrary';

const album = (id: string): SubsonicAlbum => ({
  id,
  name: id,
  artist: 'a',
  artistId: '1',
  songCount: 1,
  duration: 1,
});

describe('filterAlbumsByScopedAlbumIds', () => {
  it('returns all albums when scope is unset', () => {
    const albums = [album('a'), album('b')];
    expect(filterAlbumsByScopedAlbumIds(albums, null)).toEqual(albums);
  });

  it('keeps only albums in the scoped id set', () => {
    const albums = [album('a'), album('b'), album('c')];
    expect(filterAlbumsByScopedAlbumIds(albums, new Set(['a', 'c']))).toEqual([album('a'), album('c')]);
  });
});
