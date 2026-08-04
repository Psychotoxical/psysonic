import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGenreAlbumCount,
  fetchGenreCatalog,
  fetchScopedGenreCatalog,
  fetchGenreTracksForPlayback,
  fetchLocalGenreTracksForPlayback,
  filterGenresWithContent,
  GENRE_PLAYBACK_QUEUE_CAP,
  lookupScopedGenreAlbumCount,
} from './genreBrowsePlayback';

vi.mock('@/lib/api/library', () => ({
  libraryAdvancedSearch: vi.fn(),
  libraryGetGenreAlbumCounts: vi.fn(),
}));

vi.mock('@/lib/api/subsonicGenres', () => ({
  fetchAllSongsByGenre: vi.fn(),
  getGenres: vi.fn(),
}));

vi.mock('@/lib/api/subsonicClient', () => ({
  libraryScopeForServer: vi.fn(() => 'music'),
  libraryScopePairsForServer: vi.fn(() => [{ serverId: 'srv-1', libraryId: 'music' }]),
  libraryScopeCacheKeyForServer: vi.fn(() => 'music'),
  librarySelectionForServer: vi.fn(() => ['music']),
}));

vi.mock('@/lib/library/libraryReady', () => ({
  libraryIsReady: vi.fn(),
}));

const isOfflineBrowseActiveMock = vi.fn(() => false);
const offlineLocalBrowseEnabledMock = vi.fn((_serverId?: string) => false);
const fetchOfflineLocalGenreCatalogMock = vi.fn(async (_serverId?: string) => [
  { value: 'CachedLocal', albumCount: 2, songCount: 0 },
]);

vi.mock('@/features/offline', () => ({
  isOfflineBrowseActive: () => isOfflineBrowseActiveMock(),
  offlineLocalBrowseEnabled: (serverId: string) => offlineLocalBrowseEnabledMock(serverId),
  fetchOfflineLocalGenreCatalog: (serverId: string) => fetchOfflineLocalGenreCatalogMock(serverId),
}));

// Spread the real leaf module so other consumers pulled in transitively (the
// album barrel reaches this via the artist↔album edge → useGenreAlbumBrowse needs
// GENRE_ALBUM_FIRST_PAGE); only fetchGenreAlbumTotal is stubbed here.
vi.mock('@/lib/library/genreAlbumBrowse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/library/genreAlbumBrowse')>()),
  fetchGenreAlbumTotal: vi.fn(),
}));

import { libraryAdvancedSearch, libraryGetGenreAlbumCounts } from '@/lib/api/library';
import { fetchAllSongsByGenre, getGenres } from '@/lib/api/subsonicGenres';
import { fetchGenreAlbumTotal } from '@/lib/library/genreAlbumBrowse';
import { resetGenreCatalogCountsCacheForTests } from '@/lib/library/genreCatalogCountsCache';
import { libraryIsReady } from '@/lib/library/libraryReady';

