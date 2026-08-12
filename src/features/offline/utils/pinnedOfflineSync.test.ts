import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import { useOfflineStore } from '@/features/offline/store/offlineStore';
import {
  isManualOfflinePlaylist,
  isPlaylistPinnedOffline,
  isSourcePinnedOffline,
  schedulePinnedAlbumSync,
  schedulePinnedPlaylistSync,
  scheduleSyncPinnedAlbumsAndArtists,
  syncAllPinnedPlaylists,
  syncPinnedArtistIfNeeded,
  syncPinnedSourceIfNeeded,
  initPinnedOfflineSync,
} from '@/features/offline/utils/pinnedOfflineSync';
import { SMART_PREFIX } from '@/lib/format/playlistDetailHelpers';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';

const getPlaylistMock = vi.fn();
const getAlbumForServerMock = vi.fn();
const getArtistForServerMock = vi.fn();
const filterSongsMock = vi.fn(async (songs: SubsonicSong[]) => songs);
const isReachableMock = vi.fn(() => true);
const enqueueMock = vi.fn((_task: unknown) => true);
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => ({}));
const subscribeLibrarySyncIdleMock = vi.fn();

vi.mock('@/lib/network/activeServerReachability', () => ({
  isActiveServerReachable: () => isReachableMock(),
  onActiveServerBecameReachable: () => () => {},
}));

vi.mock('@/lib/api/subsonicPlaylists', () => ({
  getPlaylistForServer: (serverId: string, id: string) => getPlaylistMock(serverId, id),
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getAlbumForServer: (serverId: string, id: string) => getAlbumForServerMock(serverId, id),
  filterSongsToServerLibrary: (songs: SubsonicSong[]) => filterSongsMock(songs),
}));

vi.mock('@/lib/api/subsonicArtists', () => ({
  getArtistForServer: (serverId: string, artistId: string) => getArtistForServerMock(serverId, artistId),
}));

vi.mock('@/lib/api/library', () => ({
  libraryGetTracksByAlbum: vi.fn(async () => []),
  subscribeLibrarySyncIdle: (listener: unknown) => subscribeLibrarySyncIdleMock(listener),
}));

vi.mock('@/features/offline/utils/offlinePinQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/offline/utils/offlinePinQueue')>();
  return {
    ...actual,
    enqueueOfflinePin: (task: unknown) => enqueueMock(task),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => (
    cmd === 'probe_media_files' ? Promise.resolve([false]) : invokeMock(cmd, args)
  ),
}));

function song(id: string): SubsonicSong {
  return {
    id,
    title: id,
    artist: 'A',
    album: 'Al',
    albumId: 'al-1',
    duration: 100,
  };
}

