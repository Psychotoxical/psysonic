import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { useOfflineJobStore } from '../../store/offlineJobStore';
import { useOfflineStore } from '../../store/offlineStore';
import {
  isManualOfflinePlaylist,
  isPlaylistPinnedOffline,
  isSourcePinnedOffline,
  schedulePinnedAlbumSync,
  schedulePinnedPlaylistSync,
  scheduleSyncPinnedAlbumsAndArtists,
} from './pinnedOfflineSync';
import { SMART_PREFIX } from '../componentHelpers/playlistDetailHelpers';

const getPlaylistMock = vi.fn();
const getAlbumForServerMock = vi.fn();
const filterSongsMock = vi.fn(async (songs: SubsonicSong[]) => songs);
const isReachableMock = vi.fn(() => true);
const enqueueMock = vi.fn((_task: unknown) => true);
const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => ({}));

vi.mock('../network/activeServerReachability', () => ({
  isActiveServerReachable: () => isReachableMock(),
  onActiveServerBecameReachable: () => () => {},
}));

vi.mock('../../api/subsonicPlaylists', () => ({
  getPlaylist: (id: string) => getPlaylistMock(id),
}));

vi.mock('../../api/subsonicLibrary', () => ({
  getAlbumForServer: (serverId: string, id: string) => getAlbumForServerMock(serverId, id),
  filterSongsToServerLibrary: (songs: SubsonicSong[]) => filterSongsMock(songs),
}));

vi.mock('../../api/library', () => ({
  libraryGetTracksByAlbum: vi.fn(async () => []),
  subscribeLibrarySyncIdle: vi.fn(async () => () => {}),
}));

vi.mock('./offlinePinQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./offlinePinQueue')>();
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

    expect(getPlaylistMock).toHaveBeenCalledWith('pl-1');
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
});

function useOfflineJobStoreReset(): void {
  useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
}
