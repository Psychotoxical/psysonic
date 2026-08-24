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

  it('clears native cancellation only after the cancelled download settles', async () => {
    let resolveDownload!: (value: {
      path: string;
      size: number;
      layoutFingerprint: string;
      originalBytesVerified: boolean;
    }) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'download_track_local') {
        return new Promise(resolve => {
          resolveDownload = resolve;
        });
      }
      return Promise.resolve({});
    });

    onFavoritesOfflineStarChange('t1', 'song', true, 'srv-a');
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf('function'));
    const downloadId = useOfflineJobStore.getState().jobs[0]?.downloadId;
    expect(downloadId).toBeTruthy();

    onFavoritesOfflineStarChange('t1', 'song', false, 'srv-a');
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('cancel_offline_downloads', {
      downloadIds: [downloadId],
    });
    expect(invokeMock).not.toHaveBeenCalledWith('clear_offline_cancel', {
      downloadId,
    });

    resolveDownload({
      path: '/media/favorites/t1.mp3',
      size: 123,
      layoutFingerprint: 'layout',
      originalBytesVerified: true,
    });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'clear_offline_cancel',
      { downloadId },
    ));
  });

  it('drains cancellation requests added while finalization is waiting', async () => {
    let resolveDownload!: (value: {
      path: string;
      size: number;
      layoutFingerprint: string;
      originalBytesVerified: boolean;
    }) => void;
    const releaseCancellations: Array<() => void> = [];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'download_track_local') {
        return new Promise(resolve => {
          resolveDownload = resolve;
        });
      }
      if (cmd === 'cancel_offline_downloads') {
        return new Promise(resolve => {
          releaseCancellations.push(() => resolve({}));
        });
      }
      return Promise.resolve({});
    });

    onFavoritesOfflineStarChange('t1', 'song', true, 'srv-a');
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf('function'));
    const downloadId = useOfflineJobStore.getState().jobs[0]?.downloadId;
    expect(downloadId).toBeTruthy();

    onFavoritesOfflineStarChange('t1', 'song', false, 'srv-a');
    await vi.waitFor(() => expect(releaseCancellations).toHaveLength(1));
    resolveDownload({
      path: '/media/favorites/t1.mp3',
      size: 123,
      layoutFingerprint: 'layout',
      originalBytesVerified: true,
    });
    await Promise.resolve();

    useOfflineJobStore.setState({
      jobs: [{
        trackId: 't1',
        albumId: FAVORITES_OFFLINE_JOB_ID,
        albumName: 'Favorites',
        trackTitle: 'T',
        trackIndex: 0,
        totalTracks: 1,
        status: 'downloading',
        downloadId: downloadId!,
      }],
    });
    onFavoritesOfflineStarChange('t1', 'song', false, 'srv-a');
    await vi.waitFor(() => expect(releaseCancellations).toHaveLength(2));

    releaseCancellations[0]();
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalledWith('clear_offline_cancel', { downloadId });

    releaseCancellations[1]();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'clear_offline_cancel',
      { downloadId },
    ));
  });

  it('does not let a stale batch remove jobs from its replacement generation', async () => {
    getStarredForServerMock
      .mockResolvedValueOnce({
        artists: [],
        albums: [],
        songs: [song('t1'), song('t2'), song('t3')],
      })
      .mockResolvedValueOnce({ artists: [], albums: [], songs: [song('t4')] });
    const resolvers = new Map<string, (value: {
      path: string;
      size: number;
      layoutFingerprint: string;
      originalBytesVerified: boolean;
    }) => void>();
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd !== 'download_track_local') return Promise.resolve({});
      const trackId = (args as { trackId: string }).trackId;
      return new Promise(resolve => resolvers.set(trackId, resolve));
    });

    onFavoritesOfflineStarChange('t1', 'song', true, 'srv-a');
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect([...resolvers.keys()].sort()).toEqual(['t1', 't2']));
    const firstDownloadId = useOfflineJobStore.getState().jobs[0]?.downloadId;

    onFavoritesOfflineStarChange('t4', 'song', true, 'srv-a');
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(resolvers.has('t4')).toBe(true));
    const replacementDownloadId = useOfflineJobStore.getState().jobs
      .find(job => job.trackId === 't4')?.downloadId;
    expect(replacementDownloadId).not.toBe(firstDownloadId);

    for (const trackId of ['t1', 't2']) {
      resolvers.get(trackId)?.({
        path: `/media/favorites/${trackId}.mp3`,
        size: 123,
        layoutFingerprint: 'layout',
        originalBytesVerified: true,
      });
    }
    await vi.waitFor(() => expect(useOfflineJobStore.getState().jobs).toContainEqual(
      expect.objectContaining({ trackId: 't4', downloadId: replacementDownloadId }),
    ));

    resolvers.get('t4')?.({
      path: '/media/favorites/t4.mp3',
      size: 123,
      layoutFingerprint: 'layout',
      originalBytesVerified: true,
    });
  });

  it('waits for an in-flight orphan prune before deciding a re-star is cached', async () => {
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 't1',
      localPath: '/media/favorites/t1.mp3',
      sizeBytes: 123,
      layoutFingerprint: 'layout',
      tier: 'favorite-auto',
      suffix: 'mp3',
      originalBytesVerified: true,
    });
    getStarredForServerMock
      .mockResolvedValueOnce({ artists: [], albums: [], songs: [] })
      .mockResolvedValueOnce({ artists: [], albums: [], songs: [song('t1')] });
    let releaseDelete!: () => void;
    let resolveDownload!: (value: {
      path: string;
      size: number;
      layoutFingerprint: string;
      originalBytesVerified: boolean;
    }) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'delete_media_file') {
        return new Promise(resolve => {
          releaseDelete = () => resolve({ status: 'ok', data: null });
        });
      }
      if (cmd === 'download_track_local') {
        return new Promise(resolve => {
          resolveDownload = resolve;
        });
      }
      return Promise.resolve({});
    });

    onFavoritesOfflineStarChange('t1', 'song', false, 'srv-a');
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(releaseDelete).toBeTypeOf('function'));

    onFavoritesOfflineStarChange('t1', 'song', true, 'srv-a');
    await vi.advanceTimersByTimeAsync(700);
    expect(resolveDownload).not.toBeTypeOf('function');

    releaseDelete();
    await vi.waitFor(() => expect(resolveDownload).toBeTypeOf('function'));
    resolveDownload({
      path: '/media/favorites/t1.mp3',
      size: 123,
      layoutFingerprint: 'layout',
      originalBytesVerified: true,
    });
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
