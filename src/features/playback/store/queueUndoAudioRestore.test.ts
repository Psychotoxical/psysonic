/**
 * Smoke test for the queue-undo engine-restore orchestrator. Verifies
 * the audio_play payload shape, the seek follow-up that fires when
 * atSeconds > 0.05, the wantPlaying=false branch that issues audio_pause,
 * and the generation-mismatch bail-out.
 */
import type { Track } from '@/lib/media/trackTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const hoisted = vi.hoisted(() => {
  const auth = {
    activeServerId: 'srv',
    servers: [],
    replayGainMode: 'track' as 'track' | 'album',
    replayGainPreGainDb: 0,
    replayGainFallbackDb: -6,
    enableHiRes: false,
  };
  const player = {
    volume: 0.8,
    enginePreloadedTrackId: null as string | null,
  };
  return {
    auth,
    player,
    invokeMock: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => undefined),
    setDeferHotCachePrefetchMock: vi.fn(),
    resolvePlaybackUrlMock: vi.fn((id: string) => `https://mock/${id}`),
    resolveReplayGainDbMock: vi.fn(() => -6),
    isReplayGainActiveMock: vi.fn(() => false),
    loudnessGainDbForEngineBindMock: vi.fn(() => null as number | null),
    recordEnginePlayUrlMock: vi.fn(),
    playbackSourceHintMock: vi.fn(() => 'stream'),
    touchHotCacheOnPlaybackMock: vi.fn(),
    playerSetStateMock: vi.fn(),
    setIsAudioPausedMock: vi.fn(),
    getPlayGeneration: vi.fn(() => 1),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: hoisted.invokeMock }));
vi.mock('@/lib/cache/hotCacheGate', () => ({ setDeferHotCachePrefetch: hoisted.setDeferHotCachePrefetchMock }));
vi.mock('@/features/playback/utils/playback/resolvePlaybackUrl', () => ({
  resolvePlaybackUrl: hoisted.resolvePlaybackUrlMock,
  resolvePlaybackUrlForTrack: (
    track: { id: string; directStreamUrl?: string },
  ) => track.directStreamUrl ?? hoisted.resolvePlaybackUrlMock(track.id),
}));
vi.mock('@/features/playback/utils/audio/resolveReplayGainDb', () => ({ resolveReplayGainDb: hoisted.resolveReplayGainDbMock }));
vi.mock('@/store/authStore', () => ({ useAuthStore: { getState: () => hoisted.auth } }));
vi.mock('@/features/playback/store/engineState', () => ({
  getPlayGeneration: hoisted.getPlayGeneration,
  setIsAudioPaused: hoisted.setIsAudioPausedMock,
}));
vi.mock('@/features/playback/store/hotCacheTouch', () => ({ touchHotCacheOnPlayback: hoisted.touchHotCacheOnPlaybackMock }));
vi.mock('@/features/playback/store/loudnessGainCache', () => ({
  isReplayGainActive: hoisted.isReplayGainActiveMock,
  loudnessGainDbForEngineBind: hoisted.loudnessGainDbForEngineBindMock,
}));
vi.mock('@/features/playback/store/playbackUrlRouting', () => ({
  playbackSourceHintForResolvedUrl: hoisted.playbackSourceHintMock,
  recordEnginePlayUrl: hoisted.recordEnginePlayUrlMock,
}));
vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: {
    getState: () => hoisted.player,
    setState: hoisted.playerSetStateMock,
  },
}));
vi.mock('@/features/playback/utils/audio/prepareTrackForEngineBind', () => ({
  prepareTrackForEngineBind: vi.fn(async (track: Track) => track),
}));

import { queueUndoRestoreAudioEngine } from '@/features/playback/store/queueUndoAudioRestore';

function track(id: string, duration = 100): Track {
  return { id, title: id, artist: 'A', album: 'X', albumId: 'X', duration };
}

