import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  apiForServerMock,
  librarySelectionMock,
  uploadArtistImageMock,
  findServerMock,
  similarSongsRequestCountMock,
} = vi.hoisted(() => ({
  apiForServerMock: vi.fn(),
  librarySelectionMock: vi.fn<() => string[]>(() => []),
  uploadArtistImageMock: vi.fn(),
  findServerMock: vi.fn(),
  similarSongsRequestCountMock: vi.fn((count: number) => count),
}));

vi.mock('@/generated/bindings', () => ({
  commands: { uploadArtistImage: uploadArtistImageMock },
}));

vi.mock('@/lib/server/serverLookup', () => ({
  findServerByIdOrIndexKey: findServerMock,
}));

vi.mock('@/lib/server/serverEndpoint', () => ({
  connectBaseUrlForServer: (server: { url: string }) => server.url,
}));

vi.mock('@/lib/api/subsonicClient', () => ({
  api: vi.fn(),
  apiForServer: apiForServerMock,
  libraryFilterParams: () => ({}),
  libraryFilterParamsForServer: () => ({ musicFolderId: ['folder-a', 'folder-b'] }),
  librarySelectionForServer: librarySelectionMock,
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  filterSongsToActiveLibrary: async (songs: unknown[]) => songs,
  filterSongsToServerLibrary: async (songs: unknown[]) => songs,
  similarSongsRequestCount: similarSongsRequestCountMock,
}));

import {
  getArtistForServer,
  getArtistInfoForServer,
  getArtistsForServer,
  getSimilarSongsForServer,
  getSimilarSongs2ForServer,
  getTopSongsForServer,
  uploadArtistImageForServer,
} from '@/lib/api/subsonicArtists';

const artist = { id: 'artist-1', name: 'Artist' };
const album = { id: 'album-1', name: 'Album', artist: 'Artist', artistId: 'artist-1', songCount: 1, duration: 30 };

