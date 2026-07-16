import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { getRandomSongs } from '@/lib/api/subsonicLibrary';
import { runLocalRandomSongs } from '@/lib/library/randomScopeReads';

vi.mock('@/lib/api/subsonicRatings', () => ({
  prefetchArtistUserRatings: vi.fn(async () => new Map()),
  prefetchAlbumUserRatings: vi.fn(async () => new Map()),
  parseSubsonicEntityStarRating: vi.fn(),
}));
vi.mock('@/lib/api/subsonicLibrary', () => ({ getRandomSongs: vi.fn() }));
vi.mock('@/lib/library/randomScopeReads', () => ({ runLocalRandomSongs: vi.fn() }));
vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: { getState: () => ({ userRatingOverrides: {} }) },
}));

import { fetchRandomMixSongsUntilFull } from './mixRatingFilter';

function song(id: string): SubsonicSong {
  return { id, title: id, artist: 'Artist', album: 'Album', albumId: 'album', duration: 180 };
}

beforeEach(() => {
  vi.mocked(getRandomSongs).mockReset();
  vi.mocked(runLocalRandomSongs).mockReset();
});

describe('fetchRandomMixSongsUntilFull browse scope', () => {
  it('uses the merged local index and never falls back to the active server', async () => {
    vi.mocked(runLocalRandomSongs).mockResolvedValue([song('scoped')]);
    const out = await fetchRandomMixSongsUntilFull(
      { enabled: false, minSong: 0, minAlbum: 0, minArtist: 0 },
      {
        targetSize: 1,
        localScope: {
          serverId: 'srv-1',
          pairs: [{ serverId: 'srv-2', libraryId: null }],
          multiServer: true,
        },
      },
    );
    expect(out.map(item => item.id)).toEqual(['scoped']);
    expect(runLocalRandomSongs).toHaveBeenCalledWith(
      'srv-1', 50, undefined, [{ serverId: 'srv-2', libraryId: null }],
    );
    expect(getRandomSongs).not.toHaveBeenCalled();
  });

  it('returns empty on a multi-server local miss instead of borrowing active-server random', async () => {
    vi.mocked(runLocalRandomSongs).mockResolvedValue(null);
    const out = await fetchRandomMixSongsUntilFull(
      { enabled: false, minSong: 0, minAlbum: 0, minArtist: 0 },
      {
        targetSize: 1,
        localScope: { serverId: 'srv-1', pairs: [], multiServer: true },
      },
    );
    expect(out).toEqual([]);
    expect(getRandomSongs).not.toHaveBeenCalled();
  });
});
