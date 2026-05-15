import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { usePlayerStore } from '../../store/playerStore';
import { resetPlayerStore } from '../../test/helpers/storeReset';

vi.mock('../../api/subsonicRatings', () => ({
  prefetchArtistUserRatings: vi.fn(),
  prefetchAlbumUserRatings: vi.fn(),
  parseSubsonicEntityStarRating: vi.fn(),
}));

import { prefetchArtistUserRatings, prefetchAlbumUserRatings } from '../../api/subsonicRatings';
import {
  enrichSongsForMixRatingFilter,
  filterTopArtistsForMixRatings,
  passesMixMinRatings,
} from './mixRatingFilter';

const enabledArtist2: { enabled: true; minSong: 0; minAlbum: 0; minArtist: 2 } = {
  enabled: true,
  minSong: 0,
  minAlbum: 0,
  minArtist: 2,
};

function song(partial: Partial<SubsonicSong> & Pick<SubsonicSong, 'id'>): SubsonicSong {
  return {
    title: 't',
    artist: 'A',
    album: 'Al',
    albumId: 'alb-1',
    artistId: 'art-1',
    duration: 180,
    ...partial,
  };
}

beforeEach(() => {
  resetPlayerStore();
  vi.mocked(prefetchArtistUserRatings).mockReset();
  vi.mocked(prefetchAlbumUserRatings).mockReset();
  vi.mocked(prefetchAlbumUserRatings).mockResolvedValue(new Map());
});

describe('passesMixMinRatings — artist axis', () => {
  it('excludes when artistUserRating is at or below threshold', () => {
    expect(passesMixMinRatings(song({ id: '1', artistUserRating: 1 }), enabledArtist2)).toBe(false);
    expect(passesMixMinRatings(song({ id: '2', artistUserRating: 2 }), enabledArtist2)).toBe(false);
    expect(passesMixMinRatings(song({ id: '3', artistUserRating: 3 }), enabledArtist2)).toBe(true);
  });

  it('keeps unrated artists (missing or zero)', () => {
    expect(passesMixMinRatings(song({ id: '1' }), enabledArtist2)).toBe(true);
    expect(passesMixMinRatings(song({ id: '2', artistUserRating: 0 }), enabledArtist2)).toBe(true);
  });

  it('uses playerStore userRatingOverrides before API fields', () => {
    usePlayerStore.getState().setUserRatingOverride('art-1', 1);
    expect(
      passesMixMinRatings(song({ id: '1', artistUserRating: 5 }), enabledArtist2),
    ).toBe(false);
  });

  it('uses OpenSubsonic artists[] ref when artistUserRating is absent', () => {
    const low = song({
      id: '1',
      artists: [{ id: 'art-1', userRating: 1 }],
    });
    expect(passesMixMinRatings(low, enabledArtist2)).toBe(false);
  });
});

describe('enrichSongsForMixRatingFilter', () => {
  it('prefetches entity artist rating even when song carries a misleading artists[] ref', async () => {
    vi.mocked(prefetchArtistUserRatings).mockResolvedValue(new Map([['art-1', 1]]));

    const input = [
      song({
        id: '1',
        artists: [{ id: 'art-1', userRating: 5 }],
      }),
    ];
    const out = await enrichSongsForMixRatingFilter(input, enabledArtist2);

    expect(prefetchArtistUserRatings).toHaveBeenCalledWith(['art-1']);
    expect(out[0].artistUserRating).toBe(1);
    expect(passesMixMinRatings(out[0], enabledArtist2)).toBe(false);
  });
});

describe('filterTopArtistsForMixRatings', () => {
  it('drops artists rated at or below the threshold', async () => {
    vi.mocked(prefetchArtistUserRatings).mockResolvedValue(
      new Map([
        ['a1', 1],
        ['a2', 3],
      ]),
    );

    const out = await filterTopArtistsForMixRatings(
      [
        { id: 'a1', name: 'Low' },
        { id: 'a2', name: 'Ok' },
        { id: 'a3', name: 'Unrated' },
      ],
      enabledArtist2,
    );

    expect(out.map(a => a.id)).toEqual(['a2', 'a3']);
  });
});
