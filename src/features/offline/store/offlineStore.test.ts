import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import {
  localPlaybackPinSources,
  useLocalPlaybackStore,
} from '@/store/localPlaybackStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';
import { cancelledDownloads, useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import {
  cancelAllOfflinePins,
  clearOfflinePinTasks,
  dequeueOfflinePin,
} from '@/features/offline/utils/offlinePinQueue';
import { runOfflineTrackCleanup } from '@/features/offline/utils/offlineOperationCoordinator';

const mocks = vi.hoisted(() => ({
  buildOriginalStreamUrlForServer: vi.fn(
    (serverId: string, trackId: string) => `https://original.test/${serverId}/${trackId}`,
  ),
  libraryUpsertSongsFromApi: vi.fn(async () => undefined),
  getAlbumForServer: vi.fn(),
  getArtistForServer: vi.fn(),
}));

vi.mock('@/lib/api/subsonicStreamUrl', () => ({
  buildOriginalStreamUrlForServer: mocks.buildOriginalStreamUrlForServer,
}));

vi.mock('@/lib/api/library', () => ({
  libraryUpsertSongsFromApi: mocks.libraryUpsertSongsFromApi,
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  getAlbumForServer: mocks.getAlbumForServer,
}));

vi.mock('@/lib/api/subsonicArtists', () => ({
  getArtistForServer: mocks.getArtistForServer,
}));

import { useOfflineStore } from '@/features/offline/store/offlineStore';

const SONG: SubsonicSong = {
  id: 'track-1',
  title: 'Track 1',
  artist: 'Artist',
  album: 'Album',
  albumId: 'album-1',
  duration: 180,
  suffix: 'flac',
};

const SONG_2: SubsonicSong = {
  ...SONG,
  id: 'track-2',
  title: 'Track 2',
};

const SONG_3: SubsonicSong = {
  ...SONG,
  id: 'track-3',
  title: 'Track 3',
};

const SONG_4: SubsonicSong = {
  ...SONG,
  id: 'track-4',
  title: 'Track 4',
};

function downloadResult(trackId: string) {
  return {
    path: `/media/library/a.test/${trackId}.flac`,
    size: 456,
    layoutFingerprint: 'layout',
    originalBytesVerified: false,
  };
}

beforeEach(() => {
  resetAuthStore();
  clearOfflinePinTasks();
  cancelledDownloads.clear();
  useOfflineStore.setState({ albums: {} });
  useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
  useLocalPlaybackStore.setState({ entries: {} });
  useAuthStore.setState({
    activeServerId: 'srv-a',
    servers: [{
      id: 'srv-a',
      name: 'A',
      url: 'https://a.test',
      username: 'u',
      password: 'p',
    }],
  });
  mocks.buildOriginalStreamUrlForServer.mockClear();
  mocks.libraryUpsertSongsFromApi.mockClear();
  mocks.getAlbumForServer.mockReset();
  mocks.getArtistForServer.mockReset();
  onInvoke('download_track_local', () => ({
    path: '/media/library/a.test/track-1.flac',
    size: 456,
    layoutFingerprint: 'layout',
    originalBytesVerified: false,
  }));
  onInvoke('clear_offline_cancel', () => undefined);
  onInvoke('cancel_offline_downloads', () => undefined);
  onInvoke('delete_media_file', () => ({ status: 'ok', data: null }));
});

describe('offlineStore download producer', () => {
  it('passes the shared original-stream URL to the native downloader', async () => {
    await useOfflineStore.getState().downloadAlbum(
      'album-1',
      'Album',
      'Artist',
      undefined,
      undefined,
      [SONG],
      'srv-a',
    );

    await waitFor(() => expect(mocks.buildOriginalStreamUrlForServer)
      .toHaveBeenCalledWith('srv-a', 'track-1'));
    expect(invokeMock).toHaveBeenCalledWith(
      'download_track_local',
      expect.objectContaining({ url: 'https://original.test/srv-a/track-1' }),
    );
  });

  it('uses a unique native download id for same-millisecond retries', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1234);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const downloadIds: string[] = [];
    onInvoke('download_track_local', args => {
      downloadIds.push((args as { downloadId: string }).downloadId);
      throw new Error('retry');
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(downloadIds).toHaveLength(2));

    expect(new Set(downloadIds).size).toBe(2);
    consoleError.mockRestore();
    now.mockRestore();
  });

  it('refreshes an unverified legacy Navidrome pin and persists native verification', async () => {
    useAuthStore.setState({
      subsonicServerIdentityByServer: { 'srv-a': { type: 'navidrome' } },
    });
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 'track-1',
      localPath: '/media/library/a.test/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'legacy',
      tier: 'library',
      pinSource: { kind: 'album', sourceId: 'album-1' },
      suffix: 'flac',
      originalBytesVerified: false,
    });
    onInvoke('download_track_local', () => ({
      path: '/media/library/a.test/track-1.flac',
      size: 456,
      layoutFingerprint: 'layout',
      originalBytesVerified: true,
    }));

    await useOfflineStore.getState().downloadAlbum(
      'album-1',
      'Album',
      'Artist',
      undefined,
      undefined,
      [SONG],
      'srv-a',
    );

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'download_track_local',
      expect.any(Object),
    ));
    await waitFor(() => expect(
      useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.originalBytesVerified,
    ).toBe(true));
  });

  it('does not reassign existing local tracks when cancelled during library preflight', async () => {
    let releaseUpsert!: () => void;
    mocks.libraryUpsertSongsFromApi.mockImplementationOnce(() => new Promise<undefined>(resolve => {
      releaseUpsert = () => resolve(undefined);
    }));
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 'track-1',
      localPath: '/media/library/a.test/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'layout',
      tier: 'library',
      pinSource: { kind: 'album', sourceId: 'other-album' },
      suffix: 'flac',
      originalBytesVerified: true,
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1',
      'Album',
      'Artist',
      undefined,
      undefined,
      [SONG],
      'srv-a',
    );
    await waitFor(() => expect(mocks.libraryUpsertSongsFromApi).toHaveBeenCalled());
    expect(dequeueOfflinePin('album-1', 'srv-a')).toBe(true);
    releaseUpsert();

    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.pinSource?.sourceId)
      .toBe('other-album');
    expect(useOfflineStore.getState().albums['a.test:album-1']).toBeUndefined();
  });

  it('does not reassign existing local tracks when cancelled behind cleanup', async () => {
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 'track-1',
      localPath: '/media/library/a.test/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'layout',
      tier: 'library',
      pinSource: { kind: 'album', sourceId: 'other-album' },
      suffix: 'flac',
      originalBytesVerified: true,
    });
    let releaseCleanup!: () => void;
    const cleanup = runOfflineTrackCleanup(
      'a.test',
      'track-1',
      () => new Promise<void>(resolve => {
        releaseCleanup = resolve;
      }),
    );
    await waitFor(() => expect(releaseCleanup).toBeTypeOf('function'));

    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    expect(dequeueOfflinePin('album-1', 'srv-a')).toBe(true);
    releaseCleanup();
    await cleanup;

    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.pinSource?.sourceId)
      .toBe('other-album');
    expect(useOfflineStore.getState().albums['a.test:album-1']).toBeUndefined();
  });

  it('limits track concurrency and publishes each completed track immediately', async () => {
    let resolveFirst!: (value: ReturnType<typeof downloadResult>) => void;
    let resolveSecond!: (value: ReturnType<typeof downloadResult>) => void;
    let resolveThird!: (value: ReturnType<typeof downloadResult>) => void;
    const first = new Promise<ReturnType<typeof downloadResult>>(resolve => {
      resolveFirst = resolve;
    });
    const second = new Promise<ReturnType<typeof downloadResult>>(resolve => {
      resolveSecond = resolve;
    });
    const third = new Promise<ReturnType<typeof downloadResult>>(resolve => {
      resolveThird = resolve;
    });
    const started: string[] = [];
    onInvoke('download_track_local', (args) => {
      const trackId = (args as { trackId: string }).trackId;
      started.push(trackId);
      if (trackId === 'track-1') return first;
      return trackId === 'track-2' ? second : third;
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1',
      'Album',
      'Artist',
      undefined,
      undefined,
      [SONG, SONG_2, SONG_3],
      'srv-a',
    );

    await waitFor(() => expect(started).toEqual(['track-1', 'track-2']));
    expect(useOfflineJobStore.getState().jobs.find(j => j.trackId === 'track-3')?.status)
      .toBe('queued');

    resolveFirst(downloadResult('track-1'));
    await waitFor(() => expect(started).toEqual(['track-1', 'track-2', 'track-3']));
    expect(useOfflineJobStore.getState().jobs.map(j => [j.trackId, j.status])).toEqual([
      ['track-1', 'done'],
      ['track-2', 'downloading'],
      ['track-3', 'downloading'],
    ]);
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.localPath)
      .toContain('track-1.flac');

    resolveSecond(downloadResult('track-2'));
    resolveThird(downloadResult('track-3'));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-2', 'a.test')?.localPath)
      .toContain('track-2.flac');
    expect(useLocalPlaybackStore.getState().getEntry('track-3', 'a.test')?.localPath)
      .toContain('track-3.flac');
  });

  it('shares the track concurrency limit across simultaneous albums', async () => {
    const resolvers = new Map<string, (value: ReturnType<typeof downloadResult>) => void>();
    const started: string[] = [];
    onInvoke('download_track_local', (args) => {
      const trackId = (args as { trackId: string }).trackId;
      started.push(trackId);
      return new Promise<ReturnType<typeof downloadResult>>(resolve => {
        resolvers.set(trackId, resolve);
      });
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1',
      'Album 1',
      'Artist',
      undefined,
      undefined,
      [SONG, SONG_2],
      'srv-a',
    );
    await useOfflineStore.getState().downloadAlbum(
      'album-2',
      'Album 2',
      'Artist',
      undefined,
      undefined,
      [
        { ...SONG_3, album: 'Album 2', albumId: 'album-2' },
        { ...SONG_4, album: 'Album 2', albumId: 'album-2' },
      ],
      'srv-a',
    );

    await waitFor(() => expect(started).toHaveLength(2));
    resolvers.get(started[0])?.(downloadResult(started[0]));
    await waitFor(() => expect(started).toHaveLength(3));
    resolvers.get(started[1])?.(downloadResult(started[1]));
    await waitFor(() => expect(started).toHaveLength(4));
    for (const trackId of started.slice(2)) {
      resolvers.get(trackId)?.(downloadResult(trackId));
    }
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('retries safely when a canonical-key delete races a native completion', async () => {
    let resolveFirst!: (value: ReturnType<typeof downloadResult>) => void;
    let resolveRetry!: (value: ReturnType<typeof downloadResult>) => void;
    const first = new Promise<ReturnType<typeof downloadResult>>(resolve => {
      resolveFirst = resolve;
    });
    const retry = new Promise<ReturnType<typeof downloadResult>>(resolve => {
      resolveRetry = resolve;
    });
    let invocations = 0;
    onInvoke('download_track_local', () => {
      invocations += 1;
      return invocations === 1 ? first : retry;
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1',
      'Album',
      'Artist',
      undefined,
      undefined,
      [SONG],
      'srv-a',
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'download_track_local',
      expect.objectContaining({ trackId: 'track-1' }),
    ));

    await useOfflineStore.getState().deleteAlbum('album-1', 'a.test');
    await useOfflineStore.getState().downloadAlbum(
      'album-1',
      'Album',
      'Artist',
      undefined,
      undefined,
      [SONG],
      'srv-a',
    );
    expect(invocations).toBe(1);

    resolveFirst(downloadResult('track-1'));
    await waitFor(() => expect(invocations).toBe(2));

    expect(invokeMock).not.toHaveBeenCalledWith(
      'download_track_local',
      expect.objectContaining({ trackId: 'track-2' }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/media/library/a.test/track-1.flac' }),
    );
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')).toBeNull();

    resolveRetry(downloadResult('track-1'));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.localPath)
      .toContain('track-1.flac');
    expect(cancelledDownloads.has('srv-a:album-1')).toBe(false);
  });

  it('does not let an old cleanup timer remove a retry job', async () => {
    vi.useFakeTimers();
    try {
      await useOfflineStore.getState().downloadAlbum(
        'album-1',
        'Album',
        'Artist',
        undefined,
        undefined,
        [SONG],
        'srv-a',
      );
      await vi.waitFor(() => {
        expect(useOfflineJobStore.getState().pinQueue).toEqual([]);
        expect(useOfflineJobStore.getState().jobs[0]?.status).toBe('done');
      });
      const firstDownloadId = useOfflineJobStore.getState().jobs[0]?.downloadId;
      useLocalPlaybackStore.setState({ entries: {} });

      let resolveRetry!: (value: ReturnType<typeof downloadResult>) => void;
      const retry = new Promise<ReturnType<typeof downloadResult>>(resolve => {
        resolveRetry = resolve;
      });
      onInvoke('download_track_local', () => retry);
      await useOfflineStore.getState().downloadAlbum(
        'album-1',
        'Album',
        'Artist',
        undefined,
        undefined,
        [SONG],
        'srv-a',
      );
      await vi.waitFor(() => {
        expect(useOfflineJobStore.getState().jobs[0]?.status).toBe('downloading');
        expect(useOfflineJobStore.getState().jobs[0]?.downloadId).not.toBe(firstDownloadId);
      });

      await vi.advanceTimersByTimeAsync(2500);
      expect(useOfflineJobStore.getState().jobs[0]?.status).toBe('downloading');

      resolveRetry(downloadResult('track-1'));
      await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave a cancellation marker when deleting an inactive album', async () => {
    await useOfflineStore.getState().deleteAlbum('album-1', 'a.test');
    expect(cancelledDownloads.has('a.test:album-1')).toBe(false);
    expect(cancelledDownloads.has('srv-a:album-1')).toBe(false);
  });

  it('starts an immediate retry without waiting for the cancelled native invoke', async () => {
    let resolveFirst!: (value: ReturnType<typeof downloadResult>) => void;
    let resolveRetry!: (value: ReturnType<typeof downloadResult>) => void;
    const first = new Promise<ReturnType<typeof downloadResult>>(resolve => {
      resolveFirst = resolve;
    });
    const retry = new Promise<ReturnType<typeof downloadResult>>(resolve => {
      resolveRetry = resolve;
    });
    let invocations = 0;
    onInvoke('download_track_local', () => {
      invocations += 1;
      return invocations === 1 ? first : retry;
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(invocations).toBe(1));

    clearOfflinePinTasks();
    useOfflineJobStore.getState().cancelAllDownloads();
    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(invocations).toBe(2));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')).toBeNull();

    resolveRetry(downloadResult('track-1'));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.localPath)
      .toContain('track-1.flac');

    resolveFirst(downloadResult('track-1'));
    await Promise.resolve();
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.localPath)
      .toContain('track-1.flac');
    expect(invokeMock).not.toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/media/library/a.test/track-1.flac' }),
    );
  });

  it('clears native cancellation only after the request and native invoke settle', async () => {
    let resolveDownload!: (value: ReturnType<typeof downloadResult>) => void;
    let resolveCancellation!: () => void;
    let cancellationCleared = false;
    onInvoke('download_track_local', () => new Promise(resolve => {
      resolveDownload = resolve;
    }));
    onInvoke('cancel_offline_downloads', () => new Promise<void>(resolve => {
      resolveCancellation = resolve;
    }));
    onInvoke('clear_offline_cancel', () => {
      cancellationCleared = true;
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(resolveDownload).toBeTypeOf('function'));

    clearOfflinePinTasks();
    useOfflineJobStore.getState().cancelAllDownloads();
    resolveDownload(downloadResult('track-1'));
    await Promise.resolve();
    expect(cancellationCleared).toBe(false);

    resolveCancellation();
    await waitFor(() => expect(cancellationCleared).toBe(true));
  });

  it('does not let a draining album clear its replacement cancellation', async () => {
    let resolveDownload!: (value: ReturnType<typeof downloadResult>) => void;
    let releaseReplacementPreflight!: () => void;
    const clearedDownloadIds: string[] = [];
    onInvoke('download_track_local', () => new Promise(resolve => {
      resolveDownload = resolve;
    }));
    onInvoke('clear_offline_cancel', args => {
      clearedDownloadIds.push((args as { downloadId: string }).downloadId);
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(resolveDownload).toBeTypeOf('function'));
    cancelAllOfflinePins();

    mocks.libraryUpsertSongsFromApi.mockImplementationOnce(() => new Promise(resolve => {
      releaseReplacementPreflight = () => resolve(undefined);
    }));
    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(releaseReplacementPreflight).toBeTypeOf('function'));
    cancelAllOfflinePins();

    resolveDownload(downloadResult('track-1'));
    await waitFor(() => expect(clearedDownloadIds).toHaveLength(1));
    expect(cancelledDownloads.has('srv-a:album-1')).toBe(true);

    releaseReplacementPreflight();
    await waitFor(() => expect(cancelledDownloads.has('srv-a:album-1')).toBe(false));
  });

  it('retains partial playlist metadata so cancelled downloads can be removed later', async () => {
    const resolvers = new Map<string, (value: ReturnType<typeof downloadResult>) => void>();
    onInvoke('download_track_local', args => new Promise(resolve => {
      const trackId = (args as { trackId: string }).trackId;
      resolvers.set(trackId, resolve);
    }));
    await useOfflineStore.getState().downloadAlbum(
      'playlist-1',
      'Playlist',
      '',
      undefined,
      undefined,
      [SONG, SONG_2],
      'srv-a',
      'playlist',
    );
    await waitFor(() => expect(resolvers.size).toBe(2));

    resolvers.get('track-1')?.(downloadResult('track-1'));
    await waitFor(() => expect(
      useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.pinSource?.sourceId,
    ).toBe('playlist-1'));
    cancelAllOfflinePins();
    resolvers.get('track-2')?.(downloadResult('track-2'));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));

    expect(useOfflineStore.getState().albums['a.test:playlist-1']?.type).toBe('playlist');
    await useOfflineStore.getState().deleteAlbum('playlist-1', 'srv-a');
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')).toBeNull();
    expect(useOfflineStore.getState().albums['a.test:playlist-1']).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('delete_media_file', {
      localPath: '/media/library/a.test/track-1.flac',
      mediaDir: null,
    });
  });

  it('retains partial playlist metadata for legacy UUID-keyed entries', async () => {
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'srv-a',
      trackId: 'track-1',
      localPath: '/media/library/srv-a/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'layout',
      tier: 'library',
      pinSource: { kind: 'playlist', sourceId: 'playlist-1' },
      suffix: 'flac',
      originalBytesVerified: true,
    });
    let resolveDownload!: (value: ReturnType<typeof downloadResult>) => void;
    onInvoke('download_track_local', () => new Promise(resolve => {
      resolveDownload = resolve;
    }));
    await useOfflineStore.getState().downloadAlbum(
      'playlist-1',
      'Playlist',
      '',
      undefined,
      undefined,
      [SONG, SONG_2],
      'srv-a',
      'playlist',
    );
    await waitFor(() => expect(resolveDownload).toBeTypeOf('function'));

    cancelAllOfflinePins();
    resolveDownload(downloadResult('track-2'));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));

    expect(useOfflineStore.getState().albums['a.test:playlist-1']?.type).toBe('playlist');
    await useOfflineStore.getState().deleteAlbum('playlist-1', 'srv-a');
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'srv-a')).toBeNull();
  });

  it('keeps a valid legacy path when cancel-all wins after native completion', async () => {
    useAuthStore.setState({
      subsonicServerIdentityByServer: { 'srv-a': { type: 'navidrome' } },
    });
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 'track-1',
      localPath: '/media/library/a.test/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'legacy',
      tier: 'library',
      pinSource: { kind: 'album', sourceId: 'album-1' },
      suffix: 'flac',
      originalBytesVerified: false,
    });
    let resolveDownload!: (value: ReturnType<typeof downloadResult>) => void;
    onInvoke('download_track_local', () => new Promise(resolve => {
      resolveDownload = resolve;
    }));

    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(resolveDownload).toBeTypeOf('function'));

    clearOfflinePinTasks();
    useOfflineJobStore.getState().cancelAllDownloads();
    resolveDownload({ ...downloadResult('track-1'), originalBytesVerified: true });

    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.localPath)
      .toBe('/media/library/a.test/track-1.flac');
    expect(invokeMock).not.toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/media/library/a.test/track-1.flac' }),
    );
  });

  it('deletes an unclaimed native result when cancel-all wins before publication', async () => {
    useOfflineStore.setState({
      albums: {
        'srv-a:album-1': {
          id: 'album-1',
          serverId: 'srv-a',
          name: 'Legacy Album',
          artist: 'Artist',
          trackIds: ['track-1'],
          type: 'album',
        },
      },
    });
    let resolveDownload!: (value: ReturnType<typeof downloadResult>) => void;
    onInvoke('download_track_local', () => new Promise(resolve => {
      resolveDownload = resolve;
    }));
    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(resolveDownload).toBeTypeOf('function'));

    cancelAllOfflinePins();
    resolveDownload(downloadResult('track-1'));

    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')).toBeNull();
    expect(useOfflineStore.getState().albums['a.test:album-1']).toBeUndefined();
    expect(useOfflineStore.getState().albums['srv-a:album-1']).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith('delete_media_file', {
      localPath: '/media/library/a.test/track-1.flac',
      mediaDir: null,
    });
  });

  it('does not delete a shared track when one concurrent pin is cancelled', async () => {
    const resolvers = new Map<string, (value: ReturnType<typeof downloadResult>) => void>();
    onInvoke('download_track_local', args => new Promise(resolve => {
      const downloadId = (args as { downloadId: string }).downloadId;
      resolvers.set(downloadId.includes('album-1') ? 'album-1' : 'album-2', resolve);
    }));

    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'One', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await useOfflineStore.getState().downloadAlbum(
      'album-2', 'Two', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(resolvers.size).toBe(2));

    await useOfflineStore.getState().deleteAlbum('album-1', 'srv-a');
    resolvers.get('album-1')?.(downloadResult('track-1'));
    resolvers.get('album-2')?.(downloadResult('track-1'));

    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.pinSource?.sourceId)
      .toBe('album-2');
    expect(invokeMock).not.toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/media/library/a.test/track-1.flac' }),
    );
  });

  it('cleans a shared native result after every concurrent owner is cancelled', async () => {
    const resolvers: Array<(value: ReturnType<typeof downloadResult>) => void> = [];
    onInvoke('download_track_local', () => new Promise(resolve => {
      resolvers.push(resolve);
    }));
    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'One', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await useOfflineStore.getState().downloadAlbum(
      'album-2',
      'Two',
      'Artist',
      undefined,
      undefined,
      [{ ...SONG, albumId: 'album-2', album: 'Two' }],
      'srv-a',
    );
    await waitFor(() => expect(resolvers).toHaveLength(2));

    cancelAllOfflinePins();
    resolvers[0]?.(downloadResult('track-1'));
    resolvers[1]?.(downloadResult('track-1'));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/media/library/a.test/track-1.flac' }),
    ));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')).toBeNull();
  });

  it('preserves a completed shared track when its latest pin source is deleted', async () => {
    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'One', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    await useOfflineStore.getState().downloadAlbum(
      'album-2',
      'Two',
      'Artist',
      undefined,
      undefined,
      [{ ...SONG, albumId: 'album-2', album: 'Two' }],
      'srv-a',
    );
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().listPinnedGroups('a.test')).toHaveLength(2);

    await useOfflineStore.getState().deleteAlbum('album-2', 'srv-a');

    expect(useOfflineStore.getState().isAlbumDownloaded('album-1', 'srv-a')).toBe(true);
    expect(useOfflineStore.getState().isAlbumDownloaded('album-2', 'srv-a')).toBe(false);
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.pinSource?.sourceId)
      .toBe('album-1');
    expect(invokeMock).not.toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: '/media/library/a.test/track-1.flac' }),
    );
  });

  it('removes only the requested pin kind when source ids overlap', async () => {
    const base = {
      serverIndexKey: 'a.test',
      trackId: 'track-1',
      localPath: '/media/library/a.test/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'layout',
      tier: 'library' as const,
      suffix: 'flac',
      originalBytesVerified: true,
    };
    useLocalPlaybackStore.getState().upsertEntry({
      ...base,
      pinSource: { kind: 'album', sourceId: 'shared-id' },
    });
    useLocalPlaybackStore.getState().upsertEntry({
      ...base,
      pinSource: { kind: 'artist', sourceId: 'shared-id' },
    });

    await useOfflineStore.getState().deleteAlbum(
      'shared-id',
      'srv-a',
      { kind: 'album', sourceId: 'shared-id' },
    );

    expect(useLocalPlaybackStore.getState().listPinnedGroups('a.test')).toEqual([
      expect.objectContaining({ pinSource: { kind: 'artist', sourceId: 'shared-id' } }),
    ]);
    expect(invokeMock).not.toHaveBeenCalledWith(
      'delete_media_file',
      expect.objectContaining({ localPath: base.localPath }),
    );

    await useOfflineStore.getState().deleteAlbum(
      'shared-id',
      'srv-a',
      { kind: 'artist', sourceId: 'shared-id' },
    );
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('delete_media_file', {
      localPath: base.localPath,
      mediaDir: null,
    });
  });

  it('runs concurrent deletions for distinct owners with the same source id', async () => {
    const base = {
      serverIndexKey: 'a.test',
      trackId: 'track-1',
      localPath: '/media/library/a.test/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'layout',
      tier: 'library' as const,
      suffix: 'flac',
      originalBytesVerified: true,
    };
    useLocalPlaybackStore.getState().upsertEntry({
      ...base,
      pinSource: { kind: 'album', sourceId: 'shared-id' },
    });
    useLocalPlaybackStore.getState().upsertEntry({
      ...base,
      pinSource: { kind: 'artist', sourceId: 'shared-id' },
    });

    await Promise.all([
      useOfflineStore.getState().deleteAlbum(
        'shared-id',
        'srv-a',
        { kind: 'album', sourceId: 'shared-id' },
      ),
      useOfflineStore.getState().deleteAlbum(
        'shared-id',
        'srv-a',
        { kind: 'artist', sourceId: 'shared-id' },
      ),
    ]);

    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')).toBeNull();
    expect(invokeMock.mock.calls.filter(([command]) => command === 'delete_media_file'))
      .toHaveLength(1);
  });

  it('waits for shared-track deletion before reusing the track for another album', async () => {
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 'track-1',
      localPath: '/media/library/a.test/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'layout',
      tier: 'library',
      pinSource: { kind: 'album', sourceId: 'album-1' },
      suffix: 'flac',
      originalBytesVerified: true,
    });
    let releaseDeletion!: () => void;
    onInvoke('delete_media_file', () => new Promise<void>(resolve => {
      releaseDeletion = resolve;
    }));
    let downloadCalls = 0;
    onInvoke('download_track_local', () => {
      downloadCalls += 1;
      return downloadResult('track-1');
    });

    const deletion = useOfflineStore.getState().deleteAlbum('album-1', 'srv-a');
    await waitFor(() => expect(releaseDeletion).toBeTypeOf('function'));
    await useOfflineStore.getState().downloadAlbum(
      'album-2',
      'Two',
      'Artist',
      undefined,
      undefined,
      [{ ...SONG, albumId: 'album-2', album: 'Two' }],
      'srv-a',
    );
    await Promise.resolve();
    expect(downloadCalls).toBe(0);

    releaseDeletion();
    await deletion;
    await waitFor(() => expect(downloadCalls).toBe(1));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.pinSource?.sourceId)
      .toBe('album-2');
  });

  it('retries a canonical transfer when legacy-key deletion starts during the invoke', async () => {
    useAuthStore.setState({
      subsonicServerIdentityByServer: { 'srv-a': { type: 'navidrome' } },
    });
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'srv-a',
      trackId: 'track-1',
      localPath: '/media/library/srv-a/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'legacy',
      tier: 'library',
      pinSource: { kind: 'album', sourceId: 'album-1' },
      suffix: 'flac',
      originalBytesVerified: false,
    });
    const downloadResolvers: Array<(value: ReturnType<typeof downloadResult>) => void> = [];
    onInvoke('download_track_local', () => new Promise(resolve => {
      downloadResolvers.push(resolve);
    }));
    let releaseDeletion!: () => void;
    onInvoke('delete_media_file', () => new Promise<void>(resolve => {
      releaseDeletion = resolve;
    }));

    await useOfflineStore.getState().downloadAlbum(
      'album-2',
      'Two',
      'Artist',
      undefined,
      undefined,
      [{ ...SONG, albumId: 'album-2', album: 'Two' }],
      'srv-a',
    );
    await waitFor(() => expect(downloadResolvers).toHaveLength(1));
    const deletion = useOfflineStore.getState().deleteAlbum('album-1', 'srv-a');
    await waitFor(() => expect(releaseDeletion).toBeTypeOf('function'));

    downloadResolvers[0]?.({ ...downloadResult('track-1'), originalBytesVerified: true });
    await Promise.resolve();
    expect(downloadResolvers).toHaveLength(1);
    releaseDeletion();
    await deletion;

    await waitFor(() => expect(downloadResolvers).toHaveLength(2));
    downloadResolvers[1]?.({ ...downloadResult('track-1'), originalBytesVerified: true });
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.pinSource?.sourceId)
      .toBe('album-2');
    expect(invokeMock.mock.calls.filter(([command]) => command === 'download_track_local'))
      .toHaveLength(2);
  });

  it('waits for album deletion before starting an immediate retry', async () => {
    for (const song of [SONG, SONG_2]) {
      useLocalPlaybackStore.getState().upsertEntry({
        serverIndexKey: 'a.test',
        trackId: song.id,
        localPath: `/media/library/a.test/${song.id}.flac`,
        sizeBytes: 123,
        layoutFingerprint: 'old',
        tier: 'library',
        pinSource: { kind: 'album', sourceId: 'album-1' },
        suffix: 'flac',
        originalBytesVerified: false,
      });
    }
    let releaseDeletion!: () => void;
    const deletionGate = new Promise<void>(resolve => {
      releaseDeletion = resolve;
    });
    onInvoke('delete_media_file', () => deletionGate);
    let downloadCalls = 0;
    onInvoke('download_track_local', (args) => {
      downloadCalls += 1;
      return downloadResult((args as { trackId: string }).trackId);
    });

    const deletion = useOfflineStore.getState().deleteAlbum('album-1', 'a.test');
    await waitFor(() => expect(invokeMock.mock.calls.filter(
      ([command]) => command === 'delete_media_file',
    )).toHaveLength(2));
    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG, SONG_2], 'srv-a',
    );
    await Promise.resolve();
    expect(downloadCalls).toBe(0);

    releaseDeletion();
    await deletion;
    await waitFor(() => expect(downloadCalls).toBe(2));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.localPath)
      .toContain('track-1.flac');
    expect(useLocalPlaybackStore.getState().getEntry('track-2', 'a.test')?.localPath)
      .toContain('track-2.flac');
  });

  it('cancels a dispatched pin while it is waiting for album deletion', async () => {
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 'track-1',
      localPath: '/media/library/a.test/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'old',
      tier: 'library',
      pinSource: { kind: 'album', sourceId: 'album-1' },
      suffix: 'flac',
      originalBytesVerified: false,
    });
    let releaseDeletion!: () => void;
    onInvoke('delete_media_file', () => new Promise<void>(resolve => {
      releaseDeletion = resolve;
    }));
    let downloadCalls = 0;
    onInvoke('download_track_local', () => {
      downloadCalls += 1;
      return downloadResult('track-1');
    });

    const deletion = useOfflineStore.getState().deleteAlbum('album-1', 'a.test');
    await waitFor(() => expect(releaseDeletion).toBeTypeOf('function'));
    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue[0]?.status).toBe('queued'));

    clearOfflinePinTasks();
    useOfflineJobStore.getState().cancelAllDownloads();
    releaseDeletion();
    await deletion;
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));

    expect(downloadCalls).toBe(0);
    expect(useOfflineStore.getState().albums['a.test:album-1']).toBeUndefined();
  });

  it('removes legacy UUID-keyed entries when deletion uses the canonical server key', async () => {
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'srv-a',
      trackId: 'track-1',
      localPath: '/media/library/srv-a/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'legacy',
      tier: 'library',
      pinSource: { kind: 'album', sourceId: 'album-1' },
      suffix: 'flac',
      originalBytesVerified: false,
    });

    await useOfflineStore.getState().deleteAlbum('album-1', 'a.test');

    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'srv-a')).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('delete_media_file', {
      localPath: '/media/library/srv-a/track-1.flac',
      mediaDir: null,
    });
  });

  it('tracks only artist albums that were completed or successfully queued', async () => {
    let resolveDownload!: (value: ReturnType<typeof downloadResult>) => void;
    onInvoke('download_track_local', () => new Promise(resolve => {
      resolveDownload = resolve;
    }));
    mocks.getArtistForServer.mockResolvedValue({
      albums: [
        { id: 'album-1', name: 'One', artist: 'Artist' },
        { id: 'album-2', name: 'Two', artist: 'Artist' },
      ],
    });
    mocks.getAlbumForServer.mockImplementation(async (_serverId: string, albumId: string) => {
      if (albumId === 'album-2') throw new Error('unavailable');
      return { songs: [SONG] };
    });

    await useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');

    await waitFor(() => expect(resolveDownload).toBeTypeOf('function'));
    expect(useOfflineJobStore.getState().bulkProgress['srv-a:artist-1'])
      .toEqual({ done: 0, total: 1 });
    resolveDownload(downloadResult('track-1'));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('attaches artist ownership to existing album bytes without redownloading', async () => {
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 'track-1',
      localPath: '/media/library/a.test/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'layout',
      tier: 'library',
      pinSource: { kind: 'album', sourceId: 'album-1' },
      suffix: 'flac',
      originalBytesVerified: true,
    });
    useOfflineStore.setState({
      albums: {
        'a.test:album-1': {
          id: 'album-1',
          serverId: 'a.test',
          name: 'One',
          artist: 'Artist',
          trackIds: ['track-1'],
          type: 'album',
        },
      },
    });
    mocks.getArtistForServer.mockResolvedValue({
      albums: [{ id: 'album-1', name: 'One', artist: 'Artist' }],
    });
    mocks.getAlbumForServer.mockResolvedValue({ songs: [SONG] });

    await useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));

    const entry = useLocalPlaybackStore.getState().getEntry('track-1', 'a.test');
    expect(localPlaybackPinSources(entry!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'album', sourceId: 'album-1' }),
      expect.objectContaining({ kind: 'artist', sourceId: 'album-1' }),
    ]));
    expect(invokeMock.mock.calls.filter(([command]) => command === 'download_track_local'))
      .toHaveLength(0);
  });

  it('does not count an artist task rejected by a racing direct album pin', async () => {
    let resolveAlbum!: (value: { songs: SubsonicSong[] }) => void;
    mocks.getArtistForServer.mockResolvedValue({
      albums: [{ id: 'album-1', name: 'One', artist: 'Artist' }],
    });
    mocks.getAlbumForServer.mockImplementation(() => new Promise(resolve => {
      resolveAlbum = resolve;
    }));
    let resolveDirect!: (value: ReturnType<typeof downloadResult>) => void;
    onInvoke('download_track_local', () => new Promise(resolve => {
      resolveDirect = resolve;
    }));

    const artistDownload = useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');
    await waitFor(() => expect(resolveAlbum).toBeTypeOf('function'));
    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'One', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(resolveDirect).toBeTypeOf('function'));
    resolveAlbum({ songs: [SONG] });
    await artistDownload;

    expect(useOfflineJobStore.getState().bulkProgress['srv-a:artist-1']).toBeUndefined();
    resolveDirect(downloadResult('track-1'));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('adds artist ownership after an explicit album pin completes during preparation', async () => {
    let resolveAlbum!: (value: { songs: SubsonicSong[] }) => void;
    mocks.getArtistForServer.mockResolvedValue({
      albums: [{ id: 'album-1', name: 'One', artist: 'Artist' }],
    });
    mocks.getAlbumForServer.mockImplementation(() => new Promise(resolve => {
      resolveAlbum = resolve;
    }));

    const artistDownload = useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');
    await waitFor(() => expect(resolveAlbum).toBeTypeOf('function'));
    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'One', 'Artist', undefined, undefined, [SONG], 'srv-a',
    );
    await waitFor(() => expect(
      useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.pinSource?.sourceId,
    ).toBe('album-1'));

    resolveAlbum({ songs: [SONG] });
    await artistDownload;
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));

    expect(invokeMock.mock.calls.filter(([command]) => command === 'download_track_local'))
      .toHaveLength(1);
    expect(localPlaybackPinSources(
      useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')!,
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'album', sourceId: 'album-1' }),
      expect.objectContaining({ kind: 'artist', sourceId: 'album-1' }),
    ]));
  });

  it('does not requeue an artist album deleted while album details are loading', async () => {
    useAuthStore.setState({
      subsonicServerIdentityByServer: { 'srv-a': { type: 'navidrome' } },
    });
    useOfflineStore.setState({
      albums: {
        'a.test:album-1': {
          id: 'album-1',
          serverId: 'a.test',
          name: 'One',
          artist: 'Artist',
          trackIds: ['track-1'],
          type: 'artist',
        },
      },
    });
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 'track-1',
      localPath: '/media/library/a.test/track-1.flac',
      sizeBytes: 123,
      layoutFingerprint: 'layout',
      tier: 'library',
      pinSource: { kind: 'artist', sourceId: 'album-1' },
      suffix: 'flac',
      originalBytesVerified: false,
    });
    mocks.getArtistForServer.mockResolvedValue({
      albums: [{ id: 'album-1', name: 'One', artist: 'Artist' }],
    });
    let resolveAlbum!: (value: { songs: SubsonicSong[] }) => void;
    mocks.getAlbumForServer.mockImplementation(() => new Promise(resolve => {
      resolveAlbum = resolve;
    }));

    const artistDownload = useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');
    await waitFor(() => expect(resolveAlbum).toBeTypeOf('function'));
    await useOfflineStore.getState().deleteAlbum('album-1', 'srv-a');
    resolveAlbum({ songs: [SONG] });
    await artistDownload;

    expect(useOfflineJobStore.getState().pinQueue).toEqual([]);
    expect(useOfflineStore.getState().albums['a.test:album-1']).toBeUndefined();
    expect(invokeMock.mock.calls.filter(([command]) => command === 'download_track_local'))
      .toHaveLength(0);
  });

  it('does not enqueue artist work prepared before cancel-all', async () => {
    let resolveArtist!: (value: { albums: Array<{ id: string; name: string; artist: string }> }) => void;
    mocks.getArtistForServer.mockImplementation(() => new Promise(resolve => {
      resolveArtist = resolve;
    }));

    const artistDownload = useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');
    await waitFor(() => expect(resolveArtist).toBeTypeOf('function'));
    cancelAllOfflinePins();
    resolveArtist({ albums: [{ id: 'album-1', name: 'One', artist: 'Artist' }] });
    await artistDownload;

    expect(mocks.getAlbumForServer).not.toHaveBeenCalled();
    expect(useOfflineJobStore.getState().pinQueue).toEqual([]);
    expect(useOfflineJobStore.getState().bulkProgress['srv-a:artist-1']).toBeUndefined();
  });

  it('starts an immediate artist retry without waiting for a cancelled preparation', async () => {
    let resolveFirst!: (value: { albums: Array<{ id: string; name: string; artist: string }> }) => void;
    mocks.getArtistForServer
      .mockImplementationOnce(() => new Promise(resolve => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({ albums: [] });

    const first = useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');
    await waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
    cancelAllOfflinePins();
    const retry = useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');
    await retry;

    expect(mocks.getArtistForServer).toHaveBeenCalledTimes(2);
    resolveFirst({ albums: [] });
    await first;
  });

  it('shares one preparation across overlapping artist download requests', async () => {
    let resolveArtist!: (value: { albums: Array<{ id: string; name: string; artist: string }> }) => void;
    mocks.getArtistForServer.mockImplementation(() => new Promise(resolve => {
      resolveArtist = resolve;
    }));
    mocks.getAlbumForServer.mockImplementation(async (_serverId: string, albumId: string) => ({
      songs: [{ ...SONG, id: `track-${albumId}`, albumId, album: albumId }],
    }));
    const downloadResolvers = new Map<
      string,
      (value: ReturnType<typeof downloadResult>) => void
    >();
    onInvoke('download_track_local', (args) => {
      const trackId = (args as { trackId: string }).trackId;
      return new Promise<ReturnType<typeof downloadResult>>(resolve => {
        downloadResolvers.set(trackId, resolve);
      });
    });

    const first = useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');
    const second = useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');
    expect(mocks.getArtistForServer).toHaveBeenCalledTimes(1);
    resolveArtist({
      albums: [
        { id: 'album-1', name: 'One', artist: 'Artist' },
        { id: 'album-2', name: 'Two', artist: 'Artist' },
        { id: 'album-3', name: 'Three', artist: 'Artist' },
      ],
    });
    await Promise.all([first, second]);

    expect(mocks.getAlbumForServer).toHaveBeenCalledTimes(3);
    expect(useOfflineJobStore.getState().bulkProgress['srv-a:artist-1'])
      .toEqual({ done: 0, total: 3 });
    await waitFor(() => expect(downloadResolvers.size).toBe(2));
    for (const [trackId, resolve] of [...downloadResolvers.entries()]) {
      resolve(downloadResult(trackId));
      downloadResolvers.delete(trackId);
    }
    await waitFor(() => expect(downloadResolvers.size).toBe(1));
    for (const [trackId, resolve] of downloadResolvers) resolve(downloadResult(trackId));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('starts a new artist preparation without retained completed progress', async () => {
    useOfflineJobStore.setState({
      bulkProgress: { 'srv-a:artist-1': { done: 1, total: 1 } },
    });
    mocks.getArtistForServer.mockResolvedValue({
      albums: [{ id: 'album-1', name: 'One', artist: 'Artist' }],
    });
    mocks.getAlbumForServer.mockResolvedValue({ songs: [SONG] });
    let resolveDownload!: (value: ReturnType<typeof downloadResult>) => void;
    onInvoke('download_track_local', () => new Promise(resolve => {
      resolveDownload = resolve;
    }));

    await useOfflineStore.getState().downloadArtist('artist-1', 'Artist', 'srv-a');

    expect(useOfflineJobStore.getState().bulkProgress['srv-a:artist-1'])
      .toEqual({ done: 0, total: 1 });
    await waitFor(() => expect(resolveDownload).toBeTypeOf('function'));
    resolveDownload(downloadResult('track-1'));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('shows a localized album error when a track download fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    onInvoke('download_track_local', () => {
      throw new Error('request timed out');
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1',
      'Album',
      'Artist',
      undefined,
      undefined,
      [SONG],
      'srv-a',
    );

    await waitFor(() => expect(document.querySelector('.psysonic-toast')?.textContent)
      .toContain('Failed to add Album offline'));
    expect(consoleError).toHaveBeenCalledWith(
      '[offline] track download failed',
      expect.objectContaining({ trackId: 'track-1', error: 'request timed out' }),
    );
    consoleError.mockRestore();
  });
});
