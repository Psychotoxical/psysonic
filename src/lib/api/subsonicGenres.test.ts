import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllSongsByGenre, getSongsByGenre } from '@/lib/api/subsonicGenres';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('@/lib/api/subsonicClient', () => ({
  api: apiMock,
  libraryFilterParams: () => ({}),
}));

function songs(n: number, startId = 0): SubsonicSong[] {
  return Array.from({ length: n }, (_, i) => ({ id: String(startId + i), title: `t${startId + i}` }) as SubsonicSong);
}

describe('getSongsByGenre', () => {
  beforeEach(() => apiMock.mockReset());

  it('normalizes a single-song response into an array', async () => {
    apiMock.mockResolvedValue({ songsByGenre: { song: { id: '1', title: 'only' } } });
    expect(await getSongsByGenre('Metal')).toEqual([{ id: '1', title: 'only' }]);
  });

  it('returns an empty array when the genre has no songs', async () => {
    apiMock.mockResolvedValue({ songsByGenre: {} });
    expect(await getSongsByGenre('Empty')).toEqual([]);
  });
});

describe('fetchAllSongsByGenre', () => {
  beforeEach(() => apiMock.mockReset());

  it('paginates until a short page signals the end', async () => {
    apiMock
      .mockResolvedValueOnce({ songsByGenre: { song: songs(500) } })
      .mockResolvedValueOnce({ songsByGenre: { song: songs(30, 500) } });
    const all = await fetchAllSongsByGenre('Metal');
    expect(all).toHaveLength(530);
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(apiMock.mock.calls[0][1]).toMatchObject({ offset: 0, count: 500 });
    expect(apiMock.mock.calls[1][1]).toMatchObject({ offset: 500 });
  });

  it('stops at the cap without fetching further pages', async () => {
    apiMock.mockResolvedValue({ songsByGenre: { song: songs(500) } });
    const all = await fetchAllSongsByGenre('Huge', 10);
    expect(all).toHaveLength(10);
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
