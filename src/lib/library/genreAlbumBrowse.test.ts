import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGenreAlbumPage, fetchGenreAlbumTotal } from './genreAlbumBrowse';

vi.mock('@/lib/api/library', () => ({
  libraryListAlbumsByGenre: vi.fn(),
}));

vi.mock('@/lib/api/subsonicGenres', () => ({
  getAlbumsByGenre: vi.fn(),
}));

vi.mock('@/lib/api/subsonicClient', () => ({
  libraryScopeForServer: vi.fn(() => 'lib-a'),
  libraryScopePairsForServer: vi.fn(() => [{ serverId: 'srv-1', libraryId: 'lib-a' }]),
}));

vi.mock('./libraryReady', () => ({
  readyLibraryServerKeys: vi.fn(),
}));

import { libraryListAlbumsByGenre } from '@/lib/api/library';
import { getAlbumsByGenre } from '@/lib/api/subsonicGenres';
import { readyLibraryServerKeys } from './libraryReady';

describe('genreAlbumBrowse', () => {
  beforeEach(() => {
    vi.mocked(readyLibraryServerKeys).mockReset();
    vi.mocked(libraryListAlbumsByGenre).mockReset();
    vi.mocked(getAlbumsByGenre).mockReset();
  });

  it('loads albums from the local genre browse command when the index is ready', async () => {
    vi.mocked(readyLibraryServerKeys).mockResolvedValue(['srv-1']);
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

    const page = await fetchGenreAlbumPage('srv-1', 'Rock', true, 0, 60, 'alphabeticalByName');

    expect(libraryListAlbumsByGenre).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'srv-1',
      genre: 'Rock',
      libraryScope: 'lib-a',
      libraryScopes: [{ serverId: 'srv-1', libraryId: 'lib-a' }],
      offset: 0,
      limit: 60,
    }));
    expect(getAlbumsByGenre).not.toHaveBeenCalled();
    expect(page.albums).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('joins identical in-flight local page reads', async () => {
    vi.mocked(readyLibraryServerKeys).mockResolvedValue(['srv-1']);
    vi.mocked(libraryListAlbumsByGenre).mockResolvedValue({
      source: 'local',
      hasMore: true,
      albums: [],
    });

    await Promise.all([
      fetchGenreAlbumPage('srv-1', 'Rock', true, 0, 60, 'alphabeticalByName'),
      fetchGenreAlbumPage('srv-1', 'Rock', true, 0, 60, 'alphabeticalByName'),
    ]);

    expect(libraryListAlbumsByGenre).toHaveBeenCalledTimes(1);
  });

  it('falls back to Subsonic byGenre when the local index is unavailable', async () => {
    vi.mocked(readyLibraryServerKeys).mockResolvedValue(null);
    vi.mocked(getAlbumsByGenre).mockResolvedValue([
      { id: 'al-1', name: 'A', artist: 'X', artistId: 'x', songCount: 1, duration: 1 },
    ]);

    const page = await fetchGenreAlbumPage('srv-1', 'Rock', true, 0, 60, 'alphabeticalByName');

    expect(libraryListAlbumsByGenre).not.toHaveBeenCalled();
    expect(getAlbumsByGenre).toHaveBeenCalledWith('Rock', 60, 0);
    expect(page.albums).toHaveLength(1);
  });

  it('uses Subsonic when the local index is disabled', async () => {
    vi.mocked(getAlbumsByGenre).mockResolvedValue([
      { id: 'al-1', name: 'A', artist: 'X', artistId: 'x', songCount: 1, duration: 1 },
    ]);

    const page = await fetchGenreAlbumPage('srv-1', 'Rock', false, 0, 60, 'alphabeticalByName');

    expect(readyLibraryServerKeys).not.toHaveBeenCalled();
    expect(getAlbumsByGenre).toHaveBeenCalledWith('Rock', 60, 0);
    expect(page.albums).toHaveLength(1);
  });

  it('reads album totals from the local genre browse command when needed', async () => {
    vi.mocked(readyLibraryServerKeys).mockResolvedValue(['srv-1']);
    vi.mocked(libraryListAlbumsByGenre).mockResolvedValue({
      source: 'local',
      hasMore: false,
      total: 42,
      albums: [],
    });

    await expect(fetchGenreAlbumTotal('srv-1', 'Rock', true, 'alphabeticalByName')).resolves.toBe(42);
    expect(libraryListAlbumsByGenre).toHaveBeenCalledWith(expect.objectContaining({
      includeTotal: true,
      countOnly: true,
    }));
  });

  it('uses the selected multi-server browse scope for pages and totals', async () => {
    vi.mocked(readyLibraryServerKeys).mockResolvedValue(['srv-2', 'srv-1']);
    vi.mocked(libraryListAlbumsByGenre).mockResolvedValue({
      source: 'local',
      hasMore: false,
      total: 84,
      albums: [],
    });
    const browseScope = {
      anchorServerId: 'srv-2',
      serverIds: ['srv-2', 'srv-1'],
      pairs: [
        { serverId: 'srv-2', libraryId: null },
        { serverId: 'srv-1', libraryId: 'lib-a' },
      ],
      fingerprint: 'scope',
      multiServer: true,
    };

    await fetchGenreAlbumPage(
      'srv-2',
      'Rock',
      true,
      0,
      60,
      'alphabeticalByName',
      browseScope,
    );
    await expect(fetchGenreAlbumTotal(
      'srv-2',
      'Rock',
      true,
      'alphabeticalByName',
      browseScope,
    )).resolves.toBe(84);

    expect(readyLibraryServerKeys).toHaveBeenCalledWith(['srv-2', 'srv-1']);
    expect(libraryListAlbumsByGenre).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'srv-2',
      libraryScope: undefined,
      libraryScopes: browseScope.pairs,
      countOnly: true,
    }));
  });
});
