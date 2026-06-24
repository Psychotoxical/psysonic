import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGenreAlbumCount,
  fetchGenreCatalog,
  fetchGenreTracksForPlayback,
  fetchLocalGenreTracksForPlayback,
  filterGenresWithContent,
  GENRE_PLAYBACK_QUEUE_CAP,
} from './genreBrowsePlayback';

vi.mock('../../api/library', () => ({
  libraryAdvancedSearch: vi.fn(),
  libraryGetGenreAlbumCounts: vi.fn(),
}));

vi.mock('../../api/subsonicGenres', () => ({
  fetchAllSongsByGenre: vi.fn(),
  getGenres: vi.fn(),
}));

vi.mock('../../api/subsonicClient', () => ({
  libraryScopeForServer: vi.fn(() => 'music'),
}));

vi.mock('./libraryReady', () => ({
  libraryIsReady: vi.fn(),
}));

vi.mock('./genreAlbumBrowse', () => ({
  fetchGenreAlbumTotal: vi.fn(),
}));

import { libraryAdvancedSearch, libraryGetGenreAlbumCounts } from '../../api/library';
import { fetchAllSongsByGenre, getGenres } from '../../api/subsonicGenres';
import { fetchGenreAlbumTotal } from './genreAlbumBrowse';
import { resetGenreCatalogCountsCacheForTests } from './genreCatalogCountsCache';
import { libraryIsReady } from './libraryReady';

describe('genreBrowsePlayback', () => {
  beforeEach(() => {
    resetGenreCatalogCountsCacheForTests();
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
});
