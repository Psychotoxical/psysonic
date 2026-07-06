import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTrackDto } from '@/lib/api/library';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import {
  countLocalBrowsableTracks,
  fetchOfflineLocalArtistCatalogChunk,
  fetchOfflineLocalAlbumGenreOptions,
  fetchOfflineLocalGenreCatalog,
  fetchOfflineLocalBrowsableSongPage,
  loadArtistFromLocalPlayback,
  offlineLocalBrowseEnabled,
  resetBrowsableLocalTrackCacheForTests,
  searchOfflineLocalArtists,
} from '@/features/offline/utils/offlineLocalBrowse';

const { libraryGetTracksBatchChunkedMock, libraryAdvancedSearchMock } = vi.hoisted(() => ({
  libraryGetTracksBatchChunkedMock: vi.fn(async (): Promise<LibraryTrackDto[]> => []),
  libraryAdvancedSearchMock: vi.fn(async () => ({
    source: 'local' as const,
    albums: [],
    artists: [
      { id: 'ghost', name: 'Ghost Artist', serverId: 'srv-a', syncedAt: 0, rawJson: {} },
    ],
    tracks: [],
    totals: { tracks: 0, albums: 0, artists: 1 },
    appliedFilters: [],
  })),
}));

vi.mock('@/lib/api/library', () => ({
  libraryGetTracksBatchChunked: libraryGetTracksBatchChunkedMock,
  libraryGetTracksByAlbum: vi.fn(async () => []),
  libraryAdvancedSearch: libraryAdvancedSearchMock,
}));

