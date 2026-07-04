import type { Track } from '@/lib/media/trackTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => undefined),
  emitMock: vi.fn(),
  setSeekMock: vi.fn(),
  prefetchMock: vi.fn(),
  promoteMock: vi.fn(async () => undefined),
  engineLoadMock: vi.fn(),
  bumpGenMock: vi.fn(() => 7),
  getGenMock: vi.fn(() => 7),
  playerState: {
    isPlaying: false,
    currentRadio: null as { streamUrl: string } | null,
    volume: 0.8,
  },
  authState: {
    hotCacheEnabled: true,
    hotCacheDownloadDir: '/tmp/hot',
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: hoisted.invokeMock }));
vi.mock('@/features/playback/store/playbackProgress', () => ({ emitPlaybackProgress: hoisted.emitMock }));
vi.mock('@/features/playback/store/seekFallbackState', () => ({ setSeekFallbackVisualTarget: hoisted.setSeekMock }));
vi.mock('@/hotCachePrefetch', () => ({ scheduleHotCachePrefetchForTrack: hoisted.prefetchMock }));
vi.mock('@/features/playback/store/promoteStreamCache', () => ({ promoteCompletedStreamToHotCache: hoisted.promoteMock }));
vi.mock('@/features/playback/store/engineLoadTrackAtPosition', () => ({ engineLoadTrackAtPosition: hoisted.engineLoadMock }));
vi.mock('@/features/playback/store/engineState', () => ({
  bumpPlayGeneration: hoisted.bumpGenMock,
  getPlayGeneration: hoisted.getGenMock,
}));
vi.mock('@/store/authStore', () => ({ useAuthStore: { getState: () => hoisted.authState } }));
vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: {
    getState: () => hoisted.playerState,
    setState: vi.fn((partial: Record<string, unknown>) => {
      Object.assign(hoisted.playerState, partial);
    }),
  },
}));
vi.mock('@/features/playback/store/queueTrackView', () => ({
  getQueueTracksView: vi.fn((refs: { trackId: string }[]) =>
    refs.map(r => ({
      id: r.trackId,
      title: r.trackId,
      artist: 'A',
      album: 'B',
      albumId: 'B',
      duration: 200,
    })),
  ),
}));
vi.mock('@/features/playback/utils/playback/playbackServer', () => ({
  getPlaybackCacheServerKey: () => 'srv-key',
  playbackCacheKeyForTrack: () => 'srv-key',
}));
vi.mock('@/features/playback/utils/audio/prepareTrackForEngineBind', () => ({
  prepareTrackForEngineBind: vi.fn(async (track: Track) => track),
}));

import {
  applyRestoredPlaybackVisual,
  preparePausedRestoreOnStartup,
} from '@/features/playback/store/pausedRestorePrepare';

function track(id: string, duration = 200): Track {
  return { id, title: id, artist: 'A', album: 'B', albumId: 'B', duration };
}

beforeEach(() => {
  hoisted.invokeMock.mockClear();
  hoisted.emitMock.mockClear();
  hoisted.setSeekMock.mockClear();
  hoisted.prefetchMock.mockClear();
  hoisted.promoteMock.mockClear();
  hoisted.engineLoadMock.mockClear();
  hoisted.bumpGenMock.mockClear();
  hoisted.getGenMock.mockReturnValue(7);
  hoisted.playerState.isPlaying = false;
  hoisted.playerState.currentRadio = null;
});

describe('applyRestoredPlaybackVisual', () => {
  it('updates store progress and emits playback progress', () => {
    applyRestoredPlaybackVisual(track('t1'), 50);
    expect(hoisted.emitMock).toHaveBeenCalledWith({
      currentTime: 50,
      progress: 0.25,
      buffered: 0,
      buffering: false,
    });
    expect(hoisted.setSeekMock).toHaveBeenCalledWith({
      trackId: 't1',
      seconds: 50,
      setAtMs: expect.any(Number),
    });
  });
});

describe('preparePausedRestoreOnStartup', () => {
  it('prefetches, promotes stream cache, and loads the engine paused', async () => {
    preparePausedRestoreOnStartup(
      track('t1'),
      [{ serverId: 'srv', trackId: 't1' }],
      0,
      42,
    );
    expect(hoisted.prefetchMock).toHaveBeenCalled();
    expect(hoisted.bumpGenMock).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(hoisted.promoteMock).toHaveBeenCalled();
      expect(hoisted.engineLoadMock).toHaveBeenCalledWith(expect.objectContaining({
        generation: 7,
        atSeconds: 42,
        wantPlaying: false,
      }));
    });
  });

  it('skips when transport is already playing', () => {
    hoisted.playerState.isPlaying = true;
    preparePausedRestoreOnStartup(track('t1'), [], 0, 10);
    expect(hoisted.engineLoadMock).not.toHaveBeenCalled();
    expect(hoisted.prefetchMock).not.toHaveBeenCalled();
  });
});
