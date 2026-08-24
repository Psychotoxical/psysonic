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
  initPinnedOfflineSync,
  schedulePinnedAlbumSync,
  schedulePinnedPlaylistSync,
  scheduleSyncPinnedAlbumsAndArtists,
  syncAllPinnedPlaylists,
  syncPinnedArtistIfNeeded,
  syncPinnedPlaylistIfNeeded,
} from '@/features/offline/utils/pinnedOfflineSync';
import { SMART_PREFIX } from '@/lib/format/playlistDetailHelpers';
import { cancelAllOfflinePins } from '@/features/offline/utils/offlinePinQueue';

const getPlaylistMock = vi.fn();
const getAlbumForServerMock = vi.fn();
const getArtistForServerMock = vi.fn();
const filterSongsMock = vi.fn(async (songs: SubsonicSong[]) => songs);
const isReachableMock = vi.fn(() => true);
const enqueueMock = vi.fn((_task: unknown) => true);
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => ({}));

afterEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
});

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
  subscribeLibrarySyncIdle: vi.fn(async () => () => {}),
}));

vi.mock('@/features/offline/utils/offlinePinQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/offline/utils/offlinePinQueue')>();
  return {
    ...actual,
    enqueueOfflinePin: (task: unknown) => enqueueMock(task),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
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

  it('does not resurrect a pin deleted while reconciliation is fetching', async () => {
    let resolvePlaylist!: (value: {
      playlist: { id: string; name: string; songCount: number };
      songs: SubsonicSong[];
    }) => void;
    getPlaylistMock.mockImplementation(() => new Promise(resolve => {
      resolvePlaylist = resolve;
    }));

    const sync = syncPinnedPlaylistIfNeeded('pl-1', 'srv-a');
    await vi.waitFor(() => expect(resolvePlaylist).toBeTypeOf('function'));
    await useOfflineStore.getState().deleteAlbum('pl-1', 'srv-a');
    resolvePlaylist({
      playlist: { id: 'pl-1', name: 'Road mix', songCount: 1 },
      songs: [song('t2')],
    });
    await sync;

    expect(useOfflineStore.getState().albums['a.test:pl-1']).toBeUndefined();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('ignores an older reconciliation response that completes last', async () => {
    const resolvers: Array<(value: {
      playlist: { id: string; name: string; songCount: number };
      songs: SubsonicSong[];
    }) => void> = [];
    getPlaylistMock.mockImplementation(() => new Promise(resolve => {
      resolvers.push(resolve);
    }));

    const older = syncPinnedPlaylistIfNeeded('pl-1', 'srv-a');
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const newer = syncPinnedPlaylistIfNeeded('pl-1', 'srv-a');
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.({
      playlist: { id: 'pl-1', name: 'Newest', songCount: 1 },
      songs: [song('t2')],
    });
    await newer;
    resolvers[0]?.({
      playlist: { id: 'pl-1', name: 'Stale', songCount: 1 },
      songs: [song('t3')],
    });
    await older;

    expect(useOfflineStore.getState().albums['a.test:pl-1']?.name).toBe('Newest');
    expect(useOfflineStore.getState().albums['a.test:pl-1']?.trackIds).toEqual(['t2']);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({ songs: [expect.objectContaining({ id: 't2' })] }),
    );
  });

  it('does not resurrect a pin when reconciliation starts during deletion', async () => {
    let releaseDeletion!: () => void;
    invokeMock.mockImplementation((command: string) => {
      if (command !== 'delete_media_file') return Promise.resolve({});
      return new Promise<object>(resolve => {
        releaseDeletion = () => resolve({});
      });
    });

    const deletion = useOfflineStore.getState().deleteAlbum('pl-1', 'srv-a');
    await vi.waitFor(() => expect(releaseDeletion).toBeTypeOf('function'));
    const sync = syncPinnedPlaylistIfNeeded('pl-1', 'srv-a');
    releaseDeletion();
    await Promise.all([deletion, sync]);

    expect(useOfflineStore.getState().albums['a.test:pl-1']).toBeUndefined();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('does not remove a track entry reassigned while prune deletion is pending', async () => {
    let releaseDeletion!: () => void;
    invokeMock.mockImplementation((command: string) => {
      if (command !== 'delete_media_file') return Promise.resolve({});
      return new Promise<object>(resolve => {
        releaseDeletion = () => resolve({});
      });
    });

    const sync = syncPinnedPlaylistIfNeeded('pl-1', 'srv-a');
    await vi.waitFor(() => expect(releaseDeletion).toBeTypeOf('function'));
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 't1',
      localPath: '/media/library/a.test/new/t1.mp3',
      layoutFingerprint: 'new',
      sizeBytes: 1000,
      tier: 'library',
      suffix: 'mp3',
      pinSource: { kind: 'album', sourceId: 'al-2' },
    });
    releaseDeletion();
    await sync;

    expect(useLocalPlaybackStore.getState().getEntry('t1', 'a.test')?.pinSource?.sourceId)
      .toBe('al-2');
    expect(useLocalPlaybackStore.getState().getEntry('t1', 'a.test')?.localPath)
      .toContain('/new/t1.mp3');
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

  it('does not enqueue artist reconciliation that was awaiting cancel-all', async () => {
    seedArtistAlbumPin('al-1', 't1');
    let resolveArtist!: (value: {
      artist: { id: string; name: string };
      albums: Array<{ id: string; name: string; artist: string }>;
    }) => void;
    getArtistForServerMock.mockImplementation(() => new Promise(resolve => {
      resolveArtist = resolve;
    }));

    const sync = syncPinnedArtistIfNeeded('art-1', 'srv-a');
    await vi.waitFor(() => expect(resolveArtist).toBeTypeOf('function'));
    cancelAllOfflinePins();
    resolveArtist({
      artist: { id: 'art-1', name: 'Artist' },
      albums: [{ id: 'al-1', name: 'One', artist: 'Artist' }],
    });
    await sync;

    expect(getAlbumForServerMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('stops pruning remaining artist tracks after cancel-all', async () => {
    seedArtistAlbumPin('al-1', 't1');
    useOfflineStore.setState(state => ({
      albums: {
        ...state.albums,
        'a.test:al-1': {
          ...state.albums['a.test:al-1'],
          trackIds: ['t1', 't2'],
        },
      },
    }));
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 't2',
      localPath: '/media/library/a.test/a/al-1/t2.mp3',
      layoutFingerprint: 'fp',
      sizeBytes: 1000,
      tier: 'library',
      suffix: 'mp3',
      pinSource: { kind: 'artist', sourceId: 'al-1' },
    });
    getArtistForServerMock.mockResolvedValue({
      artist: { id: 'art-1', name: 'Artist' },
      albums: [],
    });
    let releaseFirstDelete!: () => void;
    let deleteCalls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== 'delete_media_file') return {};
      deleteCalls += 1;
      if (deleteCalls === 1) {
        await new Promise<void>(resolve => {
          releaseFirstDelete = resolve;
        });
      }
      return {};
    });

    const sync = syncPinnedArtistIfNeeded('art-1', 'srv-a');
    await vi.waitFor(() => expect(releaseFirstDelete).toBeTypeOf('function'));
    cancelAllOfflinePins();
    releaseFirstDelete();
    await sync;

    expect(deleteCalls).toBe(1);
    expect(useLocalPlaybackStore.getState().getEntry('t2', 'a.test')).not.toBeNull();
    expect(useOfflineStore.getState().albums['a.test:al-1']).toBeDefined();
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

  it('does not start the next playlist after the sync lifecycle is disposed', async () => {
    useOfflineStore.setState(state => ({
      albums: {
        ...state.albums,
        'b.test:pl-c': {
          id: 'pl-c',
          serverId: 'b.test',
          name: 'Second mix',
          artist: '',
          trackIds: ['tc1'],
          type: 'playlist',
        },
      },
    }));
    let resolveFirst!: (value: {
      playlist: { id: string; name: string; songCount: number };
      songs: SubsonicSong[];
    }) => void;
    getPlaylistMock.mockImplementationOnce(() => new Promise(resolve => {
      resolveFirst = resolve;
    }));
    const dispose = initPinnedOfflineSync();
    const sync = syncAllPinnedPlaylists();
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'));

    dispose();
    resolveFirst({
      playlist: { id: 'pl-b', name: 'Remote mix', songCount: 1 },
      songs: [song('tb2')],
    });
    await sync;

    expect(getPlaylistMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).not.toHaveBeenCalled();
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

  it('discards scheduled reconciliation from before cancel-all', async () => {
    schedulePinnedPlaylistSync('pl-1');
    cancelAllOfflinePins();

    await vi.advanceTimersByTimeAsync(700);

    expect(getPlaylistMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

function useOfflineJobStoreReset(): void {
  useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
}
