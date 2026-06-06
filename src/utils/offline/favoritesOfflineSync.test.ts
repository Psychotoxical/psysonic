import { describe, expect, it } from 'vitest';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { mergeStarredSongsUnion } from './favoritesOfflineSync';

function song(id: string): SubsonicSong {
  return {
    id,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Album',
    albumId: 'al-1',
    duration: 180,
  };
}

describe('mergeStarredSongsUnion', () => {
  it('dedupes the same track from direct song, album, and artist stars', () => {
    const shared = song('t-shared');
    const union = mergeStarredSongsUnion(
      [shared, song('t-solo')],
      [[shared, song('t-album-only')]],
      [[shared, song('t-artist-only')]],
    );
    expect(union.map(s => s.id).sort()).toEqual([
      't-album-only',
      't-artist-only',
      't-shared',
      't-solo',
    ]);
  });

  it('returns empty when nothing is starred', () => {
    expect(mergeStarredSongsUnion([], [], [])).toEqual([]);
  });
});
