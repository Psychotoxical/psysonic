/**
 * Smoke test for the queue-undo engine-restore orchestrator. Verifies
 * the audio_play payload shape, the seek follow-up that fires when
 * atSeconds > 0.05, the wantPlaying=false branch that issues audio_pause,
 * and the generation-mismatch bail-out.
 */
import type { Track } from './playerStoreTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const hoisted = vi.hoisted(() => {
  const auth = {
    activeServerId: 'srv',
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
vi.mock('../utils/hotCacheGate', () => ({ setDeferHotCachePrefetch: hoisted.setDeferHotCachePrefetchMock }));
vi.mock('../utils/resolvePlaybackUrl', () => ({ resolvePlaybackUrl: hoisted.resolvePlaybackUrlMock }));
vi.mock('../utils/resolveReplayGainDb', () => ({ resolveReplayGainDb: hoisted.resolveReplayGainDbMock }));
vi.mock('./authStore', () => ({ useAuthStore: { getState: () => hoisted.auth } }));
vi.mock('./engineState', () => ({
  getPlayGeneration: hoisted.getPlayGeneration,
  setIsAudioPaused: hoisted.setIsAudioPausedMock,
}));
vi.mock('./hotCacheTouch', () => ({ touchHotCacheOnPlayback: hoisted.touchHotCacheOnPlaybackMock }));
vi.mock('./loudnessGainCache', () => ({
  isReplayGainActive: hoisted.isReplayGainActiveMock,
  loudnessGainDbForEngineBind: hoisted.loudnessGainDbForEngineBindMock,
}));
vi.mock('./playbackUrlRouting', () => ({
  playbackSourceHintForResolvedUrl: hoisted.playbackSourceHintMock,
  recordEnginePlayUrl: hoisted.recordEnginePlayUrlMock,
}));
vi.mock('./playerStore', () => ({
  usePlayerStore: {
    getState: () => hoisted.player,
    setState: hoisted.playerSetStateMock,
  },
}));

import { queueUndoRestoreAudioEngine } from './queueUndoAudioRestore';

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
    expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_play', expect.objectContaining({
      url: 'https://mock/t1',
      durationHint: 100,
      manual: false,
      analysisTrackId: 't1',
    }));
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
    await Promise.resolve();
    await Promise.resolve();
    expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_seek', { seconds: 30 });
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
    await Promise.resolve();
    await Promise.resolve();
    const seekCall = hoisted.invokeMock.mock.calls.find(c => c[0] === 'audio_seek');
    expect(seekCall).toBeUndefined();
  });

  it('issues audio_pause when wantPlaying=false', async () => {
    queueUndoRestoreAudioEngine({
      generation: 1,
      track: track('t1'),
      queue: [track('t1')],
      queueIndex: 0,
      atSeconds: 0,
      wantPlaying: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_pause');
    expect(hoisted.setIsAudioPausedMock).toHaveBeenCalledWith(true);
  });

  it('bails out of the .then chain when generation has moved on', async () => {
    hoisted.getPlayGeneration.mockReturnValue(2); // user navigated, new gen
    queueUndoRestoreAudioEngine({
      generation: 1,
      track: track('t1'),
      queue: [track('t1')],
      queueIndex: 0,
      atSeconds: 30,
      wantPlaying: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    // Should NOT have called audio_seek or audio_pause — gen moved on.
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
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(hoisted.setDeferHotCachePrefetchMock).toHaveBeenCalledWith(false);
  });
});