describe('offlineLocalBrowse', () => {
  beforeEach(() => {
    useAuthStore.setState({
      activeServerId: 'srv-a',
      servers: [{ id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
    });
    useLibraryIndexStore.setState({ masterEnabled: true });
    useLocalPlaybackStore.setState({ entries: {} });
    resetBrowsableLocalTrackCacheForTests();
    libraryGetTracksBatchChunkedMock.mockReset();
    libraryGetTracksBatchChunkedMock.mockResolvedValue([]);
    libraryAdvancedSearchMock.mockClear();
  });

  it('offlineLocalBrowseEnabled requires index and local bytes', () => {
    expect(offlineLocalBrowseEnabled('srv-a')).toBe(false);
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/library/a.test/a/al/t1.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    expect(countLocalBrowsableTracks('srv-a')).toBe(1);
    expect(offlineLocalBrowseEnabled('srv-a')).toBe(true);
  });

  it('offlineLocalBrowseEnabled treats hot-cache ephemeral bytes like library pins', () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t9': {
          serverIndexKey: 'a.test',
          trackId: 't9',
          localPath: '/media/cache/a.test/t9.flac',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
    expect(countLocalBrowsableTracks('srv-a')).toBe(1);
    expect(offlineLocalBrowseEnabled('srv-a')).toBe(true);
  });

  it('fetchOfflineLocalBrowsableSongPage pages local bytes alphabetically', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/library/a.test/a/al/t1.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
        'a.test:t2': {
          serverIndexKey: 'a.test',
          trackId: 't2',
          localPath: '/media/library/a.test/a/al/t2.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    libraryGetTracksBatchChunkedMock.mockResolvedValue([
      {
        id: 't2', title: 'Beta', artist: 'A', album: 'Al', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
      {
        id: 't1', title: 'Alpha', artist: 'A', album: 'Al', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    const page = await fetchOfflineLocalBrowsableSongPage('srv-a', 0, 1);
    expect(page?.songs.map(s => s.id)).toEqual(['t1']);
    expect(page?.hasMore).toBe(true);
  });

  it('fetchOfflineLocalArtistCatalogChunk lists only artists with local bytes', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/cache/a.test/t1.flac',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
    libraryGetTracksBatchChunkedMock.mockResolvedValue([
      {
        id: 't1',
        title: 'Song',
        artist: 'Local Only',
        artistId: 'art-local',
        album: 'Al',
        albumId: 'al-1',
        durationSec: 1,
        serverId: 'srv-a',
        syncedAt: 1,
        rawJson: {},
      },
    ]);

    const page = await fetchOfflineLocalArtistCatalogChunk('srv-a', 0, 50);
    expect(page?.artists).toEqual([
      { id: 'art-local', name: 'Local Only', albumCount: 1, serverId: 'srv-a' },
    ]);
    expect(libraryAdvancedSearchMock).not.toHaveBeenCalled();
  });

  it('searchOfflineLocalArtists ignores the full library index', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/cache/a.test/t1.flac',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
    libraryGetTracksBatchChunkedMock.mockResolvedValue([
      {
        id: 't1',
        title: 'Song',
        artist: 'Cached Band',
        artistId: 'art-cached',
        album: 'Al',
        albumId: 'al-1',
        durationSec: 1,
        serverId: 'srv-a',
        syncedAt: 1,
        rawJson: {},
      },
    ]);

    await expect(searchOfflineLocalArtists('srv-a', 'cached')).resolves.toEqual([
      { id: 'art-cached', name: 'Cached Band', albumCount: 1, serverId: 'srv-a' },
    ]);
    expect(libraryAdvancedSearchMock).not.toHaveBeenCalled();
  });

  it('fetchOfflineLocalAlbumGenreOptions counts genres from local albums only', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/cache/a.test/t1.flac',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
        'a.test:t2': {
          serverIndexKey: 'a.test',
          trackId: 't2',
          localPath: '/media/cache/a.test/t2.flac',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
    libraryGetTracksBatchChunkedMock.mockResolvedValue([
      {
        id: 't1', title: 'One', artist: 'A', artistId: 'art-a', album: 'Al1', albumId: 'al-1',
        genre: 'Rock', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
      {
        id: 't2', title: 'Two', artist: 'B', artistId: 'art-b', album: 'Al2', albumId: 'al-2',
        genre: 'Jazz', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    await expect(fetchOfflineLocalAlbumGenreOptions('srv-a', {
      sort: 'alphabeticalByName',
      genres: [],
      losslessOnly: false,
      starredOnly: false,
      compFilter: 'all',
    })).resolves.toEqual([
      { genre: 'Jazz', count: 1 },
      { genre: 'Rock', count: 1 },
    ]);
    expect(libraryAdvancedSearchMock).not.toHaveBeenCalled();
  });

  it('fetchOfflineLocalArtistCatalogChunk honours album vs track credit mode', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/cache/a.test/t1.flac',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
        'a.test:t2': {
          serverIndexKey: 'a.test',
          trackId: 't2',
          localPath: '/media/cache/a.test/t2.flac',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
    libraryGetTracksBatchChunkedMock.mockResolvedValue([
      {
        id: 't1', title: 'Feat', artist: 'Guest', artistId: 'art-guest',
        albumArtist: 'Headliner', album: 'Al1', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
      {
        id: 't2', title: 'Title', artist: 'Headliner', artistId: 'art-head',
        albumArtist: 'Headliner', album: 'Al1', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    const trackMode = await fetchOfflineLocalArtistCatalogChunk('srv-a', 0, 50, 'track');
    expect(trackMode?.artists.map(a => a.id).sort()).toEqual(['art-guest', 'art-head']);

    const albumMode = await fetchOfflineLocalArtistCatalogChunk('srv-a', 0, 50, 'album');
    expect(albumMode?.artists).toEqual([
      { id: 'art-head', name: 'Headliner', albumCount: 1, serverId: 'srv-a' },
    ]);
  });

  it('fetchBrowsableLocalTrackDtos reuses the in-memory batch for pagination chunks', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/cache/a.test/t1.flac',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
    libraryGetTracksBatchChunkedMock.mockResolvedValue([
      {
        id: 't1', title: 'Song', artist: 'A', artistId: 'art-a', album: 'Al', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    await fetchOfflineLocalArtistCatalogChunk('srv-a', 0, 1);
    await fetchOfflineLocalArtistCatalogChunk('srv-a', 1, 1);
    expect(libraryGetTracksBatchChunkedMock).toHaveBeenCalledTimes(1);
  });

  it('loadArtistFromLocalPlayback uses local track rows only', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/cache/a.test/t1.flac',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
    libraryGetTracksBatchChunkedMock.mockResolvedValue([
      {
        id: 't1', title: 'Song', artist: 'Local Only', artistId: 'art-local',
        album: 'Al', albumId: 'al-1', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    const detail = await loadArtistFromLocalPlayback('srv-a', 'art-local', 'track');
    expect(detail?.artist.name).toBe('Local Only');
    expect(detail?.albums).toHaveLength(1);
    expect(libraryAdvancedSearchMock).not.toHaveBeenCalled();
  });

  it('fetchOfflineLocalGenreCatalog maps local album genres to SubsonicGenre', async () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/cache/a.test/t1.flac',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'ephemeral',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
    libraryGetTracksBatchChunkedMock.mockResolvedValue([
      {
        id: 't1', title: 'One', artist: 'A', artistId: 'art-a', album: 'Al', albumId: 'al-1',
        genre: 'Rock', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    await expect(fetchOfflineLocalGenreCatalog('srv-a')).resolves.toEqual([
      { value: 'Rock', albumCount: 1, songCount: 0 },
    ]);
  });

});