describe('genreBrowsePlayback', () => {
  beforeEach(() => {
    resetGenreCatalogCountsCacheForTests();
    isOfflineBrowseActiveMock.mockReturnValue(false);
    offlineLocalBrowseEnabledMock.mockReturnValue(false);
    fetchOfflineLocalGenreCatalogMock.mockClear();
    vi.mocked(libraryIsReady).mockReset();
    vi.mocked(libraryAdvancedSearch).mockReset();
    vi.mocked(libraryGetGenreAlbumCounts).mockReset();
    vi.mocked(fetchAllSongsByGenre).mockReset();
    vi.mocked(getGenres).mockReset();
    vi.mocked(fetchGenreAlbumTotal).mockReset();
  });

  it('requests random local tracks for shuffle', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(true);
    vi.mocked(libraryAdvancedSearch).mockResolvedValue({
      source: 'local',
      tracks: [{
        serverId: 'srv-1',
        id: 't1',
        title: 'A',
        artist: 'X',
        album: 'B',
        albumId: 'a1',
        durationSec: 1,
        coverArtId: 'c1',
        syncedAt: 0,
        rawJson: {},
      }],
      albums: [],
      artists: [],
      totals: { tracks: 1, albums: 1, artists: 1 },
      appliedFilters: ['genre'],
    });

    await fetchLocalGenreTracksForPlayback('srv-1', 'Rock', { shuffle: true, cap: 100 });

    expect(libraryAdvancedSearch).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'srv-1',
      entityTypes: ['track'],
      filters: [{ field: 'genre', op: 'eq', value: 'Rock' }],
      sort: [{ field: 'random', dir: 'asc' }],
      limit: 100,
      skipTotals: true,
      libraryScopes: [{ serverId: 'srv-1', libraryId: 'music' }],
    }));
  });

  it('falls back to Navidrome when local index is unavailable', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(false);
    vi.mocked(fetchAllSongsByGenre).mockResolvedValue([
      { id: 's1', title: 'Song', artist: 'A', album: 'B', albumId: 'a1', duration: 200, coverArt: 'c1' },
    ]);

    const tracks = await fetchGenreTracksForPlayback('srv-1', 'Jazz', { shuffle: false, indexEnabled: true });

    expect(fetchAllSongsByGenre).toHaveBeenCalledWith('Jazz', GENRE_PLAYBACK_QUEUE_CAP);
    expect(tracks).toHaveLength(1);
  });

  it('reads album totals from cached genre catalog', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(true);
    vi.mocked(libraryGetGenreAlbumCounts).mockResolvedValue([
      { value: 'Rock', albumCount: 42, songCount: 900 },
    ]);
    await fetchGenreCatalog('srv-1', true);

    await expect(fetchGenreAlbumCount('srv-1', 'Rock', true)).resolves.toBe(42);
    expect(fetchGenreAlbumTotal).not.toHaveBeenCalled();
    expect(getGenres).not.toHaveBeenCalled();
  });

  it('falls back to per-genre total when catalog cache is empty', async () => {
    vi.mocked(fetchGenreAlbumTotal).mockResolvedValue(42);

    await expect(fetchGenreAlbumCount('srv-1', 'Rock', true)).resolves.toBe(42);
  });

  it('uses the exact merged total instead of an active-server cache for multi-server browse', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(true);
    vi.mocked(libraryGetGenreAlbumCounts).mockResolvedValue([
      { value: 'Rock', albumCount: 42, songCount: 900 },
    ]);
    await fetchGenreCatalog('srv-1', true);
    vi.mocked(fetchGenreAlbumTotal).mockResolvedValue(84);
    const browseScope = {
      anchorServerId: 'srv-1',
      serverIds: ['srv-1', 'srv-2'],
      pairs: [
        { serverId: 'srv-1', libraryId: 'music' },
        { serverId: 'srv-2', libraryId: null },
      ],
      fingerprint: 'scope',
      multiServer: true,
    };

    await expect(fetchGenreAlbumCount(
      'srv-1',
      'Rock',
      true,
      'alphabeticalByName',
      browseScope,
    )).resolves.toBe(84);
    expect(fetchGenreAlbumTotal).toHaveBeenCalledWith(
      'srv-1',
      'Rock',
      true,
      'alphabeticalByName',
      browseScope,
    );
  });

  it('falls back to scoped genre list album count when local index is off', async () => {
    vi.mocked(fetchGenreAlbumTotal).mockResolvedValue(null);
    vi.mocked(getGenres).mockResolvedValue([
      { value: 'Rock', songCount: 100, albumCount: 7 },
    ]);

    await expect(fetchGenreAlbumCount('srv-1', 'Rock', false)).resolves.toBe(7);
  });

  it('loads genre cloud from local index when ready', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(true);
    vi.mocked(libraryGetGenreAlbumCounts).mockResolvedValue([
      { value: 'Rock', albumCount: 42, songCount: 900 },
    ]);

    await expect(fetchGenreCatalog('srv-1', true)).resolves.toEqual([
      { value: 'Rock', albumCount: 42, songCount: 900 },
    ]);
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({
      serverId: 'srv-1',
      libraryScope: 'music',
    });
    expect(getGenres).not.toHaveBeenCalled();
  });

  it('loads all-libraries genre cloud via unscoped SQL, not an album sample', async () => {
    const { librarySelectionForServer } = await import('@/lib/api/subsonicClient');
    vi.mocked(librarySelectionForServer).mockReturnValue([]);
    vi.mocked(libraryIsReady).mockResolvedValue(true);
    vi.mocked(libraryGetGenreAlbumCounts).mockResolvedValue([
      { value: 'Ambient', albumCount: 3, songCount: 12 },
      { value: 'Rock', albumCount: 42, songCount: 900 },
    ]);

    await expect(fetchGenreCatalog('srv-1', true)).resolves.toEqual([
      { value: 'Ambient', albumCount: 3, songCount: 12 },
      { value: 'Rock', albumCount: 42, songCount: 900 },
    ]);
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({ serverId: 'srv-1' });
    expect(getGenres).not.toHaveBeenCalled();
  });

  it('loads multi-library genre cloud via scoped SQL IN query', async () => {
    const { librarySelectionForServer } = await import('@/lib/api/subsonicClient');
    vi.mocked(librarySelectionForServer).mockReturnValue(['lib-a', 'lib-b']);
    vi.mocked(libraryIsReady).mockResolvedValue(true);
    vi.mocked(libraryGetGenreAlbumCounts).mockResolvedValue([
      { value: 'Pop', albumCount: 4, songCount: 12 },
      { value: 'Rock', albumCount: 15, songCount: 45 },
    ]);

    await expect(fetchGenreCatalog('srv-1', true)).resolves.toEqual([
      { value: 'Pop', albumCount: 4, songCount: 12 },
      { value: 'Rock', albumCount: 15, songCount: 45 },
    ]);
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({
      serverId: 'srv-1',
      libraryScopes: ['lib-a', 'lib-b'],
    });
  });

  it('aggregates selected server scopes with one local count query per server', async () => {
    vi.mocked(libraryGetGenreAlbumCounts).mockImplementation(async args => {
      const request = args as { serverId: string };
      return request.serverId === 'srv-a'
        ? [{ value: 'Rock', albumCount: 2, songCount: 5 }]
        : [
            { value: 'rock', albumCount: 3, songCount: 7 },
            { value: 'Jazz', albumCount: 1, songCount: 2 },
          ];
    });

    const scopes = [
      { serverId: 'srv-a', libraryIds: ['lib-a'] },
      { serverId: 'srv-b', libraryIds: [] },
    ];
    await expect(fetchScopedGenreCatalog(scopes)).resolves.toEqual([
      { value: 'Rock', albumCount: 5, songCount: 12 },
      { value: 'Jazz', albumCount: 1, songCount: 2 },
    ]);
    await fetchScopedGenreCatalog(scopes);

    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledTimes(2);
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({
      serverId: 'srv-a',
      libraryScope: 'lib-a',
    });
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledWith({ serverId: 'srv-b' });
    expect(getGenres).not.toHaveBeenCalled();
  });

  it('uses the scoped catalog provisionally but fetches an exact multi-server total', async () => {
    vi.mocked(libraryGetGenreAlbumCounts).mockImplementation(async args => {
      const request = args as { serverId: string };
      return request.serverId === 'srv-a'
        ? [{ value: 'Rock', albumCount: 2, songCount: 5 }]
        : [{ value: 'rock', albumCount: 3, songCount: 7 }];
    });
    const browseScope = {
      anchorServerId: 'srv-a',
      serverIds: ['srv-a', 'srv-b'],
      pairs: [
        { serverId: 'srv-a', libraryId: 'lib-a' },
        { serverId: 'srv-b', libraryId: null },
      ],
      fingerprint: 'scope',
      multiServer: true,
    };

    await fetchScopedGenreCatalog([
      { serverId: 'srv-a', libraryIds: ['lib-a'] },
      { serverId: 'srv-b', libraryIds: [] },
    ]);

    expect(lookupScopedGenreAlbumCount(browseScope, 'ROCK')).toBe(5);
    vi.mocked(fetchGenreAlbumTotal).mockResolvedValue(99);
    await expect(fetchGenreAlbumCount(
      'srv-a',
      'Rock',
      true,
      'alphabeticalByName',
      browseScope,
    )).resolves.toBe(99);
    expect(fetchGenreAlbumTotal).toHaveBeenCalledWith(
      'srv-a',
      'Rock',
      true,
      'alphabeticalByName',
      browseScope,
    );
  });

  it('retains successful local genre counts when another selected index fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(libraryGetGenreAlbumCounts).mockImplementation(async args => {
      const request = args as { serverId: string };
      if (request.serverId === 'srv-b') throw new Error('index unavailable');
      return [{ value: 'Ambient', albumCount: 4, songCount: 9 }];
    });

    await expect(fetchScopedGenreCatalog([
      { serverId: 'srv-a', libraryIds: [] },
      { serverId: 'srv-b', libraryIds: [] },
    ])).resolves.toEqual([
      { value: 'Ambient', albumCount: 4, songCount: 9 },
    ]);
    expect(getGenres).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[genres] local index counts unavailable for selected servers',
      { failedServerIds: ['srv-b'] },
    );
    warn.mockRestore();
  });

  it('rejects when every selected index is unavailable', async () => {
    vi.mocked(libraryGetGenreAlbumCounts).mockRejectedValue(new Error('index unavailable'));

    await expect(fetchScopedGenreCatalog([
      { serverId: 'srv-a', libraryIds: [] },
      { serverId: 'srv-b', libraryIds: [] },
    ])).rejects.toThrow('genre_catalog_scope_unavailable');
    expect(getGenres).not.toHaveBeenCalled();
  });

  it('drops empty genres from server fallback catalog', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(false);
    vi.mocked(getGenres).mockResolvedValue([
      { value: 'ruspop', songCount: 0, albumCount: 0 },
      { value: 'Rock', songCount: 10, albumCount: 3 },
    ]);

    await expect(fetchGenreCatalog('srv-1', true)).resolves.toEqual([
      { value: 'Rock', albumCount: 3, songCount: 10 },
    ]);
  });

  it('filterGenresWithContent drops zero-count rows', () => {
    expect(filterGenresWithContent([
      { value: 'Empty', albumCount: 0, songCount: 0 },
      { value: 'SongsOnly', albumCount: 0, songCount: 2 },
      { value: 'AlbumsOnly', albumCount: 1, songCount: 0 },
    ])).toEqual([
      { value: 'SongsOnly', albumCount: 0, songCount: 2 },
      { value: 'AlbumsOnly', albumCount: 1, songCount: 0 },
    ]);
  });

  it('reuses cached genre catalog without repeating SQL', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(true);
    vi.mocked(libraryGetGenreAlbumCounts).mockResolvedValue([
      { value: 'Rock', albumCount: 42, songCount: 900 },
    ]);

    await fetchGenreCatalog('srv-1', true);
    await fetchGenreCatalog('srv-1', true);

    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledTimes(1);
  });

  it('bypasses online genre cache when offline local browse is active', async () => {
    vi.mocked(libraryIsReady).mockResolvedValue(true);
    vi.mocked(libraryGetGenreAlbumCounts).mockResolvedValue([
      { value: 'Rock', albumCount: 999, songCount: 900 },
    ]);
    await fetchGenreCatalog('srv-1', true);

    isOfflineBrowseActiveMock.mockReturnValue(true);
    offlineLocalBrowseEnabledMock.mockReturnValue(true);

    await expect(fetchGenreCatalog('srv-1', true)).resolves.toEqual([
      { value: 'CachedLocal', albumCount: 2, songCount: 0 },
    ]);
    expect(fetchOfflineLocalGenreCatalogMock).toHaveBeenCalledWith('srv-1');
    expect(libraryGetGenreAlbumCounts).toHaveBeenCalledTimes(1);
  });

  it('reads album totals from offline local genre catalog', async () => {
    isOfflineBrowseActiveMock.mockReturnValue(true);
    offlineLocalBrowseEnabledMock.mockReturnValue(true);
    fetchOfflineLocalGenreCatalogMock.mockResolvedValue([
      { value: 'Rock', albumCount: 3, songCount: 0 },
    ]);

    await expect(fetchGenreAlbumCount('srv-1', 'Rock', true)).resolves.toBe(3);
    expect(fetchGenreAlbumTotal).not.toHaveBeenCalled();
  });
});
