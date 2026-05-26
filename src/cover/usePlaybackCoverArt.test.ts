import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoverArtHandle } from './types';
import { usePlaybackCoverArt } from './usePlaybackCoverArt';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { makeTrack } from '../test/helpers/factories';
import { resetAllStores } from '../test/helpers/storeReset';

const mockUseCoverArt = vi.fn(
  (): CoverArtHandle => ({
    src: '',
    storageKey: '',
    cacheKey: '',
    tier: 128,
    provisional: false,
  }),
);

vi.mock('./useCoverArt', () => ({
  useCoverArt: (...args: unknown[]) => mockUseCoverArt(...args),
}));

function seedPlaybackState(): { active: string; playback: string } {
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
  const track = makeTrack({ id: 'song-1', coverArt: 'cover-1' });
  usePlayerStore.setState({
    queue: [track],
    queueIndex: 0,
    queueServerId: playback,
    currentTrack: track,
  });
  return { active, playback };
}

describe('usePlaybackCoverArt', () => {
  beforeEach(() => {
    resetAllStores();
    mockUseCoverArt.mockClear();
  });

  it('recomputes server scope when playback server credentials change', async () => {
    const { playback } = seedPlaybackState();
    const { rerender } = renderHook(() => usePlaybackCoverArt('cover-1', 300));

    const firstScope = mockUseCoverArt.mock.calls[0]?.[2]?.serverScope;
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
      const latestScope = mockUseCoverArt.mock.calls.at(-1)?.[2]?.serverScope;
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
