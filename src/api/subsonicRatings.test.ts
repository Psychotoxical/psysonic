import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./subsonicArtists', () => ({ getArtist: vi.fn() }));
vi.mock('./subsonicLibrary', () => ({ getAlbum: vi.fn() }));

import { getArtist } from './subsonicArtists';
import { invalidateEntityUserRatingCaches, prefetchArtistUserRatings } from './subsonicRatings';

beforeEach(() => {
  vi.mocked(getArtist).mockReset();
  invalidateEntityUserRatingCaches('art-1');
});

describe('prefetchArtistUserRatings cache', () => {
  it('does not negative-cache unrated artists', async () => {
    vi.mocked(getArtist).mockResolvedValue({ artist: { id: 'art-1', name: 'Artist' }, albums: [] });

    const first = await prefetchArtistUserRatings(['art-1']);
    expect(first.size).toBe(0);
    expect(getArtist).toHaveBeenCalledTimes(1);

    vi.mocked(getArtist).mockResolvedValue({
      artist: { id: 'art-1', name: 'Artist', userRating: 1 },
      albums: [],
    });
    const second = await prefetchArtistUserRatings(['art-1']);
    expect(second.get('art-1')).toBe(1);
    expect(getArtist).toHaveBeenCalledTimes(2);
  });

  it('re-fetches after invalidateEntityUserRatingCaches', async () => {
    vi.mocked(getArtist).mockResolvedValue({
      artist: { id: 'art-1', name: 'Artist', userRating: 2 },
      albums: [],
    });

    const first = await prefetchArtistUserRatings(['art-1']);
    expect(first.get('art-1')).toBe(2);
    expect(getArtist).toHaveBeenCalledTimes(1);

    vi.mocked(getArtist).mockResolvedValue({
      artist: { id: 'art-1', name: 'Artist', userRating: 4 },
      albums: [],
    });
    const cached = await prefetchArtistUserRatings(['art-1']);
    expect(cached.get('art-1')).toBe(2);
    expect(getArtist).toHaveBeenCalledTimes(1);

    invalidateEntityUserRatingCaches('art-1');
    const fresh = await prefetchArtistUserRatings(['art-1']);
    expect(fresh.get('art-1')).toBe(4);
    expect(getArtist).toHaveBeenCalledTimes(2);
  });
});
