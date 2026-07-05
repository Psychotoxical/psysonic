import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoverArtHandle } from './types';
import { albumCoverRef } from './ref';
import { usePlaybackCoverArt } from './usePlaybackCoverArt';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { makeTrack } from '../test/helpers/factories';
import { resetAllStores } from '../test/helpers/storeReset';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';

const hoisted = vi.hoisted(() => ({
  useCoverArtMock: vi.fn(
    (_coverRef?: unknown, _displayCssPx?: unknown, _opts?: unknown): CoverArtHandle => ({
      src: '',
      storageKey: '',
      cacheKey: '',
      tier: 128,
      provisional: false,
    }),
  ),
}));

vi.mock('./useCoverArt', () => ({
  useCoverArt: hoisted.useCoverArtMock,
}));

function seedPlaybackState(): { active: string; playback: string; track: ReturnType<typeof makeTrack> } {
  const active = useAuthStore.getState().addServer({
    name: 'Active',
    url: 'https://active.test',
    username: 'active-user',
    password: 'active-pass',
  });
  const playback = useAuthStore.getState().addServer({
    name: 'Playback',
    url: 'https://playback-a.test',
    username: 'play-user',
    password: 'play-pass',
  });
  useAuthStore.getState().setActiveServer(active);
  const track = makeTrack({ id: 'song-1', albumId: 'album-1', coverArt: 'cover-1' });
  usePlayerStore.setState({
    queueItems: toQueueItemRefs(playback, [track]),
    queueIndex: 0,
    queueServerId: playback,
    currentTrack: track,
  });
  return { active, playback, track };
}

describe('usePlaybackCoverArt', () => {
  beforeEach(() => {
    resetAllStores();
    hoisted.useCoverArtMock.mockClear();
  });

  it('recomputes server scope when playback server credentials change', async () => {
    const { playback, track } = seedPlaybackState();
    const coverRef = albumCoverRef(track.albumId!, track.coverArt!);
    const { rerender } = renderHook(() => usePlaybackCoverArt(coverRef, 300));

    const calls = hoisted.useCoverArtMock.mock.calls as Array<
      [{ serverScope?: Record<string, unknown> } | null, unknown, unknown]
    >;
    const firstScope = calls[0]?.[0]?.serverScope;
    expect(firstScope).toMatchObject({
      kind: 'server',
      serverId: playback,
      url: 'https://playback-a.test',
      username: 'play-user',
      password: 'play-pass',
    });

    const updatedServers = useAuthStore.getState().servers.map(server =>
      server.id === playback
        ? { ...server, url: 'https://playback-b.test', password: 'play-pass-2' }
        : server,
    );
    useAuthStore.setState({ servers: updatedServers });
    rerender();

    await waitFor(() => {
      const latestScope = calls[calls.length - 1]?.[0]?.serverScope;
      expect(latestScope).toMatchObject({
        kind: 'server',
        serverId: playback,
        url: 'https://playback-b.test',
        username: 'play-user',
        password: 'play-pass-2',
      });
    });
  });
});
