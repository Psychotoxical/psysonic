/**
 * Seek-fallback retry loop + visual target accessors. The retry timer
 * fires every 180 ms (SEEK_FALLBACK_RETRY_INTERVAL_MS) up to 6 s
 * (SEEK_FALLBACK_RETRY_MAX_MS). Success calls setSeekTarget + clears the
 * visual target; recoverable errors re-schedule; non-recoverable errors
 * abort + clear visual target.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const playerState = { currentTrack: null as { id: string } | null };
  return {
    invokeMock: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => undefined),
    setSeekTargetMock: vi.fn(),
    isRecoverableSeekErrorMock: vi.fn((msg: string) => msg.includes('not seekable')),
    playerStateGet: () => playerState,
    playerState,
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: hoisted.invokeMock }));
vi.mock('../utils/audio/seekErrors', () => ({ isRecoverableSeekError: hoisted.isRecoverableSeekErrorMock }));
vi.mock('./seekTargetState', () => ({ setSeekTarget: hoisted.setSeekTargetMock }));
vi.mock('./playerStore', () => ({
  usePlayerStore: { getState: hoisted.playerStateGet },
}));

import {
  SEEK_FALLBACK_RETRY_INTERVAL_MS,
  SEEK_FALLBACK_RETRY_MAX_MS,
  SEEK_FALLBACK_VISUAL_GUARD_MS,
  _resetSeekFallbackStateForTest,
  clearSeekFallbackRetry,
  getSeekFallbackRestartAt,
  getSeekFallbackTrackId,
  getSeekFallbackVisualTarget,
  scheduleSeekFallbackRetry,
  setSeekFallbackRestartAt,
  setSeekFallbackTrackId,
  setSeekFallbackVisualTarget,
} from './seekFallbackState';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  hoisted.invokeMock.mockReset();
  hoisted.invokeMock.mockResolvedValue(undefined);
  hoisted.setSeekTargetMock.mockClear();
  hoisted.isRecoverableSeekErrorMock.mockReset();
  hoisted.isRecoverableSeekErrorMock.mockImplementation((msg: string) => msg.includes('not seekable'));
  hoisted.playerState.currentTrack = { id: 't1' };
});

afterEach(() => {
  _resetSeekFallbackStateForTest();
  vi.useRealTimers();
});

describe('constants', () => {
  it('match the values the runtime expects', () => {
    expect(SEEK_FALLBACK_VISUAL_GUARD_MS).toBe(1600);
    expect(SEEK_FALLBACK_RETRY_INTERVAL_MS).toBe(180);
    expect(SEEK_FALLBACK_RETRY_MAX_MS).toBe(6000);
  });
});

describe('visual target accessors', () => {
  it('start at null', () => {
    expect(getSeekFallbackVisualTarget()).toBeNull();
  });

  it('round-trip through set/get', () => {
    const target = { trackId: 't1', seconds: 42, setAtMs: 1000 };
    setSeekFallbackVisualTarget(target);
    expect(getSeekFallbackVisualTarget()).toEqual(target);
  });

  it('accept null to clear', () => {
    setSeekFallbackVisualTarget({ trackId: 't1', seconds: 1, setAtMs: 0 });
    setSeekFallbackVisualTarget(null);
    expect(getSeekFallbackVisualTarget()).toBeNull();
  });
});

describe('trackId + restartAt accessors', () => {
  it('start at null / 0', () => {
    expect(getSeekFallbackTrackId()).toBeNull();
    expect(getSeekFallbackRestartAt()).toBe(0);
  });

  it('round-trip', () => {
    setSeekFallbackTrackId('t1');
    setSeekFallbackRestartAt(12345);
    expect(getSeekFallbackTrackId()).toBe('t1');
    expect(getSeekFallbackRestartAt()).toBe(12345);
  });
});

describe('clearSeekFallbackRetry', () => {
  it('is a no-op when nothing is scheduled', () => {
    expect(() => clearSeekFallbackRetry()).not.toThrow();
  });

  it('cancels a pending retry', () => {
    scheduleSeekFallbackRetry('t1', 10);
    clearSeekFallbackRetry();
    vi.advanceTimersByTime(SEEK_FALLBACK_RETRY_MAX_MS);
    // No invoke fired because the timer was cancelled.
    expect(hoisted.invokeMock).not.toHaveBeenCalled();
  });
});

describe('scheduleSeekFallbackRetry — happy path', () => {
  it('fires `audio_seek` after the retry interval', async () => {
    scheduleSeekFallbackRetry('t1', 30);
    vi.advanceTimersByTime(SEEK_FALLBACK_RETRY_INTERVAL_MS);
    expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_seek', { seconds: 30 });
  });

  it('calls setSeekTarget + clears visual target on a successful invoke', async () => {
    setSeekFallbackVisualTarget({ trackId: 't1', seconds: 30, setAtMs: Date.now() });
    scheduleSeekFallbackRetry('t1', 30);
    hoisted.invokeMock.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(SEEK_FALLBACK_RETRY_INTERVAL_MS);
    await Promise.resolve();
    expect(hoisted.setSeekTargetMock).toHaveBeenCalledWith(30);
    expect(getSeekFallbackVisualTarget()).toBeNull();
  });
});

describe('scheduleSeekFallbackRetry — error branches', () => {
  it('re-schedules on a recoverable error', async () => {
    hoisted.invokeMock
      .mockRejectedValueOnce(new Error('not seekable'))
      .mockResolvedValueOnce(undefined);
    scheduleSeekFallbackRetry('t1', 30);
    await vi.advanceTimersByTimeAsync(SEEK_FALLBACK_RETRY_INTERVAL_MS);
    await Promise.resolve();
    // Second attempt scheduled — fire after another interval.
    await vi.advanceTimersByTimeAsync(SEEK_FALLBACK_RETRY_INTERVAL_MS);
    await Promise.resolve();
    expect(hoisted.invokeMock).toHaveBeenCalledTimes(2);
    expect(hoisted.setSeekTargetMock).toHaveBeenCalledWith(30);
  });

  it('clears visual target + aborts on non-recoverable error', async () => {
    setSeekFallbackVisualTarget({ trackId: 't1', seconds: 30, setAtMs: Date.now() });
    hoisted.invokeMock.mockRejectedValueOnce(new Error('codec broken'));
    hoisted.isRecoverableSeekErrorMock.mockReturnValueOnce(false);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    scheduleSeekFallbackRetry('t1', 30);
    await vi.advanceTimersByTimeAsync(SEEK_FALLBACK_RETRY_INTERVAL_MS);
    await Promise.resolve();
    expect(getSeekFallbackVisualTarget()).toBeNull();
    consoleSpy.mockRestore();
  });

  it('aborts when the timer fires after the track has changed', async () => {
    scheduleSeekFallbackRetry('t1', 30);
    hoisted.playerState.currentTrack = { id: 't2' };
    await vi.advanceTimersByTimeAsync(SEEK_FALLBACK_RETRY_INTERVAL_MS);
    expect(hoisted.invokeMock).not.toHaveBeenCalled();
  });

  it('aborts when the retry budget is exhausted', async () => {
    setSeekFallbackVisualTarget({ trackId: 't1', seconds: 30, setAtMs: Date.now() });
    // Advance system time past the budget BEFORE the scheduled callback runs.
    scheduleSeekFallbackRetry('t1', 30);
    vi.advanceTimersByTime(SEEK_FALLBACK_RETRY_INTERVAL_MS / 2);
    vi.setSystemTime(new Date(Date.now() + SEEK_FALLBACK_RETRY_MAX_MS + 1));
    await vi.advanceTimersByTimeAsync(SEEK_FALLBACK_RETRY_INTERVAL_MS);
    expect(hoisted.invokeMock).not.toHaveBeenCalled();
    expect(getSeekFallbackVisualTarget()).toBeNull();
  });
});

describe('scheduleSeekFallbackRetry — coalescing', () => {
  it('replaces the target when track id changes', () => {
    scheduleSeekFallbackRetry('t1', 30);
    scheduleSeekFallbackRetry('t2', 45);
    hoisted.playerState.currentTrack = { id: 't2' };
    vi.advanceTimersByTime(SEEK_FALLBACK_RETRY_INTERVAL_MS);
    expect(hoisted.invokeMock).toHaveBeenCalledTimes(1);
    expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_seek', { seconds: 45 });
  });

  it('replaces the target when seconds differ by more than 0.25 s', () => {
    scheduleSeekFallbackRetry('t1', 30);
    scheduleSeekFallbackRetry('t1', 31);
    vi.advanceTimersByTime(SEEK_FALLBACK_RETRY_INTERVAL_MS);
    expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_seek', { seconds: 31 });
  });

  it('reuses the target when seconds are close (≤0.25 s)', () => {
    scheduleSeekFallbackRetry('t1', 30);
    scheduleSeekFallbackRetry('t1', 30.1);
    vi.advanceTimersByTime(SEEK_FALLBACK_RETRY_INTERVAL_MS);
    // Original target (30) used because seconds are within 0.25.
    expect(hoisted.invokeMock).toHaveBeenCalledWith('audio_seek', { seconds: 30 });
  });
});
