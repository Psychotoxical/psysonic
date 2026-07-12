import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTrack } from '@/test/helpers/factories';

const getPlayQueueForServerMock = vi.fn();
const resolveBatchMock = vi.fn();
const preparePausedRestoreMock = vi.fn();

vi.mock('@/lib/media/songToTrack', () => ({
  songToTrack: (s: { id: string }) => ({
    id: s.id,
    title: s.id,
    artist: '',
    album: '',
    albumId: '',
    duration: 60,
    serverId: 'music.test',
  }),
}));

vi.mock('@/features/playback/store/waveformRefresh', () => ({
  refreshWaveformForTrack: vi.fn(),
}));

vi.mock('@/lib/api/subsonicPlayQueue', () => ({
  getPlayQueueForServer: (...args: unknown[]) => getPlayQueueForServerMock(...args),
}));

vi.mock('@/features/playback/store/queueTrackResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/playback/store/queueTrackResolver')>();
  return {
    ...actual,
    resolveBatch: (...args: unknown[]) => resolveBatchMock(...args),
  };
});

vi.mock('@/features/playback/store/pausedRestorePrepare', () => ({
  preparePausedRestoreOnStartup: (...args: unknown[]) => preparePausedRestoreMock(...args),
}));

vi.mock('@/lib/server/serverLookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/serverLookup')>();
  return {
    ...actual,
    resolveServerIdForIndexKey: (id: string) => id,
  };
});

import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';

describe('initializeFromServerQueue startup', () => {
  beforeEach(() => {
    getPlayQueueForServerMock.mockReset();
    resolveBatchMock.mockReset().mockResolvedValue(undefined);
    preparePausedRestoreMock.mockReset();
    useAuthStore.setState({
      activeServerId: 'music.test',
      servers: [{
        id: 'music.test',
        name: 'Test',
        url: 'https://music.test',
        username: 'u',
        password: 'p',
      }],
    } as Partial<ReturnType<typeof useAuthStore.getState>>);
    usePlayerStore.setState({
      queueServerId: null,
      queueItems: [],
      queueIndex: 0,
      currentTrack: null,
      isPlaying: false,
    });
  });

  it('restores a persisted public share queue instead of pulling getPlayQueue', async () => {
    const track = {
      ...makeTrack({ id: 'ndshare:abc:0', serverId: 'navidrome-public-share' }),
      directStreamUrl: 'https://music.test/share/s/jwt-a',
    };
    usePlayerStore.setState({
      queueServerId: 'navidrome-public-share',
      queueItems: [{
        serverId: 'navidrome-public-share',
        trackId: 'ndshare:abc:0',
        directStreamUrl: 'https://music.test/share/s/jwt-a',
      }],
      queueIndex: 0,
      currentTrack: track,
      isPlaying: false,
    });

    await usePlayerStore.getState().initializeFromServerQueue();

    expect(getPlayQueueForServerMock).not.toHaveBeenCalled();
    expect(resolveBatchMock).toHaveBeenCalled();
    expect(preparePausedRestoreMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ndshare:abc:0', directStreamUrl: 'https://music.test/share/s/jwt-a' }),
      expect.any(Array),
      0,
      0,
    );
  });

  it('applies the server queue when no public share session is persisted', async () => {
    getPlayQueueForServerMock.mockResolvedValue({
      songs: [{ id: 'server-track' }],
      current: 'server-track',
      position: 0,
    });
    usePlayerStore.setState({
      queueServerId: 'music.test',
      queueItems: [{ serverId: 'music.test', trackId: 'local-track' }],
      queueIndex: 0,
      currentTrack: makeTrack({ id: 'local-track' }),
    });

    await usePlayerStore.getState().initializeFromServerQueue();

    expect(getPlayQueueForServerMock).toHaveBeenCalledWith('music.test');
    expect(usePlayerStore.getState().queueItems[0]?.trackId).toBe('server-track');
  });
});
