/**
 * `refreshLoudnessForTrack` orchestrates the loudness analysis fetch:
 * coalesce concurrent calls, distinguish hit vs miss, enqueue backfill
 * within bounds, suppress stale-target results. The individual helpers
 * (cache, backfill state, window predicate, debug emit) are tested in
 * their own modules — this file pins the orchestration only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const auth = {
    loudnessTargetLufs: -14,
    normalizationEngine: 'loudness' as 'off' | 'replaygain' | 'loudness',
  };
  const playerState = {
    queue: [] as Array<{ id: string }>,
    queueIndex: 0,
    currentTrack: null as { id: string } | null,
    updateReplayGainForCurrentTrack: vi.fn(),
  };
  return {
    auth,
    playerState,
    invokeMock: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => null as unknown),
    buildStreamUrlMock: vi.fn((id: string) => `https://mock/stream/${id}`),
    redactMock: vi.fn((s: string) => s),
    playerSetStateMock: vi.fn(),
    emitDebugMock: vi.fn(),
    forgetLoudnessMock: vi.fn(),
    markLoudnessStableMock: vi.fn(),
    getBackfillAttemptsMock: vi.fn(() => 0),
    isBackfillInFlightMock: vi.fn(() => false),
    markBackfillInFlightMock: vi.fn(),
    clearBackfillInFlightMock: vi.fn(),
    resetBackfillAttemptsMock: vi.fn(),
    isTrackInsideWindowMock: vi.fn(() => true),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: hoisted.invokeMock }));
vi.mock('../api/subsonic', () => ({ buildStreamUrl: hoisted.buildStreamUrlMock }));
vi.mock('../utils/redactSubsonicUrl', () => ({ redactSubsonicUrlForLog: hoisted.redactMock }));
vi.mock('./authStore', () => ({ useAuthStore: { getState: () => hoisted.auth } }));
vi.mock('./playerStore', () => ({
  usePlayerStore: {
    getState: () => hoisted.playerState,
    setState: hoisted.playerSetStateMock,
  },
}));
vi.mock('./normalizationDebug', () => ({ emitNormalizationDebug: hoisted.emitDebugMock }));
vi.mock('./loudnessGainCache', () => ({
  forgetLoudnessGain: hoisted.forgetLoudnessMock,
  markLoudnessStable: hoisted.markLoudnessStableMock,
}));
vi.mock('./loudnessBackfillState', () => ({
  MAX_BACKFILL_ATTEMPTS_PER_TRACK: 2,
  clearBackfillInFlight: hoisted.clearBackfillInFlightMock,
  getBackfillAttempts: hoisted.getBackfillAttemptsMock,
  isBackfillInFlight: hoisted.isBackfillInFlightMock,
  markBackfillInFlight: hoisted.markBackfillInFlightMock,
  resetBackfillAttempts: hoisted.resetBackfillAttemptsMock,
}));
vi.mock('./loudnessBackfillWindow', () => ({
  LOUDNESS_BACKFILL_WINDOW_AHEAD: 5,
  isTrackInsideLoudnessBackfillWindow: hoisted.isTrackInsideWindowMock,
}));

import {
  _resetLoudnessRefreshInflightForTest,
  refreshLoudnessForTrack,
} from './loudnessRefresh';

beforeEach(() => {
  _resetLoudnessRefreshInflightForTest();
  hoisted.auth.loudnessTargetLufs = -14;
  hoisted.auth.normalizationEngine = 'loudness';
  hoisted.playerState.queue = [];
  hoisted.playerState.queueIndex = 0;
  hoisted.playerState.currentTrack = null;
  hoisted.invokeMock.mockReset();
  hoisted.invokeMock.mockResolvedValue(null);
  hoisted.playerSetStateMock.mockClear();
  hoisted.emitDebugMock.mockClear();
  hoisted.forgetLoudnessMock.mockClear();
  hoisted.markLoudnessStableMock.mockClear();
  hoisted.markBackfillInFlightMock.mockClear();
  hoisted.clearBackfillInFlightMock.mockClear();
  hoisted.resetBackfillAttemptsMock.mockClear();
  hoisted.getBackfillAttemptsMock.mockReset();
  hoisted.getBackfillAttemptsMock.mockReturnValue(0);
  hoisted.isBackfillInFlightMock.mockReset();
  hoisted.isBackfillInFlightMock.mockReturnValue(false);
  hoisted.isTrackInsideWindowMock.mockReset();
  hoisted.isTrackInsideWindowMock.mockReturnValue(true);
  hoisted.playerState.updateReplayGainForCurrentTrack = vi.fn();
});

describe('refreshLoudnessForTrack', () => {
  it('is a no-op for empty trackId', async () => {
    await refreshLoudnessForTrack('');
    expect(hoisted.invokeMock).not.toHaveBeenCalled();
  });

  it('coalesces concurrent calls for the same key into one inflight promise', async () => {
    hoisted.invokeMock.mockResolvedValue(null);
    const p1 = refreshLoudnessForTrack('t1');
    const p2 = refreshLoudnessForTrack('t1');
    await Promise.all([p1, p2]);
    // One analysis_get_loudness_for_track call shared between both awaiters.
    const getCalls = hoisted.invokeMock.mock.calls.filter(c => c[0] === 'analysis_get_loudness_for_track');
    expect(getCalls).toHaveLength(1);
  });

  it('marks loudness stable on a hit row', async () => {
    hoisted.invokeMock.mockResolvedValueOnce({ recommendedGainDb: -7, targetLufs: -14, updatedAt: 123 });
    await refreshLoudnessForTrack('t1');
    expect(hoisted.markLoudnessStableMock).toHaveBeenCalledWith('t1', -7);
    expect(hoisted.resetBackfillAttemptsMock).toHaveBeenCalledWith('t1');
  });

  it('forgets the cached value on a miss row', async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await refreshLoudnessForTrack('t1');
    expect(hoisted.forgetLoudnessMock).toHaveBeenCalledWith('t1');
  });

  it('enqueues a backfill when conditions are met (loudness engine, not inflight, attempts < max, in window)', async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    await refreshLoudnessForTrack('t1');
    expect(hoisted.markBackfillInFlightMock).toHaveBeenCalledWith('t1', 1);
    const enqueueCall = hoisted.invokeMock.mock.calls.find(c => c[0] === 'analysis_enqueue_seed_from_url');
    expect(enqueueCall).toBeDefined();
  });

  it('skips backfill when outside the prefetch window', async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    hoisted.isTrackInsideWindowMock.mockReturnValueOnce(false);
    await refreshLoudnessForTrack('t1');
    expect(hoisted.markBackfillInFlightMock).not.toHaveBeenCalled();
    const enqueueCall = hoisted.invokeMock.mock.calls.find(c => c[0] === 'analysis_enqueue_seed_from_url');
    expect(enqueueCall).toBeUndefined();
  });

  it('skips backfill when attempts already at max', async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    hoisted.getBackfillAttemptsMock.mockReturnValueOnce(2);
    await refreshLoudnessForTrack('t1');
    expect(hoisted.markBackfillInFlightMock).not.toHaveBeenCalled();
    const throttledCalls = hoisted.emitDebugMock.mock.calls.filter(c => c[0] === 'backfill:throttled');
    expect(throttledCalls.length).toBeGreaterThan(0);
  });

  it('skips backfill when already inflight', async () => {
    hoisted.invokeMock.mockResolvedValueOnce(null);
    hoisted.isBackfillInFlightMock.mockReturnValueOnce(true);
    await refreshLoudnessForTrack('t1');
    expect(hoisted.markBackfillInFlightMock).not.toHaveBeenCalled();
  });

  it('discards results and retries when the LUFS target changes mid-flight', async () => {
    hoisted.invokeMock.mockImplementationOnce(async () => {
      hoisted.auth.loudnessTargetLufs = -10; // target changes during await
      return { recommendedGainDb: -5, targetLufs: -14, updatedAt: 1 };
    });
    hoisted.invokeMock.mockResolvedValueOnce(null); // retry returns miss
    await refreshLoudnessForTrack('t1');
    // markLoudnessStable should NOT have been called from the first invocation —
    // result is discarded because target changed.
    expect(hoisted.markLoudnessStableMock).not.toHaveBeenCalled();
    const staleCalls = hoisted.emitDebugMock.mock.calls.filter(c => c[0] === 'refresh:stale-target');
    expect(staleCalls).toHaveLength(1);
    // Drain pending recursive retries spawned via `void refreshLoudnessForTrack(...)`
    // so they don't bleed into the next test's mock queue.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

  it('skips engine update when syncPlayingEngine is false', async () => {
    hoisted.invokeMock.mockResolvedValueOnce({ recommendedGainDb: -7, targetLufs: -14, updatedAt: 1 });
    await refreshLoudnessForTrack('t1', { syncPlayingEngine: false });
    expect(hoisted.playerState.updateReplayGainForCurrentTrack).not.toHaveBeenCalled();
  });

  it('calls updateReplayGainForCurrentTrack by default on hit', async () => {
    hoisted.invokeMock.mockResolvedValueOnce({ recommendedGainDb: -7, targetLufs: -14, updatedAt: 1 });
    await refreshLoudnessForTrack('t1');
    expect(hoisted.playerState.updateReplayGainForCurrentTrack).toHaveBeenCalledTimes(1);
  });

  it('forgets cache + emits refresh:error on a thrown invoke', async () => {
    hoisted.invokeMock.mockRejectedValueOnce(new Error('rust busy'));
    await refreshLoudnessForTrack('t1');
    expect(hoisted.forgetLoudnessMock).toHaveBeenCalledWith('t1');
    const errCalls = hoisted.emitDebugMock.mock.calls.filter(c => c[0] === 'refresh:error');
    expect(errCalls).toHaveLength(1);
  });
});
