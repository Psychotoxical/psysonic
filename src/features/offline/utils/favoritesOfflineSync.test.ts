import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import { FAVORITES_OFFLINE_JOB_ID } from '@/features/offline/utils/favoritesOfflineConstants';
import {
  mergeStarredSongsUnion,
  onFavoritesOfflineStarChange,
} from '@/features/offline/utils/favoritesOfflineSync';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';

const getStarredForServerMock = vi.fn(async (_serverId: string) => ({
  artists: [],
  albums: [],
  songs: [{ id: 't1', title: 'T', artist: 'A', album: 'Al', albumId: 'al-1', duration: 1 }],
}));

const isActiveServerReachableMock = vi.fn(() => true);
const buildOriginalStreamUrlForServerMock = vi.hoisted(() => vi.fn(
  (serverId: string, trackId: string) => `https://original.test/${serverId}/${trackId}`,
));

vi.mock('@/lib/network/activeServerReachability', () => ({
  isActiveServerReachable: () => isActiveServerReachableMock(),
}));

vi.mock('@/lib/api/subsonicStarRating', () => ({
  getStarredForServer: (serverId: string) => getStarredForServerMock(serverId),
}));

vi.mock('@/lib/api/subsonicStreamUrl', () => ({
  buildOriginalStreamUrlForServer: buildOriginalStreamUrlForServerMock,
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getAlbumForServer: vi.fn(async () => ({ songs: [] })),
}));