describe('explicit-server artist wrappers', () => {
  beforeEach(() => {
    apiForServerMock.mockReset();
    librarySelectionMock.mockReset();
    librarySelectionMock.mockReturnValue([]);
    uploadArtistImageMock.mockReset();
    findServerMock.mockReset();
    similarSongsRequestCountMock.mockClear();
  });

  it('preserves multi-folder fan-out, timeout, deduplication, and stamping', async () => {
    librarySelectionMock.mockReturnValue(['folder-a', 'folder-b']);
    apiForServerMock
      .mockResolvedValueOnce({ artists: { index: { artist: [artist] } } })
      .mockResolvedValueOnce({ artists: { index: { artist: [artist, { id: 'artist-2', name: 'Second' }] } } });

    await expect(getArtistsForServer('srv-artists', 3210)).resolves.toEqual([
      { ...artist, serverId: 'srv-artists' },
      { id: 'artist-2', name: 'Second', serverId: 'srv-artists' },
    ]);
    expect(apiForServerMock).toHaveBeenNthCalledWith(1, 'srv-artists', 'getArtists.view', { musicFolderId: 'folder-a' }, 3210);
    expect(apiForServerMock).toHaveBeenNthCalledWith(2, 'srv-artists', 'getArtists.view', { musicFolderId: 'folder-b' }, 3210);
  });

  it('uses an explicit browse selection instead of the global music selection', async () => {
    librarySelectionMock.mockReturnValue(['global-folder']);
    apiForServerMock.mockResolvedValue({ artists: { index: { artist: [artist] } } });

    await getArtistsForServer('srv-artists', 3210, ['browse-folder']);

    expect(apiForServerMock).toHaveBeenCalledWith(
      'srv-artists',
      'getArtists.view',
      { musicFolderId: 'browse-folder' },
      3210,
    );
  });

  it('forwards artist-detail timeout and stamps artist and albums', async () => {
    apiForServerMock.mockResolvedValue({ artist: { ...artist, album: [album] } });

    await expect(getArtistForServer('srv-detail', 'artist-1', { timeout: 4567 })).resolves.toEqual({
      artist: { ...artist, serverId: 'srv-detail' },
      albums: [{ ...album, serverId: 'srv-detail' }],
    });
    expect(apiForServerMock).toHaveBeenCalledWith(
      'srv-detail',
      'getArtist.view',
      expect.objectContaining({ id: 'artist-1' }),
      4567,
    );
  });

  it('merges artist-detail albums across explicit browse libraries', async () => {
    librarySelectionMock.mockReturnValue(['global-folder']);
    apiForServerMock
      .mockResolvedValueOnce({ artist: { ...artist, album: [album] } })
      .mockResolvedValueOnce({ artist: { ...artist, album: [{ ...album, id: 'album-2' }] } });

    await expect(getArtistForServer('srv-detail', 'artist-1', {
      timeout: 4567,
      libraryIds: ['browse-a', 'browse-b'],
    })).resolves.toEqual({
      artist: { ...artist, serverId: 'srv-detail' },
      albums: [
        { ...album, serverId: 'srv-detail' },
        { ...album, id: 'album-2', serverId: 'srv-detail' },
      ],
    });
    expect(apiForServerMock).toHaveBeenNthCalledWith(
      1, 'srv-detail', 'getArtist.view', { id: 'artist-1', musicFolderId: 'browse-a' }, 4567,
    );
    expect(apiForServerMock).toHaveBeenNthCalledWith(
      2, 'srv-detail', 'getArtist.view', { id: 'artist-1', musicFolderId: 'browse-b' }, 4567,
    );
  });

  it('forwards artist-info timeout and stamps similar artists at runtime', async () => {
    apiForServerMock.mockResolvedValue({
      artistInfo2: { biography: 'Bio', similarArtist: [{ id: 'similar-1', name: 'Similar' }] },
    });

    const info = await getArtistInfoForServer('srv-info', 'artist-1', { similarArtistCount: 9, timeout: 5678 });
    expect(info).toEqual({
      biography: 'Bio',
      similarArtist: [{ id: 'similar-1', name: 'Similar', serverId: 'srv-info' }],
    });
    expect(apiForServerMock).toHaveBeenCalledWith(
      'srv-info',
      'getArtistInfo2.view',
      expect.objectContaining({ id: 'artist-1', count: 9 }),
      5678,
    );
  });

  it('loads a bounded Top Songs candidate set for one explicit server', async () => {
    apiForServerMock.mockResolvedValue({
      topSongs: {
        song: [
          { id: 'top-1', title: 'First' },
          { id: 'top-2', title: 'Second' },
        ],
      },
    });

    const songs = await getTopSongsForServer('srv-top', 'Artist', {
      requestCount: 20,
      limit: 20,
      timeout: 4321,
      libraryIds: ['lib-a'],
      filterToLibrary: false,
    });

    expect(apiForServerMock).toHaveBeenCalledWith(
      'srv-top',
      'getTopSongs.view',
      { artist: 'Artist', count: 20, musicFolderId: ['lib-a'] },
      4321,
    );
    expect(songs).toEqual([
      { id: 'top-1', title: 'First', serverId: 'srv-top' },
      { id: 'top-2', title: 'Second', serverId: 'srv-top' },
    ]);
  });

  it('loads and stamps similar songs for one explicit server', async () => {
    apiForServerMock.mockResolvedValue({
      similarSongs2: { song: [{ id: 'similar-1', title: 'Similar' }] },
    });

    await expect(getSimilarSongs2ForServer('srv-similar', 'seed', 12)).resolves.toEqual([
      { id: 'similar-1', title: 'Similar', serverId: 'srv-similar' },
    ]);
    expect(apiForServerMock).toHaveBeenCalledWith(
      'srv-similar',
      'getSimilarSongs2.view',
      expect.objectContaining({ id: 'seed', count: 12 }),
    );
    expect(similarSongsRequestCountMock).toHaveBeenCalledWith(12, 'srv-similar');
  });

  it('routes legacy similar songs through the explicit owner scope', async () => {
    apiForServerMock.mockResolvedValue({
      similarSongs: { song: { id: 'similar-legacy', title: 'Similar' } },
    });

    await expect(getSimilarSongsForServer('srv-legacy', 'seed', 7)).resolves.toEqual([
      { id: 'similar-legacy', title: 'Similar', serverId: 'srv-legacy' },
    ]);
    expect(similarSongsRequestCountMock).toHaveBeenCalledWith(7, 'srv-legacy');
    expect(apiForServerMock).toHaveBeenCalledWith(
      'srv-legacy',
      'getSimilarSongs.view',
      expect.objectContaining({ id: 'seed', count: 7 }),
    );
  });

  it('uploads an artist image with the explicit server credentials', async () => {
    findServerMock.mockReturnValue({
      id: 'srv-owner',
      url: 'https://owner.test',
      username: 'owner-user',
      password: 'owner-pass',
    });
    uploadArtistImageMock.mockResolvedValue({ status: 'ok', data: null });
    const file = {
      type: 'image/png',
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as File;

    await uploadArtistImageForServer('srv-owner', 'artist-1', file);

    expect(findServerMock).toHaveBeenCalledWith('srv-owner');
    expect(uploadArtistImageMock).toHaveBeenCalledWith(
      'https://owner.test',
      'artist-1',
      'owner-user',
      'owner-pass',
      [1, 2, 3],
      'image/png',
    );
  });
});
