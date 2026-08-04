import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlbumBrowseQuery } from './albumBrowseTypes';

const libraryGetGenreAlbumCounts = vi.fn();
const readyLibraryServerKeys = vi.fn();
const libraryScopeForServer = vi.fn();
const librarySelectionForServer = vi.fn();
const runLocalAlbumBrowse = vi.fn();

vi.mock('@/lib/api/library', () => ({
  libraryGetGenreAlbumCounts: (...args: unknown[]) => libraryGetGenreAlbumCounts(...args),
}));

vi.mock('./libraryReady', () => ({
  readyLibraryServerKeys: (...args: unknown[]) => readyLibraryServerKeys(...args),
}));

const getLibraryBrowseScope = vi.fn();

vi.mock('./libraryBrowseScope', async importOriginal => ({
  ...(await importOriginal<typeof import('./libraryBrowseScope')>()),
  getLibraryBrowseScope: () => getLibraryBrowseScope(),
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
  readyLibraryServerKeys.mockResolvedValue(['srv-1']);
  libraryScopeForServer.mockReturnValue('lib-a');
  librarySelectionForServer.mockReturnValue(['lib-a']);
  getLibraryBrowseScope.mockReturnValue({
    anchorServerId: 'srv-1',
    serverIds: [],
    pairs: [],
    fingerprint: '',
    multiServer: false,
  });
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

  it('uses unscoped SQL for all libraries instead of an album sample', async () => {
    librarySelectionForServer.mockReturnValue([]);
    libraryGetGenreAlbumCounts.mockResolvedValue([
      { value: 'Ambient', albumCount: 3, songCount: 12 },
      { value: 'Rock', albumCount: 42, songCount: 900 },
    ]);

    await expect(fetchAlbumBrowseGenreOptions('srv-1', true, baseQuery)).resolves.toEqual([
      { genre: 'Ambient', count: 3 },
      { genre: 'Rock', count: 42 },
    ]);

    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({ serverId: 'srv-1' });
    expect(runLocalAlbumBrowse).not.toHaveBeenCalled();
  });

  it('uses one scoped SQL query for a multi-library selection', async () => {
    librarySelectionForServer.mockReturnValue(['lib-a', 'lib-b']);
    libraryGetGenreAlbumCounts.mockResolvedValue([
      { value: 'Rock', albumCount: 15, songCount: 45 },
      { value: 'Pop', albumCount: 4, songCount: 12 },
      { value: 'Jazz', albumCount: 2, songCount: 6 },
    ]);

    await expect(fetchAlbumBrowseGenreOptions('srv-1', true, baseQuery)).resolves.toEqual([
      { genre: 'Rock', count: 15 },
      { genre: 'Pop', count: 4 },
      { genre: 'Jazz', count: 2 },
    ]);

    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledTimes(1);
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({
      serverId: 'srv-1',
      libraryScopes: ['lib-a', 'lib-b'],
    });
    expect(runLocalAlbumBrowse).not.toHaveBeenCalled();
  });

  it('merges genre counts from every server in the album browse scope', async () => {
    readyLibraryServerKeys.mockResolvedValue(['srv-1', 'srv-2']);
    getLibraryBrowseScope.mockReturnValue({
      anchorServerId: 'srv-1',
      serverIds: ['srv-1', 'srv-2'],
      pairs: [
        { serverId: 'srv-1', libraryId: 'lib-a' },
        { serverId: 'srv-2', libraryId: null },
      ],
      fingerprint: 'scope',
      multiServer: true,
    });
    libraryGetGenreAlbumCounts.mockImplementation(async (args: { serverId: string }) =>
      args.serverId === 'srv-1'
        ? [{ value: 'Rock', albumCount: 2, songCount: 5 }]
        : [
            { value: 'rock', albumCount: 3, songCount: 7 },
            { value: 'Jazz', albumCount: 1, songCount: 2 },
          ]);

    await expect(fetchAlbumBrowseGenreOptions('srv-1', true, baseQuery)).resolves.toEqual([
      { genre: 'Rock', count: 5 },
      { genre: 'Jazz', count: 1 },
    ]);
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({
      serverId: 'srv-1',
      libraryScope: 'lib-a',
    });
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({ serverId: 'srv-2' });
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