function seedAuth(): void {
  useAuthStore.setState({
    activeServerId: 'srv-a',
    servers: [{ id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
  });
}

beforeEach(() => {
  deactivateCanonicalNavidromeOwners(['srv-a', 'a.test']);
  subscribeLibrarySyncIdleMock.mockReset().mockResolvedValue(() => {});
});

describe('initPinnedOfflineSync', () => {
  it('unsubscribes a delayed listener that resolves after cleanup', async () => {
    let resolveSubscribe!: (unlisten: () => void) => void;
    const unlisten = vi.fn();
    subscribeLibrarySyncIdleMock.mockImplementation(() => new Promise(resolve => {
      resolveSubscribe = resolve;
    }));

    const cleanup = initPinnedOfflineSync();
    cleanup();
    resolveSubscribe(unlisten);
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('does not revive stale source work after cleanup and reinitialization', async () => {
    useOfflineStore.setState({
      albums: {
        'a.test:al-1': {
          id: 'al-1', serverId: 'a.test', name: 'Album', artist: 'Artist',
          trackIds: [], type: 'album',
        },
      },
    });
    useLocalPlaybackStore.setState({ entries: {} });
    seedAuth();
    let resolveOld!: (value: {
      album: { id: string; name: string; artist: string };
      songs: SubsonicSong[];
    }) => void;
    getAlbumForServerMock
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({
        album: { id: 'al-1', name: 'New', artist: 'Artist' },
        songs: [song('t-new')],
      });

    const cleanup = initPinnedOfflineSync();
    const oldRun = syncPinnedSourceIfNeeded('al-1', 'srv-a', 'album');
    cleanup();
    const cleanupNew = initPinnedOfflineSync();
    await syncPinnedSourceIfNeeded('al-1', 'srv-a', 'album');
    resolveOld({
      album: { id: 'al-1', name: 'Old', artist: 'Artist' },
      songs: [song('t-old')],
    });
    await oldRun;
    cleanupNew();

    expect(useOfflineStore.getState().albums['a.test:al-1']).toMatchObject({
      name: 'New', trackIds: ['t-new'],
    });
  });
});

describe('isPlaylistPinnedOffline', () => {
  beforeEach(() => {
    useOfflineStore.setState({ albums: {} });
    useLocalPlaybackStore.setState({ entries: {} });
    seedAuth();
  });

  it('returns true when offline meta marks a playlist pin', () => {
    useOfflineStore.setState({
      albums: {
        'a.test:pl-1': {
          id: 'pl-1',
          serverId: 'a.test',
          name: 'Mix',
          artist: '',
          trackIds: ['t1'],
          type: 'playlist',
        },
      },
    });
    expect(isPlaylistPinnedOffline('pl-1', 'srv-a')).toBe(true);
  });

  it('returns false for uncached playlists', () => {
    expect(isPlaylistPinnedOffline('pl-9', 'srv-a')).toBe(false);
  });
});

describe('isManualOfflinePlaylist', () => {
  beforeEach(() => seedAuth());

  it('rejects smart playlist names', () => {
    expect(isManualOfflinePlaylist('pl-1', 'srv-a', `${SMART_PREFIX}Jazz`)).toBe(false);
  });

  it('allows regular playlist names', () => {
    expect(isManualOfflinePlaylist('pl-1', 'srv-a', 'Road mix')).toBe(true);
  });
});

describe('schedulePinnedPlaylistSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isReachableMock.mockReturnValue(true);
    getPlaylistMock.mockReset();
    enqueueMock.mockReset();
    invokeMock.mockClear();
    useOfflineJobStoreReset();
    useOfflineStore.setState({
      albums: {
        'a.test:pl-1': {
          id: 'pl-1',
          serverId: 'a.test',
          name: 'Road mix',
          artist: '',
          trackIds: ['t1'],
          type: 'playlist',
        },
      },
    });
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/library/a.test/a/al/t1.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1000,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
          pinSource: { kind: 'playlist', sourceId: 'pl-1', displayName: 'Road mix' },
        },
      },
    });
    seedAuth();
    getPlaylistMock.mockResolvedValue({
      playlist: { id: 'pl-1', name: 'Road mix', songCount: 1 },
      songs: [song('t2')],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when the playlist is not cached offline', async () => {
    schedulePinnedPlaylistSync('pl-9');
    await vi.advanceTimersByTimeAsync(700);
    expect(getPlaylistMock).not.toHaveBeenCalled();
  });

  it('does not sync smart playlists even when previously cached', async () => {
    useOfflineStore.setState({
      albums: {
        'a.test:pl-smart': {
          id: 'pl-smart',
          serverId: 'a.test',
          name: `${SMART_PREFIX}Daily`,
          artist: '',
          trackIds: ['t1'],
          type: 'playlist',
        },
      },
    });
    schedulePinnedPlaylistSync('pl-smart');
    await vi.advanceTimersByTimeAsync(700);
    expect(getPlaylistMock).not.toHaveBeenCalled();
  });

  it('prunes removed tracks and enqueues downloads for the new list', async () => {
    schedulePinnedPlaylistSync('pl-1');
    await vi.advanceTimersByTimeAsync(700);

    expect(getPlaylistMock).toHaveBeenCalledWith('srv-a', 'pl-1');
    expect(invokeMock).toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/media/library/a.test/a/al/t1.mp3' }),
    );
    expect(useLocalPlaybackStore.getState().entries['a.test:t1']).toBeUndefined();
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        albumId: 'pl-1',
        type: 'playlist',
        songs: [expect.objectContaining({ id: 't2' })],
      }),
    );
    expect(useOfflineStore.getState().albums['a.test:pl-1']?.trackIds).toEqual(['t2']);
  });
});

