import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coverCacheEnsure, coverCachePeekBatch } from '../api/coverCache';
import { serverIndexKeyForProfile } from '../utils/server/serverIndexKey';
import { useNowPlayingPrewarm } from './useNowPlayingPrewarm';
import { prewarmNowPlayingFetchers } from './useNowPlayingFetchers';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import { makeTrack } from '../test/helpers/factories';
import { resetAllStores } from '../test/helpers/storeReset';
import { toQueueItemRefs } from '../utils/library/queueItemRef';

vi.mock('../api/coverCache', () => ({
  coverCachePeekBatch: vi.fn(async () => ({})),
  coverCacheEnsure: vi.fn(async () => ({ hit: false, path: '', tier: 800 })),
}));

vi.mock('./useNowPlayingFetchers', () => ({
  prewarmNowPlayingFetchers: vi.fn(async () => undefined),
}));

function seedServers(): { active: string; playback: string } {
  const active = useAuthStore.getState().addServer({
    name: 'Active',
    url: 'https://active.test',
    username: 'active-user',
    password: 'active-pass',
  });
  const playback = useAuthStore.getState().addServer({
    name: 'Playback',
    url: 'https://playback.test',
    username: 'play-user',
    password: 'play-pass',
  });
  useAuthStore.getState().setActiveServer(active);
  return { active, playback };
}

describe('useNowPlayingPrewarm', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
  });

  it('prewarms track data and artwork with playback scope', async () => {
    const { playback } = seedServers();
    const track = makeTrack({
      id: 'song-1',
      artistId: 'artist-1',
      albumId: 'album-1',
      artist: 'Artist One',
      coverArt: 'cover-1',
    });
    usePlayerStore.setState({
      queueItems: toQueueItemRefs(playback, [track]),
      queueIndex: 0,
      queueServerId: playback,
      currentTrack: track,
    });

    renderHook(() => useNowPlayingPrewarm());

    await waitFor(() => {
      expect(prewarmNowPlayingFetchers).toHaveBeenCalledTimes(1);
      expect(coverCachePeekBatch).toHaveBeenCalledTimes(1);
    });

    const peekArg = vi.mocked(coverCachePeekBatch).mock.calls[0]?.[0]?.[0];
    const playbackProfile = useAuthStore.getState().servers.find(s => s.id === playback);
    expect(playbackProfile).toBeDefined();
    expect(peekArg?.serverIndexKey).toBe(serverIndexKeyForProfile(playbackProfile!));
    const ensureRef = vi.mocked(coverCacheEnsure).mock.calls[0]?.[0];
    expect(ensureRef?.serverScope.kind).toBe('server');
  });

  it('prewarms radio artwork with active scope (not playback queue scope)', async () => {
    const { active, playback } = seedServers();
    const track = makeTrack({ id: 'song-2', coverArt: 'cover-2' });
    usePlayerStore.setState({
      queueItems: toQueueItemRefs(playback, [track]),
      queueIndex: 0,
      queueServerId: playback,
      currentTrack: null,
      currentRadio: {
        id: 'radio-1',
        name: 'Radio 1',
        streamUrl: 'https://radio.test/stream',
        coverArt: 'https://radio.test/art.jpg',
      },
    });

    renderHook(() => useNowPlayingPrewarm());

    await waitFor(() => {
      expect(coverCachePeekBatch).toHaveBeenCalledTimes(1);
    });

    const peekArg = vi.mocked(coverCachePeekBatch).mock.calls[0]?.[0]?.[0];
    const activeProfile = useAuthStore.getState().servers.find(s => s.id === active);
    expect(activeProfile).toBeDefined();
    expect(peekArg?.serverIndexKey).toBe(serverIndexKeyForProfile(activeProfile!));
    const ensureRef = vi.mocked(coverCacheEnsure).mock.calls[0]?.[0];
    expect(ensureRef?.serverScope).toEqual({ kind: 'active' });
  });
});
