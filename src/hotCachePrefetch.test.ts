import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { makeServer, makeTrack, seedQueue } from '@/test/helpers/factories';
import { resetAuthStore, resetPlayerStore } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';
import { setDeferHotCachePrefetch } from '@/lib/cache/hotCacheGate';

const buildOriginalStreamUrlForServerMock = vi.hoisted(() => vi.fn(
  (serverId: string, trackId: string) => `https://original.test/${serverId}/${trackId}`,
));

vi.mock('@/lib/api/subsonicStreamUrl', () => ({
  buildOriginalStreamUrlForServer: buildOriginalStreamUrlForServerMock,
}));

import { initHotCachePrefetch, scheduleHotCachePrefetchForTrack } from '@/hotCachePrefetch';

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

describe('hot-cache prefetch server scope', () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    resetAuthStore();
    resetPlayerStore();
    useLocalPlaybackStore.setState({ entries: {} });

    const serverA = makeServer({ id: 'a', url: 'http://a.test' });
    const serverB = makeServer({ id: 'b', url: 'http://b.test' });
    useAuthStore.setState({
      servers: [serverA, serverB],
      activeServerId: serverA.id,
      isLoggedIn: true,
      hotCacheEnabled: true,
      hotCacheMaxMb: 64,
      hotCacheDebounceSec: 0,
    });

    const current = makeTrack({ id: 'track-a', serverId: serverA.id, suffix: 'mp3' });
    const upcoming = makeTrack({ id: 'track-b', serverId: serverB.id, suffix: 'mp3' });
    seedQueue([current, upcoming], { index: 0, serverId: serverA.id });

    onInvoke('prune_empty_media_tier_dirs', () => undefined);
    onInvoke('get_media_tier_size', () => 0);
    onInvoke('probe_media_files', args => {
      const paths = (args as { localPaths: string[] }).localPaths;
      return paths.map(() => true);
    });
    onInvoke('download_track_local', args => ({
      path: `/media/cache/${(args as { serverIndexKey: string }).serverIndexKey}/track-b.mp3`,
      size: 1024,
      layoutFingerprint: 'fp',
      originalBytesVerified: true,
    }));
  });

  afterEach(() => {
    setDeferHotCachePrefetch(false);
    cleanup?.();
    cleanup = null;
    usePlayerStore.setState({ queueItems: [], queueIndex: 0, currentTrack: null, queueServerId: null });
    useLocalPlaybackStore.setState({ entries: {} });
  });

  it('uses each upcoming queue item server for its download directory', async () => {
    cleanup = initHotCachePrefetch();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'download_track_local',
        expect.objectContaining({
          trackId: 'track-b',
          serverIndexKey: 'b.test',
          libraryServerId: 'b.test',
        }),
      );
    });
  });

  it('drops a stale server job after the queue switches to another server', async () => {
    const currentB = makeTrack({ id: 'shared-current', serverId: 'b', suffix: 'mp3' });
    const upcomingB = makeTrack({ id: 'shared-next', serverId: 'b', suffix: 'mp3' });
    seedQueue([currentB, upcomingB], { index: 0, serverId: 'b' });
    setDeferHotCachePrefetch(true);
    cleanup = initHotCachePrefetch();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('get_media_tier_size', {
        tier: 'ephemeral',
        mediaDir: null,
      });
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const currentA = makeTrack({ id: 'shared-current', serverId: 'a', suffix: 'mp3' });
    const upcomingA = makeTrack({ id: 'shared-next', serverId: 'a', suffix: 'mp3' });
    seedQueue([currentA, upcomingA], { index: 0, serverId: 'a' });
    setDeferHotCachePrefetch(false);

    await waitFor(() => {
      const downloadCalls = invokeMock.mock.calls.filter(([command]) => command === 'download_track_local');
      const downloadCall = downloadCalls.find(([, args]) => (
        (args as { serverIndexKey?: string }).serverIndexKey === 'a.test'
      ));
      expect(downloadCall?.[1]).toEqual(expect.objectContaining({
        trackId: 'shared-next',
        serverIndexKey: 'a.test',
        libraryServerId: 'a.test',
      }));
      expect(downloadCalls.some(([, args]) => (
        (args as { serverIndexKey?: string }).serverIndexKey === 'b.test'
      ))).toBe(false);
    });
  });
});
