import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initHotCachePrefetch } from '@/hotCachePrefetch';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useAuthStore } from '@/store/authStore';
import { setDeferHotCachePrefetch } from '@/lib/cache/hotCacheGate';
import { makeServer, makeTrack, seedQueue } from '@/test/helpers/factories';
import { resetAuthStore, resetPlayerStore } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';

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