describe('scheduleSyncPinnedAlbumsAndArtists', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isReachableMock.mockReturnValue(true);
    getAlbumForServerMock.mockReset();
    enqueueMock.mockReset();
    useOfflineJobStoreReset();
    useOfflineStore.setState({
      albums: {
        'a.test:al-1': {
          id: 'al-1',
          serverId: 'a.test',
          name: 'Album',
          artist: 'Artist',
          trackIds: ['t1'],
          type: 'album',
        },
      },
    });
    seedAuth();
    getAlbumForServerMock.mockResolvedValue({
      album: { id: 'al-1', name: 'Album', artist: 'Artist', coverArt: 'c1' },
      songs: [song('t2')],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles cached albums after a debounced library-scope trigger', async () => {
    scheduleSyncPinnedAlbumsAndArtists('srv-a');
    await vi.advanceTimersByTimeAsync(700);
    expect(getAlbumForServerMock).toHaveBeenCalledWith('srv-a', 'al-1');
    expect(useOfflineStore.getState().albums['a.test:al-1']?.trackIds).toEqual(['t2']);
  });
});

describe('schedulePinnedAlbumSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isReachableMock.mockReturnValue(true);
    getAlbumForServerMock.mockReset();
    enqueueMock.mockReset();
    invokeMock.mockClear();
    useOfflineJobStoreReset();
    useOfflineStore.setState({
      albums: {
        'a.test:al-1': {
          id: 'al-1',
          serverId: 'a.test',
          name: 'Album',
          artist: 'Artist',
          trackIds: ['t1'],
          type: 'album',
        },
      },
    });
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/library/a.test/a/al/t1.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1000,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
          pinSource: { kind: 'album', sourceId: 'al-1', displayName: 'Album' },
        },
      },
    });
    seedAuth();
    getAlbumForServerMock.mockResolvedValue({
      album: { id: 'al-1', name: 'Album', artist: 'Artist', coverArt: 'c1' },
      songs: [song('t2')],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconciles a cached album against the live track list', async () => {
    expect(isSourcePinnedOffline('al-1', 'srv-a', 'album')).toBe(true);
    schedulePinnedAlbumSync('al-1');
    await vi.advanceTimersByTimeAsync(700);

    expect(getAlbumForServerMock).toHaveBeenCalledWith('srv-a', 'al-1');
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        albumId: 'al-1',
        type: 'album',
        songs: [expect.objectContaining({ id: 't2' })],
      }),
    );
    expect(useOfflineStore.getState().albums['a.test:al-1']?.trackIds).toEqual(['t2']);
  });

  it('canonicalizes a stale sync response after ACK before metadata and queue writes', async () => {
    const legacyAlbumId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const legacyTrackId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const legacyCoverId = '00112233-4455-6677-8899-aabbccddeeff';
    const canonicalAlbumId = canonicalizeNavidromeId(legacyAlbumId);
    const canonicalTrackId = canonicalizeNavidromeId(legacyTrackId);
    const canonicalCoverId = canonicalizeNavidromeId(legacyCoverId);
    let resolveAlbum!: (value: {
      album: { id: string; name: string; artist: string; coverArt: string };
      songs: SubsonicSong[];
    }) => void;
    getAlbumForServerMock.mockImplementation(() => new Promise(resolve => {
      resolveAlbum = resolve;
    }));
    useOfflineStore.setState({
      albums: {
        [`a.test:${legacyAlbumId}`]: {
          id: legacyAlbumId,
          serverId: 'a.test',
          name: 'Album',
          artist: 'Artist',
          trackIds: [legacyTrackId],
          type: 'album',
        },
      },
    });

    const sync = syncPinnedSourceIfNeeded(legacyAlbumId, 'srv-a', 'album');
    await vi.waitFor(() => expect(getAlbumForServerMock).toHaveBeenCalled());

    activateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    useOfflineStore.setState({
      albums: {
        [`a.test:${canonicalAlbumId}`]: {
          id: canonicalAlbumId,
          serverId: 'a.test',
          name: 'Album',
          artist: 'Artist',
          coverArt: canonicalCoverId,
          trackIds: [canonicalTrackId],
          type: 'album',
        },
      },
    });
    resolveAlbum({
      album: { id: legacyAlbumId, name: 'Album', artist: 'Artist', coverArt: legacyCoverId },
      songs: [{
        ...song(legacyTrackId),
        albumId: legacyAlbumId,
        coverArt: legacyCoverId,
      }],
    });
    await sync;

    expect(useOfflineStore.getState().albums).toEqual({
      [`a.test:${canonicalAlbumId}`]: expect.objectContaining({
        id: canonicalAlbumId,
        coverArt: canonicalCoverId,
        trackIds: [canonicalTrackId],
      }),
    });
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      albumId: canonicalAlbumId,
      coverArt: canonicalCoverId,
      songs: [expect.objectContaining({
        id: canonicalTrackId,
        albumId: canonicalAlbumId,
        coverArt: canonicalCoverId,
      })],
    }));
    deactivateCanonicalNavidromeOwners(['srv-a', 'a.test']);
  });

  it('does not prune canonical pin bytes from a response started before activation', async () => {
    const legacyAlbumId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const legacyRemovedTrackId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const canonicalAlbumId = canonicalizeNavidromeId(legacyAlbumId);
    const canonicalRemovedTrackId = canonicalizeNavidromeId(legacyRemovedTrackId);
    let resolveAlbum!: (value: {
      album: { id: string; name: string; artist: string };
      songs: SubsonicSong[];
    }) => void;
    getAlbumForServerMock.mockImplementation(() => new Promise(resolve => {
      resolveAlbum = resolve;
    }));
    useOfflineStore.setState({
      albums: {
        [`a.test:${legacyAlbumId}`]: {
          id: legacyAlbumId,
          serverId: 'a.test',
          name: 'Album',
          artist: 'Artist',
          trackIds: [legacyRemovedTrackId],
          type: 'album',
        },
      },
    });
    useLocalPlaybackStore.setState({
      entries: {
        [`a.test:${legacyRemovedTrackId}`]: {
          serverIndexKey: 'a.test',
          trackId: legacyRemovedTrackId,
          localPath: `/media/${legacyRemovedTrackId}.flac`,
          layoutFingerprint: 'legacy',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'flac',
          pinSource: { kind: 'album', sourceId: legacyAlbumId },
        },
      },
    });

    const sync = syncPinnedSourceIfNeeded(legacyAlbumId, 'srv-a', 'album');
    await vi.waitFor(() => expect(getAlbumForServerMock).toHaveBeenCalled());
    activateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    useOfflineStore.setState({
      albums: {
        [`a.test:${canonicalAlbumId}`]: {
          id: canonicalAlbumId,
          serverId: 'a.test',
          name: 'Album',
          artist: 'Artist',
          trackIds: [canonicalRemovedTrackId],
          type: 'album',
        },
      },
    });
    useLocalPlaybackStore.setState({
      entries: {
        [`a.test:${canonicalRemovedTrackId}`]: {
          serverIndexKey: 'a.test',
          trackId: canonicalRemovedTrackId,
          localPath: `/media/${canonicalRemovedTrackId}.flac`,
          layoutFingerprint: 'canonical',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'flac',
          pinSource: { kind: 'album', sourceId: canonicalAlbumId },
        },
      },
    });
    resolveAlbum({ album: { id: legacyAlbumId, name: 'Album', artist: 'Artist' }, songs: [] });
    await sync;

    expect(invokeMock).not.toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: `/media/${canonicalRemovedTrackId}.flac` }),
    );
    expect(useLocalPlaybackStore.getState().entries[`a.test:${canonicalRemovedTrackId}`]).toBeDefined();
  });

  it('removes the canonical index row when identity changes during file deletion', async () => {
    const legacyAlbumId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const legacyRemovedTrackId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const canonicalAlbumId = canonicalizeNavidromeId(legacyAlbumId);
    const canonicalRemovedTrackId = canonicalizeNavidromeId(legacyRemovedTrackId);
    const localPath = `/media/${legacyRemovedTrackId}.flac`;
    let resolveDelete!: () => void;
    invokeMock.mockImplementationOnce(() => new Promise<Record<string, never>>(resolve => {
      resolveDelete = () => resolve({});
    }));
    getAlbumForServerMock.mockResolvedValue({
      album: { id: legacyAlbumId, name: 'Album', artist: 'Artist' },
      songs: [],
    });
    useOfflineStore.setState({
      albums: {
        [`a.test:${legacyAlbumId}`]: {
          id: legacyAlbumId,
          serverId: 'a.test',
          name: 'Album',
          artist: 'Artist',
          trackIds: [legacyRemovedTrackId],
          type: 'album',
        },
      },
    });
    useLocalPlaybackStore.setState({
      entries: {
        [`a.test:${legacyRemovedTrackId}`]: {
          serverIndexKey: 'a.test',
          trackId: legacyRemovedTrackId,
          localPath,
          layoutFingerprint: 'legacy',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'flac',
          pinSource: { kind: 'album', sourceId: legacyAlbumId },
        },
      },
    });

    const sync = syncPinnedSourceIfNeeded(legacyAlbumId, 'srv-a', 'album');
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath }),
    ));

    activateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    useLocalPlaybackStore.setState({
      entries: {
        [`a.test:${canonicalRemovedTrackId}`]: {
          serverIndexKey: 'a.test',
          trackId: canonicalRemovedTrackId,
          localPath,
          layoutFingerprint: 'canonical',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'flac',
          pinSource: { kind: 'album', sourceId: canonicalAlbumId },
        },
      },
    });
    resolveDelete();
    await sync;

    expect(useLocalPlaybackStore.getState().entries[`a.test:${canonicalRemovedTrackId}`]).toBeUndefined();
  });

  it('ignores an older source refresh that settles after a newer one', async () => {
    useOfflineStore.setState({
      albums: {
        'a.test:al-1': {
          id: 'al-1',
          serverId: 'a.test',
          name: 'Album',
          artist: 'Artist',
          trackIds: [],
          type: 'album',
        },
      },
    });
    useLocalPlaybackStore.setState({ entries: {} });
    let resolveFirst!: (value: {
      album: { id: string; name: string; artist: string };
      songs: SubsonicSong[];
    }) => void;
    let resolveSecond!: (value: {
      album: { id: string; name: string; artist: string };
      songs: SubsonicSong[];
    }) => void;
    getAlbumForServerMock
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

    const first = syncPinnedSourceIfNeeded('al-1', 'srv-a', 'album');
    const second = syncPinnedSourceIfNeeded('al-1', 'srv-a', 'album');
    resolveSecond({
      album: { id: 'al-1', name: 'New Album', artist: 'Artist' },
      songs: [song('t-new')],
    });
    await second;
    resolveFirst({
      album: { id: 'al-1', name: 'Old Album', artist: 'Artist' },
      songs: [song('t-old')],
    });
    await first;

    expect(useOfflineStore.getState().albums['a.test:al-1']).toMatchObject({
      name: 'New Album',
      trackIds: ['t-new'],
    });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      songs: [expect.objectContaining({ id: 't-new' })],
    }));
  });

  it('keeps an older successful refresh when a newer request fails', async () => {
    useOfflineStore.setState({
      albums: {
        'a.test:al-1': {
          id: 'al-1', serverId: 'a.test', name: 'Album', artist: 'Artist',
          trackIds: [], type: 'album',
        },
      },
    });
    useLocalPlaybackStore.setState({ entries: {} });
    let resolveFirst!: (value: {
      album: { id: string; name: string; artist: string };
      songs: SubsonicSong[];
    }) => void;
    getAlbumForServerMock
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockRejectedValueOnce(new Error('offline'));

    const first = syncPinnedSourceIfNeeded('al-1', 'srv-a', 'album');
    await syncPinnedSourceIfNeeded('al-1', 'srv-a', 'album');
    resolveFirst({
      album: { id: 'al-1', name: 'Older Success', artist: 'Artist' },
      songs: [song('t-success')],
    });
    await first;

    expect(useOfflineStore.getState().albums['a.test:al-1']).toMatchObject({
      name: 'Older Success', trackIds: ['t-success'],
    });
  });
});

