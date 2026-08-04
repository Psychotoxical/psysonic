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
});