vi.mock('@/lib/api/subsonicArtists', () => ({
  getArtistForServer: vi.fn(async () => ({ albums: [] })),
}));

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown) => ({}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

function song(id: string): SubsonicSong {
  return {
    id,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Album',
    albumId: 'al-1',
    duration: 180,
  };
}

describe('onFavoritesOfflineStarChange', () => {
  beforeEach(() => {
    deactivateCanonicalNavidromeOwners(['srv-a', 'a.test', 'srv-b', 'b.test']);
    vi.useFakeTimers();
    isActiveServerReachableMock.mockReturnValue(true);
    getStarredForServerMock.mockClear();
    invokeMock.mockClear();
    invokeMock.mockImplementation(async () => ({}));
    buildOriginalStreamUrlForServerMock.mockClear();
    useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
    useLocalPlaybackStore.setState({ entries: {} });
    useAuthStore.setState({
      favoritesOfflineEnabled: true,
      activeServerId: 'srv-a',
      servers: [
        { id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
        { id: 'srv-b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not schedule sync while the active server is unreachable', async () => {
    isActiveServerReachableMock.mockReturnValue(false);
    onFavoritesOfflineStarChange('t1', 'song', true, 'srv-b');
    await vi.advanceTimersByTimeAsync(700);
    expect(getStarredForServerMock).not.toHaveBeenCalled();
  });

  it('schedules sync for the explicit server, not only the active one', async () => {
    onFavoritesOfflineStarChange('t1', 'song', true, 'srv-b');
    await vi.advanceTimersByTimeAsync(700);
    expect(getStarredForServerMock).toHaveBeenCalledWith('srv-b');
    expect(getStarredForServerMock).not.toHaveBeenCalledWith('srv-a');
  });

  it('downloads favorite tracks with the shared original-stream URL', async () => {
    invokeMock.mockImplementation(async (cmd: string) => cmd === 'download_track_local'
      ? {
        path: '/media/favorites/t1.mp3',
        size: 123,
        layoutFingerprint: 'layout',
        originalBytesVerified: true,
      }
      : {});

    onFavoritesOfflineStarChange('t1', 'song', true, 'srv-b');
    await vi.advanceTimersByTimeAsync(700);

    expect(buildOriginalStreamUrlForServerMock).toHaveBeenCalledWith('srv-b', 't1');
    expect(invokeMock).toHaveBeenCalledWith(
      'download_track_local',
      expect.objectContaining({ url: 'https://original.test/srv-b/t1' }),
    );
    expect(useLocalPlaybackStore.getState().getEntry('t1', 'b.test')?.originalBytesVerified)
      .toBe(true);
  });

  it('aborts in-flight favorites Rust downloads when a star change reschedules sync', async () => {
    useOfflineJobStore.setState({
      jobs: [{
        trackId: 't1',
        albumId: FAVORITES_OFFLINE_JOB_ID,
        albumName: 'Favorites',
        trackTitle: 'T',
        trackIndex: 0,
        totalTracks: 1,
        status: 'downloading',
        downloadId: 'favorites-111',
      }],
      pinQueue: [],
      bulkProgress: {},
    });
    onFavoritesOfflineStarChange('t2', 'song', false, 'srv-a');
    expect(invokeMock).toHaveBeenCalledWith(
      'cancel_offline_downloads',
      { downloadIds: ['favorites-111'] },
    );
    expect(useOfflineJobStore.getState().jobs).toEqual([]);
  });

  it('does not prune canonical favorites from a stale starred response', async () => {
    const legacyTrackId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const canonicalTrackId = canonicalizeNavidromeId(legacyTrackId);
    let resolveStarred!: (value: { artists: []; albums: []; songs: [] }) => void;
    getStarredForServerMock.mockImplementationOnce(() => new Promise(resolve => {
      resolveStarred = resolve;
    }));
    useLocalPlaybackStore.setState({
      entries: {
        [`a.test:${legacyTrackId}`]: {
          serverIndexKey: 'a.test',
          trackId: legacyTrackId,
          localPath: `/media/${legacyTrackId}.flac`,
          layoutFingerprint: 'legacy',
          sizeBytes: 1,
          tier: 'favorite-auto',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });

    onFavoritesOfflineStarChange(legacyTrackId, 'song', false, 'srv-a');
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(getStarredForServerMock).toHaveBeenCalledWith('srv-a'));

    activateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    useLocalPlaybackStore.setState({
      entries: {
        [`a.test:${canonicalTrackId}`]: {
          serverIndexKey: 'a.test',
          trackId: canonicalTrackId,
          localPath: `/media/${canonicalTrackId}.flac`,
          layoutFingerprint: 'canonical',
          sizeBytes: 1,
          tier: 'favorite-auto',
          cachedAt: 1,
          suffix: 'flac',
        },
      },
    });
    resolveStarred({ artists: [], albums: [], songs: [] });
    await vi.runAllTimersAsync();

    expect(invokeMock).not.toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: `/media/${canonicalTrackId}.flac` }),
    );
    expect(useLocalPlaybackStore.getState().entries[`a.test:${canonicalTrackId}`]).toBeDefined();
  });

  it('deletes a stale download result when identity changes in flight', async () => {
    const legacyTrackId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const localPath = `/media/${legacyTrackId}.flac`;
    let resolveDownload!: (value: {
      path: string;
      size: number;
      layoutFingerprint: string;
      originalBytesVerified: boolean;
    }) => void;
    getStarredForServerMock.mockResolvedValueOnce({
      artists: [],
      albums: [],
      songs: [song(legacyTrackId)],
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'download_track_local') {
        return new Promise(resolve => { resolveDownload = resolve; });
      }
      return Promise.resolve({});
    });

    onFavoritesOfflineStarChange(legacyTrackId, 'song', true, 'srv-a');
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'download_track_local',
      expect.objectContaining({ trackId: legacyTrackId }),
    ));

    activateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    resolveDownload({
      path: localPath,
      size: 1,
      layoutFingerprint: 'legacy',
      originalBytesVerified: true,
    });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath }),
    ));

    expect(useLocalPlaybackStore.getState().entries).toEqual({});
  });

  it('stops pruning when a newer favorites run cancels the current one', async () => {
    let resolveDelete!: () => void;
    getStarredForServerMock.mockResolvedValueOnce({ artists: [], albums: [], songs: [] });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'delete_media_file') {
        return new Promise(resolve => { resolveDelete = () => resolve({}); });
      }
      return Promise.resolve({});
    });
    useLocalPlaybackStore.setState({
      entries: Object.fromEntries(['t1', 't2'].map(id => [`a.test:${id}`, {
        serverIndexKey: 'a.test',
        trackId: id,
        localPath: `/media/${id}.flac`,
        layoutFingerprint: id,
        sizeBytes: 1,
        tier: 'favorite-auto' as const,
        cachedAt: 1,
        suffix: 'flac',
      }])),
    });

    onFavoritesOfflineStarChange('t1', 'song', false, 'srv-a');
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/media/t1.flac' }),
    ));

    onFavoritesOfflineStarChange('t2', 'song', true, 'srv-a');
    resolveDelete();
    await vi.waitFor(() => {
    expect(useLocalPlaybackStore.getState().entries['a.test:t1']).toBeDefined();
    });

    expect(useLocalPlaybackStore.getState().entries['a.test:t2']).toBeDefined();
    expect(invokeMock).not.toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/media/t2.flac' }),
    );
  });
});

describe('mergeStarredSongsUnion', () => {
  it('dedupes the same track from direct song, album, and artist stars', () => {
    const shared = song('t-shared');
    const union = mergeStarredSongsUnion(
      [shared, song('t-solo')],
      [[shared, song('t-album-only')]],
      [[shared, song('t-artist-only')]],
    );
    expect(union.map(s => s.id).sort()).toEqual([
      't-album-only',
      't-artist-only',
      't-shared',
      't-solo',
    ]);
  });

  it('returns empty when nothing is starred', () => {
    expect(mergeStarredSongsUnion([], [], [])).toEqual([]);
  });
});