function seedArtistAlbumPin(albumId: string, trackId: string, serverIndexKey = 'a.test'): void {
  useOfflineStore.setState(state => ({
    albums: {
      ...state.albums,
      [`${serverIndexKey}:${albumId}`]: {
        id: albumId,
        serverId: serverIndexKey,
        name: `Album ${albumId}`,
        artist: 'Artist',
        trackIds: [trackId],
        type: 'artist',
      },
    },
  }));
  useLocalPlaybackStore.setState(state => ({
    entries: {
      ...state.entries,
      [`${serverIndexKey}:${trackId}`]: {
        serverIndexKey,
        trackId,
        localPath: `/media/library/${serverIndexKey}/a/${albumId}/${trackId}.mp3`,
        layoutFingerprint: 'fp',
        sizeBytes: 1000,
        tier: 'library',
        cachedAt: 1,
        suffix: 'mp3',
        pinSource: { kind: 'artist', sourceId: albumId },
      },
    },
  }));
}

describe('syncPinnedArtistIfNeeded', () => {
  beforeEach(() => {
    isReachableMock.mockReturnValue(true);
    getArtistForServerMock.mockReset();
    getAlbumForServerMock.mockReset();
    enqueueMock.mockReset();
    invokeMock.mockClear();
    useOfflineJobStoreReset();
    useOfflineStore.setState({ albums: {} });
    useLocalPlaybackStore.setState({ entries: {} });
    seedAuth();
  });

  it('prunes albums removed from the live artist catalog', async () => {
    seedArtistAlbumPin('al-1', 't1');
    seedArtistAlbumPin('al-2', 't2');
    getArtistForServerMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Artist' },
      albums: [{ id: 'al-1', name: 'One', artist: 'Artist' }],
    });
    getAlbumForServerMock.mockImplementation(async (_sid: string, id: string) => ({
      album: { id, name: id, artist: 'Artist' },
      songs: [song(id === 'al-1' ? 't1' : 't9')],
    }));

    await syncPinnedArtistIfNeeded('art-1', 'srv-a');

    expect(useOfflineStore.getState().albums['a.test:al-2']).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/media/library/a.test/a/al-2/t2.mp3' }),
    );
    expect(useLocalPlaybackStore.getState().entries['a.test:t2']).toBeUndefined();
  });

  it('auto-downloads a new album when the full discography scope was pinned', async () => {
    seedArtistAlbumPin('al-1', 't1');
    seedArtistAlbumPin('al-2', 't2');
    getArtistForServerMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Artist' },
      albums: [
        { id: 'al-1', name: 'One', artist: 'Artist' },
        { id: 'al-2', name: 'Two', artist: 'Artist' },
        { id: 'al-3', name: 'Three', artist: 'Artist' },
      ],
    });
    getAlbumForServerMock.mockImplementation(async (_sid: string, id: string) => ({
      album: { id, name: id, artist: 'Artist' },
      songs: [song(`track-${id}`)],
    }));

    await syncPinnedArtistIfNeeded('art-1', 'srv-a', ['al-1', 'al-2']);

    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        albumId: 'al-3',
        type: 'artist',
        artistProgressGroupId: 'art-1',
      }),
    );
  });
});

