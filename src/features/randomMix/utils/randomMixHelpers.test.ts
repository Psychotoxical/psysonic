import { describe, expect, it } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { filterRandomMixSongs } from '@/features/randomMix/utils/randomMixHelpers';

function song(id: string): SubsonicSong {
  return {
    id,
    title: 't',
    artist: 'A',
    album: 'Al',
    albumId: 'alb',
    duration: 1,
    artistUserRating: 1,
  };
}

describe('filterRandomMixSongs', () => {
  it('applies mix rating filter even when audiobook exclusion is off', () => {
    const cfg = { enabled: true, minSong: 0, minAlbum: 0, minArtist: 2 };
    const out = filterRandomMixSongs([song('1'), song('2')], {
      excludeAudiobooks: false,
      customGenreBlacklist: [],
      mixRatingCfg: { ...cfg, minArtist: 2 },
    });
    expect(out).toHaveLength(0);

    const kept = filterRandomMixSongs([song('1'), { ...song('2'), artistUserRating: 4 }], {
      excludeAudiobooks: false,
      customGenreBlacklist: [],
      mixRatingCfg: cfg,
    });
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe('2');
  });

  it('applies keyword blacklist even when audiobook exclusion is off', () => {
    const blocked = { ...song('1'), artist: '[Unknown Artist]' };
    const out = filterRandomMixSongs([blocked, song('2')], {
      excludeAudiobooks: false,
      customGenreBlacklist: ['[Unknown Artist]'],
      mixRatingCfg: { enabled: false, minSong: 0, minAlbum: 0, minArtist: 0 },
    });
    expect(out).toEqual([song('2')]);
  });
});
