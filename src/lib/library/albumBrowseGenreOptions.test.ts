import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlbumBrowseQuery } from './albumBrowseTypes';

const libraryGetGenreAlbumCounts = vi.fn();
const libraryIsReady = vi.fn();
const libraryScopeForServer = vi.fn();
const librarySelectionForServer = vi.fn();
const runLocalAlbumBrowse = vi.fn();

vi.mock('@/lib/api/library', () => ({
  libraryGetGenreAlbumCounts: (...args: unknown[]) => libraryGetGenreAlbumCounts(...args),
}));

vi.mock('./libraryReady', () => ({
  libraryIsReady: (...args: unknown[]) => libraryIsReady(...args),
}));

vi.mock('@/lib/api/subsonicClient', () => ({
  libraryScopeForServer: (...args: unknown[]) => libraryScopeForServer(...args),
  librarySelectionForServer: (...args: unknown[]) => librarySelectionForServer(...args),
}));

vi.mock('./albumBrowseLocal', () => ({
  runLocalAlbumBrowse: (...args: unknown[]) => runLocalAlbumBrowse(...args),
}));

import { fetchAlbumBrowseGenreOptions } from './albumBrowseLoad';

const baseQuery: AlbumBrowseQuery = {
  sort: 'alphabeticalByName',
  genres: [],
  losslessOnly: false,
  starredOnly: false,
  compFilter: 'all',
};

beforeEach(() => {
  vi.clearAllMocks();
  libraryIsReady.mockResolvedValue(true);
  libraryScopeForServer.mockReturnValue('lib-a');
  librarySelectionForServer.mockReturnValue(['lib-a']);
});

describe('fetchAlbumBrowseGenreOptions', () => {
  it('uses scoped local genre counts when only the sidebar library is narrowed', async () => {
    libraryGetGenreAlbumCounts.mockResolvedValue([
      { value: 'Rock', albumCount: 12, songCount: 40 },
      { value: 'Jazz', albumCount: 3, songCount: 9 },
    ]);

    await expect(fetchAlbumBrowseGenreOptions('srv-1', true, baseQuery)).resolves.toEqual([
      { genre: 'Rock', count: 12 },
      { genre: 'Jazz', count: 3 },
    ]);

    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({
      serverId: 'srv-1',
      libraryScope: 'lib-a',
    });
    expect(runLocalAlbumBrowse).not.toHaveBeenCalled();
  });

  it('merges per-library genre counts for a multi-library selection', async () => {
    librarySelectionForServer.mockReturnValue(['lib-a', 'lib-b']);
    libraryGetGenreAlbumCounts
      .mockResolvedValueOnce([
        { value: 'Rock', albumCount: 10, songCount: 30 },
        { value: 'Jazz', albumCount: 2, songCount: 6 },
      ])
      .mockResolvedValueOnce([
        { value: 'Rock', albumCount: 5, songCount: 15 },
        { value: 'Pop', albumCount: 4, songCount: 12 },
      ]);

    await expect(fetchAlbumBrowseGenreOptions('srv-1', true, baseQuery)).resolves.toEqual([
      { genre: 'Rock', count: 15 },
      { genre: 'Pop', count: 4 },
      { genre: 'Jazz', count: 2 },
    ]);

    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledTimes(2);
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({ serverId: 'srv-1', libraryScope: 'lib-a' });
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({ serverId: 'srv-1', libraryScope: 'lib-b' });
    expect(runLocalAlbumBrowse).not.toHaveBeenCalled();
  });

  it('derives genres from filtered albums when combined filters are active', async () => {
    runLocalAlbumBrowse.mockResolvedValue({
      albums: [
        { id: '1', name: 'A', artist: 'X', artistId: 'x', songCount: 1, duration: 1, genre: 'Rock' },
        { id: '2', name: 'B', artist: 'Y', artistId: 'y', songCount: 1, duration: 1, genre: 'Jazz' },
      ],
      hasMore: false,
    });

    await expect(
      fetchAlbumBrowseGenreOptions('srv-1', true, { ...baseQuery, year: { from: 1990 } }),
    ).resolves.toEqual([
      { genre: 'Jazz', count: 1 },
      { genre: 'Rock', count: 1 },
    ]);

    expect(libraryGetGenreAlbumCounts).not.toHaveBeenCalled();
    expect(runLocalAlbumBrowse).toHaveBeenCalled();
  });
});
