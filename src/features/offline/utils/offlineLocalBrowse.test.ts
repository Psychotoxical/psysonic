import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryTrackDto } from '@/lib/api/library';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import {
  buildAlbumFromTracks,
  countLocalBrowsableTracks,
  fetchOfflineLocalAlbumCatalogChunk,
  fetchOfflineLocalArtistCatalogChunk,
  fetchOfflineLocalAlbumGenreOptions,
  fetchOfflineLocalGenreCatalog,
  fetchOfflineLocalBrowsableSongPage,
  fetchOfflineLocalStarredArtists,
  invalidateBrowsableLocalTrackCache,
  loadArtistFromLocalPlayback,
  offlineLocalBrowseEnabled,
  resetBrowsableLocalTrackCacheForTests,
  searchOfflineLocalAlbums,
  searchOfflineLocalArtists,
  searchOfflineLocalBrowsableSongs,
} from '@/features/offline/utils/offlineLocalBrowse';
import { resetOfflineLocalLibrarySyncRevisionForTests, bumpOfflineLocalLibrarySyncRevisionForTests } from '@/store/offlineLocalLibrarySyncRevision';

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
  subscribeLibrarySyncIdle: vi.fn(async () => () => {}),
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
    resetOfflineLocalLibrarySyncRevisionForTests();
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

  it('buildAlbumFromTracks derives album artist credit from grouped tracks', () => {
    const album = buildAlbumFromTracks('al-1', [
      {
        id: 't1', title: 'Feat', artist: 'Guest', artistId: 'art-guest',
        albumArtist: 'Headliner', album: 'Mix', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
      {
        id: 't2', title: 'Title', artist: 'Headliner', artistId: 'art-head',
        albumArtist: 'Headliner', album: 'Mix', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ], 'srv-a');
    expect(album.artist).toBe('Headliner');
    expect(album.artistId).toBe('art-head');
  });

  it('fetchOfflineLocalArtistCatalogChunk filters letter buckets with ignoredArticles', async () => {
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
        id: 't1', title: 'Song', artist: 'The Kinks', artistId: 'art-kinks',
        album: 'Al', albumId: 'al-1', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    const bucketK = await fetchOfflineLocalArtistCatalogChunk(
      'srv-a', 0, 50, 'track', 'K', 'The',
    );
    expect(bucketK?.artists.map(a => a.name)).toEqual(['The Kinks']);

    const bucketT = await fetchOfflineLocalArtistCatalogChunk(
      'srv-a', 0, 50, 'track', 'T', 'The',
    );
    expect(bucketT?.artists).toEqual([]);
  });

  it('fetchOfflineLocalStarredArtists respects album credit mode', async () => {
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
        albumArtist: 'Headliner', album: 'Al', albumId: 'al-1', starredAt: 1,
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
      {
        id: 't2', title: 'Title', artist: 'Headliner', artistId: 'art-head',
        albumArtist: 'Headliner', album: 'Al', albumId: 'al-1', starredAt: 1,
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    await expect(fetchOfflineLocalStarredArtists('srv-a', 'album')).resolves.toEqual([
      {
        id: 'art-head',
        name: 'Headliner',
        albumCount: 1,
        serverId: 'srv-a',
        starred: expect.any(String),
      },
    ]);
  });

  it('invalidateBrowsableLocalTrackCache refetches track metadata after invalidation', async () => {
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
    libraryGetTracksBatchChunkedMock
      .mockResolvedValueOnce([
        {
          id: 't1', title: 'Old', artist: 'A', artistId: 'art-a', album: 'Al', albumId: 'al-1',
          genre: 'Rock', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 't1', title: 'New', artist: 'A', artistId: 'art-a', album: 'Al', albumId: 'al-1',
          genre: 'Jazz', durationSec: 1, serverId: 'srv-a', syncedAt: 2, rawJson: {},
        },
      ]);

    await fetchOfflineLocalArtistCatalogChunk('srv-a', 0, 10);
    invalidateBrowsableLocalTrackCache('srv-a');
    await expect(searchOfflineLocalBrowsableSongs('srv-a', 'new', 0, 10)).resolves.toEqual([
      expect.objectContaining({ title: 'New' }),
    ]);
    expect(libraryGetTracksBatchChunkedMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateBrowsableLocalTrackCache matches library index key from sync-idle', async () => {
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
    libraryGetTracksBatchChunkedMock
      .mockResolvedValueOnce([
        {
          id: 't1', title: 'Old', artist: 'A', artistId: 'art-a', album: 'Al', albumId: 'al-1',
          genre: 'Rock', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 't1', title: 'New', artist: 'A', artistId: 'art-a', album: 'Al', albumId: 'al-1',
          genre: 'Jazz', durationSec: 1, serverId: 'srv-a', syncedAt: 2, rawJson: {},
        },
      ]);

    await fetchOfflineLocalArtistCatalogChunk('srv-a', 0, 10);
    invalidateBrowsableLocalTrackCache('a.test');
    await expect(searchOfflineLocalBrowsableSongs('srv-a', 'new', 0, 10)).resolves.toEqual([
      expect.objectContaining({ title: 'New' }),
    ]);
    expect(libraryGetTracksBatchChunkedMock).toHaveBeenCalledTimes(2);
  });

  it('fetchOfflineLocalAlbumCatalogChunk pages filtered local albums', async () => {
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
        id: 't1', title: 'Song', artist: 'A', artistId: 'art-a',
        album: 'Local Album', albumId: 'al-1', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    const page = await fetchOfflineLocalAlbumCatalogChunk('srv-a', {
      sort: 'alphabeticalByName',
      genres: [],
      losslessOnly: false,
      starredOnly: false,
      compFilter: 'all',
    }, 0, 10);
    expect(page?.albums[0]?.name).toBe('Local Album');
    expect(page?.albums[0]?.artistId).toBe('art-a');
  });

  it('searchOfflineLocalBrowsableSongs matches title artist and album', async () => {
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
        id: 't1', title: 'Unique Title', artist: 'Band', artistId: 'art-a',
        album: 'Album', albumId: 'al-1', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    await expect(searchOfflineLocalBrowsableSongs('srv-a', 'unique', 0, 10)).resolves.toEqual([
      expect.objectContaining({ id: 't1', title: 'Unique Title' }),
    ]);
  });

  it('searchOfflineLocalAlbums finds albums by title or artist', async () => {
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
        id: 't1', title: 'Song', artist: 'Cached Band', artistId: 'art-a',
        album: 'Pinned LP', albumId: 'al-1', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    await expect(searchOfflineLocalAlbums('srv-a', 'pinned')).resolves.toEqual([
      expect.objectContaining({ name: 'Pinned LP' }),
    ]);
  });

  it('loadArtistFromLocalPlayback album credit loads albums by album artist id', async () => {
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
        albumArtist: 'Headliner', album: 'Al', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
      {
        id: 't2', title: 'Title', artist: 'Headliner', artistId: 'art-head',
        albumArtist: 'Headliner', album: 'Al', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    const detail = await loadArtistFromLocalPlayback('srv-a', 'art-head', 'album');
    expect(detail?.artist.name).toBe('Headliner');
    expect(detail?.albums).toHaveLength(1);
  });

  it('loadArtistFromLocalPlayback falls back to album credit when track mode misses album artist id', async () => {
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
        albumArtist: 'Headliner', album: 'Al', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
      {
        id: 't2', title: 'Title', artist: 'Headliner', artistId: 'art-head',
        albumArtist: 'Headliner', album: 'Al', albumId: 'al-1',
        durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
      },
    ]);

    const detail = await loadArtistFromLocalPlayback('srv-a', 'art-head', 'track');
    expect(detail?.artist.name).toBe('Headliner');
    expect(detail?.albums).toHaveLength(1);
  });

  it('offlineLocalBrowseRevision bumps when hot-cache rows are added', async () => {
    const { offlineLocalBrowseRevision } = await import('@/store/localPlaybackBrowseRevision');
    useLocalPlaybackStore.setState({ entries: {} });
    expect(offlineLocalBrowseRevision('srv-a', {})).toBe('');

    const entries = {
      'a.test:t1': {
        serverIndexKey: 'a.test',
        trackId: 't1',
        localPath: '/media/cache/a.test/t1.flac',
        layoutFingerprint: 'fp',
        sizeBytes: 1,
        tier: 'ephemeral' as const,
        cachedAt: 1,
        suffix: 'flac',
      },
    };
    const first = offlineLocalBrowseRevision('srv-a', entries);
    expect(first).toBe('t1:ephemeral:1');

    const second = offlineLocalBrowseRevision('srv-a', {
      ...entries,
      'a.test:t2': {
        serverIndexKey: 'a.test',
        trackId: 't2',
        localPath: '/media/cache/a.test/t2.flac',
        layoutFingerprint: 'fp',
        sizeBytes: 1,
        tier: 'ephemeral' as const,
        cachedAt: 2,
        suffix: 'flac',
      },
    });
    expect(second).not.toBe(first);
  });

  it('fetchBrowsableLocalTrackDtos refetches after library sync revision bump', async () => {
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
    libraryGetTracksBatchChunkedMock
      .mockResolvedValueOnce([
        {
          id: 't1', title: 'Old', artist: 'A', artistId: 'art-a', album: 'Al', albumId: 'al-1',
          genre: 'Rock', durationSec: 1, serverId: 'srv-a', syncedAt: 1, rawJson: {},
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 't1', title: 'New', artist: 'A', artistId: 'art-a', album: 'Al', albumId: 'al-1',
          genre: 'Jazz', durationSec: 1, serverId: 'srv-a', syncedAt: 2, rawJson: {},
        },
      ]);

    await fetchOfflineLocalArtistCatalogChunk('srv-a', 0, 10);
    bumpOfflineLocalLibrarySyncRevisionForTests('srv-a');
    await expect(searchOfflineLocalBrowsableSongs('srv-a', 'new', 0, 10)).resolves.toEqual([
      expect.objectContaining({ title: 'New' }),
    ]);
    expect(libraryGetTracksBatchChunkedMock).toHaveBeenCalledTimes(2);
  });

});
