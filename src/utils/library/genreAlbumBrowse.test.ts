import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGenreAlbumPage, fetchGenreAlbumTotal } from './genreAlbumBrowse';

vi.mock('../../api/library', () => ({
  libraryListAlbumsByGenre: vi.fn(),
}));

vi.mock('../../api/subsonicClient', () => ({
  libraryScopeForServer: vi.fn(() => 'lib-a'),
}));

vi.mock('./libraryReady', () => ({
  libraryIsReady: vi.fn(),
}));

import { libraryListAlbumsByGenre } from '../../api/library';
import { libraryIsReady } from './libraryReady';

describe('genreAlbumBrowse', () => {
  beforeEach(() => {
    vi.mocked(libraryIsReady).mockReset();
    vi.mocked(libraryListAlbumsByGenre).mockReset();
  });

  it('loads albums from the local genre browse command', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(true);
    vi.mocked(libraryListAlbumsByGenre).mockResolvedValue({
      source: 'local',
      hasMore: true,
      albums: [{
        serverId: 'srv-1',
        id: 'al-1',
        name: 'Album',
        artist: 'Artist',
        artistId: 'ar-1',
        songCount: 8,
        durationSec: 100,
        syncedAt: 0,
        rawJson: {},
      }],
    });

    const page = await fetchGenreAlbumPage('srv-1', 'Rock', true, 0, 200, 'alphabeticalByName');

    expect(libraryListAlbumsByGenre).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'srv-1',
      genre: 'Rock',
      libraryScope: 'lib-a',
      offset: 0,
      limit: 200,
    }));
    expect(page.albums).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('returns empty when the local index is unavailable', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(false);

    const page = await fetchGenreAlbumPage('srv-1', 'Rock', true, 0, 200, 'alphabeticalByName');

    expect(libraryListAlbumsByGenre).not.toHaveBeenCalled();
    expect(page).toEqual({ albums: [], hasMore: false });
  });

  it('reads album totals from the local genre browse command when needed', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(true);
    vi.mocked(libraryListAlbumsByGenre).mockResolvedValue({
      source: 'local',
      hasMore: false,
      total: 42,
      albums: [],
    });

    await expect(fetchGenreAlbumTotal('srv-1', 'Rock', true, 'alphabeticalByName')).resolves.toBe(42);
  });
});