beforeEach(() => {
  hoisted.invokeMock.mockReset();
  hoisted.invokeMock.mockResolvedValue(undefined);
  hoisted.setDeferHotCachePrefetchMock.mockClear();
  hoisted.touchHotCacheOnPlaybackMock.mockClear();
  hoisted.playerSetStateMock.mockClear();
  hoisted.setIsAudioPausedMock.mockClear();
  hoisted.recordEnginePlayUrlMock.mockClear();
  hoisted.getPlayGeneration.mockReturnValue(1);
  hoisted.player.enginePreloadedTrackId = null;
});

describe('queueUndoRestoreAudioEngine', () => {
  it('issues audio_play with the snapshot track parameters', async () => {
    queueUndoRestoreAudioEngine({
      generation: 1,
      track: track('t1'),
      queue: [track('t1')],
      queueIndex: 0,
      atSeconds: 0,
      wantPlaying: true,
    });
    await vi.waitFor(() => {
      expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_play', expect.objectContaining({
        url: 'https://mock/t1',
        durationHint: 100,
        manual: false,
        analysisTrackId: 't1',
      }));
    });
    expect(hoisted.recordEnginePlayUrlMock).toHaveBeenCalledWith('t1', 'https://mock/t1');
    expect(hoisted.setDeferHotCachePrefetchMock).toHaveBeenCalledWith(true);
    expect(hoisted.touchHotCacheOnPlaybackMock).toHaveBeenCalledWith('t1', 'srv');
  });

  it('fires audio_seek when atSeconds > 0.05', async () => {
    queueUndoRestoreAudioEngine({
      generation: 1,
      track: track('t1'),
      queue: [track('t1')],
      queueIndex: 0,
      atSeconds: 30,
      wantPlaying: true,
    });
    await vi.waitFor(() => {
      expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_seek', { seconds: 30 });
    });
  });

  it('skips audio_seek when atSeconds is near zero', async () => {
    queueUndoRestoreAudioEngine({
      generation: 1,
      track: track('t1'),
      queue: [track('t1')],
      queueIndex: 0,
      atSeconds: 0,
      wantPlaying: true,
    });
    await vi.waitFor(() => {
      expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_play', expect.anything());
    });
    await Promise.resolve();
    const seekCall = hoisted.invokeMock.mock.calls.find(c => c[0] === 'audio_seek');
    expect(seekCall).toBeUndefined();
  });

  it('loads with startPaused and skips audio_pause when wantPlaying=false', async () => {
    queueUndoRestoreAudioEngine({
      generation: 1,
      track: track('t1'),
      queue: [track('t1')],
      queueIndex: 0,
      atSeconds: 0,
      wantPlaying: false,
    });
    await vi.waitFor(() => {
      expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_play', expect.objectContaining({
        startPaused: true,
      }));
    });
    const pauseCall = hoisted.invokeMock.mock.calls.find(c => c[0] === 'audio_pause');
    expect(pauseCall).toBeUndefined();
    expect(hoisted.setIsAudioPausedMock).toHaveBeenCalledWith(true);
  });

  it('bails out before audio_play when generation has moved on during prepare', async () => {
    hoisted.getPlayGeneration.mockReturnValue(2); // user navigated, new gen
    queueUndoRestoreAudioEngine({
      generation: 1,
      track: track('t1'),
      queue: [track('t1')],
      queueIndex: 0,
      atSeconds: 30,
      wantPlaying: false,
    });
    await vi.waitFor(() => {
      expect(hoisted.invokeMock.mock.calls.length).toBe(0);
    });
    const seekCall = hoisted.invokeMock.mock.calls.find(c => c[0] === 'audio_seek');
    const pauseCall = hoisted.invokeMock.mock.calls.find(c => c[0] === 'audio_pause');
    expect(seekCall).toBeUndefined();
    expect(pauseCall).toBeUndefined();
  });

  it('clears the deferHotCachePrefetch gate in .finally even on error', async () => {
    hoisted.invokeMock.mockRejectedValueOnce(new Error('rust down'));
    queueUndoRestoreAudioEngine({
      generation: 1,
      track: track('t1'),
      queue: [track('t1')],
      queueIndex: 0,
      atSeconds: 0,
      wantPlaying: true,
    });
    await vi.waitFor(() => {
      expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_play', expect.anything());
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(hoisted.setDeferHotCachePrefetchMock).toHaveBeenCalledWith(false);
  });
});
