import { beforeEach, describe, expect, it, vi } from 'vitest';

const libraryListRandomArtists = vi.fn();
const libraryAdvancedSearch = vi.fn();
const librarySelectionForServer = vi.fn();
const libraryIsReady = vi.fn();
const waitForLibraryBrowseReady = vi.fn();

vi.mock('@/lib/api/library', () => ({
  libraryListRandomArtists: (...args: unknown[]) => libraryListRandomArtists(...args),
  libraryAdvancedSearch: (...args: unknown[]) => libraryAdvancedSearch(...args),
}));
vi.mock('@/lib/api/subsonicClient', () => ({
  libraryScopeForServer: vi.fn(),
  libraryScopePairsForServer: vi.fn(),
  librarySelectionForServer: (...args: unknown[]) => librarySelectionForServer(...args),
}));
vi.mock('./libraryReady', () => ({
  libraryIsReady: (...args: unknown[]) => libraryIsReady(...args),
  waitForLibraryBrowseReady: (...args: unknown[]) => waitForLibraryBrowseReady(...args),
}));

import {
  browseRaceCountsArtists,
  fetchLocalArtistCatalogChunk,
  filterBrowseArtistsByNameQuery,
  raceBrowseWithLocalFallback,
  runLocalRandomArtists,
  runLocalRandomSongs,
} from './browseTextSearch';

describe('filterBrowseArtistsByNameQuery', () => {
  it('matches Cyrillic names regardless of query case', () => {
    const artists = [{ id: '1', name: 'Кино' }];
    expect(filterBrowseArtistsByNameQuery(artists, 'кин')).toHaveLength(1);
    expect(filterBrowseArtistsByNameQuery(artists, 'КИН')).toHaveLength(1);
  });
});

describe('fetchLocalArtistCatalogChunk', () => {
  beforeEach(() => {
    libraryAdvancedSearch.mockReset();
    waitForLibraryBrowseReady.mockReset();
  });

  it('forwards authoritative cross-server scopes without a legacy single-server scope', async () => {
    waitForLibraryBrowseReady.mockResolvedValue({ ready: true, waitedMs: 0 });
    libraryAdvancedSearch.mockResolvedValue({
      source: 'local',
      artists: [{ serverId: 'server-b', id: 'artist-b', name: 'Only on B', rawJson: {} }],
    });
    const scopes = [
      { serverId: 'server-a', libraryId: 'library-a' },
      { serverId: 'server-b', libraryId: 'library-b' },
    ];

    await expect(fetchLocalArtistCatalogChunk(
      'server-a',
      0,
      200,
      'album',
      undefined,
      { libraryScopes: scopes },
    )).resolves.toEqual({
      artists: [expect.objectContaining({ serverId: 'server-b', id: 'artist-b' })],
      hasMore: false,
    });

    expect(libraryAdvancedSearch).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'server-a',
      libraryScope: undefined,
      libraryScopes: scopes,
      entityTypes: ['artist'],
    }));
  });
});

describe('raceBrowseWithLocalFallback', () => {
  it('returns local when network throws and local has data', async () => {
    const outcome = await raceBrowseWithLocalFallback(
      () => false,
      async () => [{ id: 'a1', name: 'Local Artist' }],
      async () => {
        throw new Error('server down');
      },
      {
        surface: 'artists_browse',
        query: 'test',
        counts: browseRaceCountsArtists,
      },
    );
    expect(outcome?.source).toBe('local');
    expect(outcome?.result).toHaveLength(1);
  });

  it('falls back to local after race when network was faster but returned null', async () => {
    let localCalls = 0;
    const outcome = await raceBrowseWithLocalFallback(
      () => false,
      async () => {
        localCalls += 1;
        return localCalls >= 2 ? ['hit'] : null;
      },
      async () => null,
    );
    expect(outcome?.source).toBe('local');
    expect(outcome?.result).toEqual(['hit']);
  });

  it('returns network when local is unavailable', async () => {
    const outcome = await raceBrowseWithLocalFallback(
      () => false,
      async () => null,
      async () => ['network'],
    );
    expect(outcome?.source).toBe('network');
    expect(outcome?.result).toEqual(['network']);
  });
});

describe('runLocalRandomArtists', () => {
  beforeEach(() => {
    libraryListRandomArtists.mockReset();
    librarySelectionForServer.mockReset();
    libraryIsReady.mockReset();
  });

  it('uses the local command for a ready whole-library server', async () => {
    librarySelectionForServer.mockReturnValue([]);
    libraryIsReady.mockResolvedValue(true);
    libraryListRandomArtists.mockResolvedValue([
      { serverId: 'server-a', id: 'artist-a', name: 'Artist A', syncedAt: 1, rawJson: {} },
    ]);

    await expect(runLocalRandomArtists('server-a', 16)).resolves.toEqual([
      expect.objectContaining({ serverId: 'server-a', id: 'artist-a', name: 'Artist A' }),
    ]);
    expect(libraryListRandomArtists).toHaveBeenCalledWith('server-a', 16);
  });

  it('keeps scoped selections on the network path', async () => {
    librarySelectionForServer.mockReturnValue(['library-a']);

    await expect(runLocalRandomArtists('server-a', 16)).resolves.toBeNull();
    expect(libraryIsReady).not.toHaveBeenCalled();
    expect(libraryListRandomArtists).not.toHaveBeenCalled();
  });

  it('uses explicit browse scopes for local random artists', async () => {
    libraryIsReady.mockResolvedValue(true);
    libraryAdvancedSearch.mockResolvedValue({
      source: 'local',
      artists: [{ serverId: 'server-a', id: 'artist-a', name: 'Artist A', rawJson: {} }],
    });
    const scopes = [{ serverId: 'server-a', libraryId: 'library-a' }];

    await expect(runLocalRandomArtists('server-a', 16, scopes)).resolves.toEqual([
      expect.objectContaining({ serverId: 'server-a', id: 'artist-a' }),
    ]);
    expect(libraryAdvancedSearch).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'server-a',
      libraryScope: 'library-a',
      libraryScopes: scopes,
      entityTypes: ['artist'],
      sort: [{ field: 'random', dir: 'asc' }],
    }));
    expect(libraryListRandomArtists).not.toHaveBeenCalled();
  });
});

describe('runLocalRandomSongs', () => {
  beforeEach(() => {
    libraryAdvancedSearch.mockReset();
    libraryIsReady.mockReset();
  });

  it('uses explicit browse scopes instead of the global music selection', async () => {
    libraryIsReady.mockResolvedValue(true);
    libraryAdvancedSearch.mockResolvedValue({
      source: 'local',
      tracks: [{
        serverId: 'server-a', id: 'song-a', title: 'Song', artist: 'Artist', album: 'Album', rawJson: {},
      }],
    });
    const scopes = [{ serverId: 'server-a', libraryId: 'library-a' }];

    await expect(runLocalRandomSongs('server-a', 18, scopes)).resolves.toEqual([
      expect.objectContaining({ serverId: 'server-a', id: 'song-a' }),
    ]);
    expect(libraryAdvancedSearch).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'server-a',
      libraryScope: 'library-a',
      libraryScopes: scopes,
      entityTypes: ['track'],
    }));
  });
});
