import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemRef } from '@/lib/media/trackTypes';

const getPlayQueueForServerMock = vi.fn();

vi.mock('@/lib/api/subsonicPlayQueue', () => ({
  getPlayQueueForServer: (...args: unknown[]) => getPlayQueueForServerMock(...args),
}));

vi.mock('@/lib/server/serverLookup', () => ({
  resolveServerIdForIndexKey: (id: string) => id,
}));

vi.mock('@/lib/media/songToTrack', () => ({
  songToTrack: (s: { id: string }) => ({
    id: s.id,
    title: s.id,
    artist: '',
    album: '',
    albumId: '',
    duration: 60,
    serverId: 'srv-a',
  }),
}));

vi.mock('@/features/playback/store/pausedRestorePrepare', () => ({
  preparePausedRestoreOnStartup: vi.fn(),
}));

vi.mock('@/features/playback/store/waveformRefresh', () => ({
  refreshWaveformForTrack: vi.fn(),
}));

vi.mock('@/features/playback/store/queueSyncUiState', () => ({
  clearQueueHandoffPending: vi.fn(),
}));

const playerState = {
  queueItems: [] as QueueItemRef[],
  queueIndex: 0,
  currentTrack: null as { id: string; title: string; artist: string; album: string; albumId: string; duration: number } | null,
  currentTime: 0,
  isPlaying: false,
};

vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: {
    getState: () => playerState,
    setState: (partial: Partial<typeof playerState>) => {
      Object.assign(playerState, partial);
    },
  },
}));

import { applyServerPlayQueue } from '@/features/playback/store/applyServerPlayQueue';
import {
  _resetQueuePlaybackIdleForTest,
  getIdlePullGeneration,
  isIdleQueuePullSuspended,
  touchQueueMutationClock,
} from '@/features/playback/store/queuePlaybackIdle';

describe('applyServerPlayQueue idle guards', () => {
  beforeEach(() => {
    _resetQueuePlaybackIdleForTest();
    getPlayQueueForServerMock.mockReset();
    playerState.queueItems = [{ serverId: 'srv-a', trackId: 'local-only' }];
    playerState.queueIndex = 0;
    playerState.currentTrack = {
      id: 'local-only',
      title: 'local-only',
      artist: '',
      album: '',
      albumId: '',
      duration: 60,
    };
    playerState.currentTime = 12;
    playerState.isPlaying = false;
  });

  it('does not apply server queue in idle mode while local edits suspend pull', async () => {
    getPlayQueueForServerMock.mockResolvedValue({
      songs: [{ id: 'remote-a' }, { id: 'remote-b' }],
      current: 'remote-a',
      position: 5000,
    });
    touchQueueMutationClock();

    const result = await applyServerPlayQueue('srv-a', { mode: 'idle' });

    expect(result).toBe('noop');
    expect(getPlayQueueForServerMock).not.toHaveBeenCalled();
    expect(playerState.queueItems).toEqual([{ serverId: 'srv-a', trackId: 'local-only' }]);
    expect(isIdleQueuePullSuspended()).toBe(true);
  });

  it('ignores stale idle pull responses after a local mutation during fetch', async () => {
    const generationAtFetch = getIdlePullGeneration();
    getPlayQueueForServerMock.mockImplementation(async () => {
      touchQueueMutationClock();
      expect(getIdlePullGeneration()).toBe(generationAtFetch + 1);
      return {
        songs: [{ id: 'remote-a' }],
        current: 'remote-a',
        position: 0,
      };
    });

    const result = await applyServerPlayQueue('srv-a', { mode: 'idle' });

    expect(result).toBe('noop');
    expect(playerState.queueItems).toEqual([{ serverId: 'srv-a', trackId: 'local-only' }]);
  });
});
