import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';
import { cancelledDownloads, useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import { clearOfflinePinTasks } from '@/features/offline/utils/offlinePinQueue';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';

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
  deactivateCanonicalNavidromeOwners(['srv-a', 'a.test']);
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

  it('canonicalizes a later active-download batch after owner activation', async () => {
    const legacyFirst = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const legacySecond = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const canonicalSecond = canonicalizeNavidromeId(legacySecond);
    const songs = Array.from({ length: 9 }, (_, index): SubsonicSong => ({
      ...SONG,
      id: index === 0 ? legacyFirst : index === 8 ? legacySecond : `track-${index}`,
      albumId: 'album-1',
    }));
    let releaseFirstBatch!: () => void;
    const firstBatchGate = new Promise<void>(resolve => { releaseFirstBatch = resolve; });
    let firstBatchCalls = 0;
    onInvoke('download_track_local', async (args) => {
      firstBatchCalls += 1;
      if (firstBatchCalls <= 8) {
        await firstBatchGate;
      }
      return {
        path: `/media/${String((args as { trackId: string }).trackId)}.flac`,
        size: 1,
        layoutFingerprint: 'layout',
        originalBytesVerified: true,
      };
    });

    await useOfflineStore.getState().downloadAlbum(
      'album-1', 'Album', 'Artist', undefined, undefined, songs, 'srv-a',
    );
    await waitFor(() => expect(firstBatchCalls).toBe(8));

    activateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    releaseFirstBatch();
    await waitFor(() => expect(mocks.buildOriginalStreamUrlForServer)
      .toHaveBeenCalledWith('srv-a', canonicalSecond));
    expect(invokeMock).toHaveBeenCalledWith(
      'download_track_local',
      expect.objectContaining({ trackId: canonicalSecond }),
    );
  });

  it('cancels a legacy active download when removal uses its canonical album id', async () => {
    const legacyAlbumId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const canonicalAlbumId = canonicalizeNavidromeId(legacyAlbumId);
    const songs = Array.from({ length: 9 }, (_, index): SubsonicSong => ({
      ...SONG,
      id: `track-${index}`,
      albumId: legacyAlbumId,
    }));
    let releaseFirstBatch!: () => void;
    const firstBatchGate = new Promise<void>(resolve => { releaseFirstBatch = resolve; });
    let downloadCalls = 0;
    onInvoke('download_track_local', async args => {
      downloadCalls += 1;
      if (downloadCalls <= 8) await firstBatchGate;
      return {
        path: `/media/${String((args as { trackId: string }).trackId)}.flac`,
        size: 1,
        layoutFingerprint: 'layout',
        originalBytesVerified: true,
      };
    });
    onInvoke('cancel_offline_downloads', () => undefined);

    await useOfflineStore.getState().downloadAlbum(
      legacyAlbumId, 'Album', 'Artist', undefined, undefined, songs, 'srv-a',
    );
    await waitFor(() => expect(downloadCalls).toBe(8));
    activateCanonicalNavidromeOwners(['srv-a', 'a.test']);

    await useOfflineStore.getState().deleteAlbum(canonicalAlbumId, 'srv-a');
    releaseFirstBatch();
    await waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));

    expect(downloadCalls).toBe(8);
    expect(Object.keys(useLocalPlaybackStore.getState().entries)).toEqual([]);
  });

  it('resolves status and deletion across legacy and canonical album ids', async () => {
    const legacyAlbumId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const canonicalAlbumId = canonicalizeNavidromeId(legacyAlbumId);
    const legacyTrackId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const canonicalTrackId = canonicalizeNavidromeId(legacyTrackId);
    activateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    useOfflineStore.setState({
      albums: {
        [`a.test:${canonicalAlbumId}`]: {
          id: canonicalAlbumId,
          serverId: 'a.test',
          name: 'Album',
          artist: 'Artist',
          trackIds: [canonicalTrackId],
          type: 'album',
        },
      },
    });
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: canonicalTrackId,
      localPath: `/media/${canonicalTrackId}.flac`,
      sizeBytes: 1,
      layoutFingerprint: 'canonical',
      tier: 'library',
      pinSource: { kind: 'album', sourceId: canonicalAlbumId },
      suffix: 'flac',
    });
    useOfflineJobStore.setState({
      jobs: [{
        trackId: canonicalTrackId,
        albumId: canonicalAlbumId,
        albumName: 'Album',
        trackTitle: 'Track',
        trackIndex: 0,
        totalTracks: 1,
        status: 'downloading',
        downloadId: 'download-1',
        serverId: 'srv-a',
      }],
      pinQueue: [],
      bulkProgress: {},
    });
    onInvoke('cancel_offline_downloads', () => undefined);
    onInvoke('delete_media_file', () => undefined);

    expect(useOfflineStore.getState().isAlbumDownloaded(legacyAlbumId, 'srv-a')).toBe(true);
    expect(useOfflineStore.getState().isAlbumDownloading(legacyAlbumId, 'srv-a')).toBe(true);
    expect(useOfflineStore.getState().getAlbumProgress(legacyAlbumId, 'srv-a')).toEqual({ done: 0, total: 1 });

    await useOfflineStore.getState().deleteAlbum(legacyAlbumId, 'srv-a');

    expect(useLocalPlaybackStore.getState().entries).toEqual({});
    expect(useOfflineStore.getState().albums).toEqual({});
  });
});
