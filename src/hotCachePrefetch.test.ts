import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { makeTrack, seedQueue } from '@/test/helpers/factories';
import { resetAuthStore, resetPlayerStore } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';

const buildOriginalStreamUrlForServerMock = vi.hoisted(() => vi.fn(
  (serverId: string, trackId: string) => `https://original.test/${serverId}/${trackId}`,
));

vi.mock('@/lib/api/subsonicStreamUrl', () => ({
  buildOriginalStreamUrlForServer: buildOriginalStreamUrlForServerMock,
}));

import { scheduleHotCachePrefetchForTrack } from '@/hotCachePrefetch';

beforeEach(() => {
  resetAuthStore();
  resetPlayerStore();
  useLocalPlaybackStore.setState({ entries: {} });
  buildOriginalStreamUrlForServerMock.mockClear();
  useAuthStore.setState({
    activeServerId: 'srv-a',
    isLoggedIn: true,
    hotCacheEnabled: true,
    hotCacheMaxMb: 256,
    servers: [{
      id: 'srv-a',
      name: 'A',
      url: 'https://a.test',
      username: 'u',
      password: 'p',
    }],
    subsonicServerIdentityByServer: { 'srv-a': { type: 'navidrome' } },
  });
  const current = makeTrack({ id: 'current', suffix: 'flac' });
  const next = makeTrack({ id: 'next', suffix: 'flac' });
  seedQueue([current, next], { index: 0, serverId: 'a.test' });
  onInvoke('download_track_local', () => ({
    path: '/media/cache/a.test/next.flac',
    size: 789,
    layoutFingerprint: 'layout',
    originalBytesVerified: true,
  }));
  onInvoke('probe_media_files', () => [true]);
  onInvoke('prune_empty_media_tier_dirs', () => undefined);
  onInvoke('get_media_tier_size', () => 789);
});

describe('hot-cache prefetch producer', () => {
  it('passes the shared original-stream URL to the native downloader', async () => {
    const next = usePlayerStore.getState().queueItems[1]!;
    scheduleHotCachePrefetchForTrack({ id: next.trackId, suffix: 'flac' }, 'a.test');

    await waitFor(() => expect(buildOriginalStreamUrlForServerMock)
      .toHaveBeenCalledWith('a.test', 'next'));
    expect(invokeMock).toHaveBeenCalledWith(
      'download_track_local',
      expect.objectContaining({ url: 'https://original.test/a.test/next' }),
    );
    await waitFor(() => expect(
      useLocalPlaybackStore.getState().getEntry('next', 'a.test')?.originalBytesVerified,
    ).toBe(true));
  });

  it('revalidates a legacy unverified Navidrome hot-cache entry', async () => {
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: 'a.test',
      trackId: 'next',
      localPath: '/media/cache/a.test/next.flac',
      sizeBytes: 789,
      layoutFingerprint: 'legacy',
      tier: 'ephemeral',
      suffix: 'flac',
      originalBytesVerified: false,
    });

    scheduleHotCachePrefetchForTrack({ id: 'next', suffix: 'flac' }, 'a.test');

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(
      'download_track_local',
      expect.objectContaining({ trackId: 'next' }),
    ));
    await waitFor(() => expect(
      useLocalPlaybackStore.getState().getEntry('next', 'a.test')?.originalBytesVerified,
    ).toBe(true));
  });
});