describe('syncAllPinnedPlaylists', () => {
  beforeEach(() => {
    isReachableMock.mockReturnValue(true);
    getPlaylistMock.mockReset();
    enqueueMock.mockReset();
    useOfflineJobStoreReset();
    useOfflineStore.setState({
      albums: {
        'b.test:pl-b': {
          id: 'pl-b',
          serverId: 'b.test',
          name: 'Remote mix',
          artist: '',
          trackIds: ['tb1'],
          type: 'playlist',
        },
      },
    });
    useAuthStore.setState({
      activeServerId: 'srv-a',
      servers: [
        { id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
        { id: 'srv-b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
      ],
    });
    getPlaylistMock.mockResolvedValue({
      playlist: { id: 'pl-b', name: 'Remote mix', songCount: 1 },
      songs: [song('tb2')],
    });
  });

  it('fetches each cached playlist from its owning server, not the active server', async () => {
    await syncAllPinnedPlaylists();
    expect(getPlaylistMock).toHaveBeenCalledWith('srv-b', 'pl-b');
    expect(useOfflineStore.getState().albums['b.test:pl-b']?.trackIds).toEqual(['tb2']);
  });
});

describe('schedulePinnedPlaylistSync dedupe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isReachableMock.mockReturnValue(true);
    getPlaylistMock.mockReset();
    enqueueMock.mockReset();
    useOfflineJobStoreReset();
    useOfflineStore.setState({
      albums: {
        'a.test:pl-1': {
          id: 'pl-1',
          serverId: 'a.test',
          name: 'Road mix',
          artist: '',
          trackIds: ['t1'],
          type: 'playlist',
        },
      },
    });
    seedAuth();
    getPlaylistMock.mockResolvedValue({
      playlist: { id: 'pl-1', name: 'Road mix', songCount: 1 },
      songs: [song('t1')],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces duplicate schedule calls in one debounce window', async () => {
    schedulePinnedPlaylistSync('pl-1');
    schedulePinnedPlaylistSync('pl-1');
    await vi.advanceTimersByTimeAsync(700);
    expect(getPlaylistMock).toHaveBeenCalledTimes(1);
  });
});

function useOfflineJobStoreReset(): void {
  useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
}
