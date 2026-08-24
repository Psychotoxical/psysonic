import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';
import { cancelledDownloads, useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import { clearOfflinePinTasks } from '@/features/offline/utils/offlinePinQueue';

const mocks = vi.hoisted(() => ({
  buildOriginalStreamUrlForServer: vi.fn(
    (serverId: string, trackId: string) => `https://original.test/${serverId}/${trackId}`,
  ),
  libraryUpsertSongsFromApi: vi.fn(async () => undefined),
}));

vi.mock('@/lib/api/subsonicStreamUrl', () => ({
  buildOriginalStreamUrlForServer: mocks.buildOriginalStreamUrlForServer,
}));

vi.mock('@/lib/api/library', () => ({
  libraryUpsertSongsFromApi: mocks.libraryUpsertSongsFromApi,
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

  it('downloads tracks sequentially and publishes each completed track immediately', async () => {
    let resolveFirst!: (value: ReturnType<typeof downloadResult>) => void;
    let resolveSecond!: (value: ReturnType<typeof downloadResult>) => void;
    const first = new Promise<ReturnType<typeof downloadResult>>(resolve => {
      resolveFirst = resolve;
    });
    const second = new Promise<ReturnType<typeof downloadResult>>(resolve => {
      resolveSecond = resolve;
    });
    const started: string[] = [];
    onInvoke('download_track_local', (args) => {
      const trackId = (args as { trackId: string }).trackId;
      started.push(trackId);
      return trackId === 'track-1' ? first : second;
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1',
      'Album',
      'Artist',
      undefined,
      undefined,
      [SONG, SONG_2],
      'srv-a',
    );

    await waitFor(() => expect(started).toEqual(['track-1']));
    expect(useOfflineJobStore.getState().jobs.find(j => j.trackId === 'track-2')?.status)
      .toBe('queued');

    resolveFirst(downloadResult('track-1'));
    await waitFor(() => expect(started).toEqual(['track-1', 'track-2']));
    expect(useOfflineJobStore.getState().jobs.map(j => [j.trackId, j.status])).toEqual([
      ['track-1', 'done'],
      ['track-2', 'downloading'],
    ]);

    resolveSecond(downloadResult('track-2'));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.localPath)
      .toContain('track-1.flac');
    expect(useLocalPlaybackStore.getState().getEntry('track-2', 'a.test')?.localPath)
      .toContain('track-2.flac');
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
      [SONG, SONG_2],
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
    expect(invokeMock).toHaveBeenCalledWith('delete_media_file', {
      localPath: '/media/library/a.test/track-1.flac',
      mediaDir: null,
    });
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

  it('keeps the old generation cancelled across cancel-all and immediate retry', async () => {
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
    expect(invocations).toBe(1);

    resolveFirst(downloadResult('track-1'));
    await waitFor(() => expect(invocations).toBe(2));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')).toBeNull();

    resolveRetry(downloadResult('track-1'));
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useLocalPlaybackStore.getState().getEntry('track-1', 'a.test')?.localPath)
      .toContain('track-1.flac');
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
