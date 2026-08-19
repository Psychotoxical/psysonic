/**
 * Unit coverage for the interpolated playback position. The point of the
 * module is that it keeps advancing between the throttled updates it receives,
 * so the tests drive `performance.now()` by hand and assert on the estimate
 * rather than on frame callbacks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPlaybackProgressForTest,
  emitPlaybackProgress,
} from '@/features/playback/store/playbackProgress';
import {
  _resetSmoothPlaybackTimeForTest,
  getSmoothPlaybackTime,
  subscribeSmoothPlaybackTime,
} from '@/features/playback/store/playbackProgressSmooth';
import { usePlaybackRateStore } from '@/features/playback/store/playbackRateStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';

let clock = 0;

/** Advance the wall clock the module reads, without running real frames. */
function advance(ms: number): void {
  clock += ms;
}

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  usePlayerStore.setState({ isPlaying: true });
  usePlaybackRateStore.setState({ enabled: false, speed: 1 });
});

afterEach(() => {
  _resetSmoothPlaybackTimeForTest();
  _resetPlaybackProgressForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('getSmoothPlaybackTime', () => {
  it('advances between updates while playing', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 10, progress: 0.1, buffered: 0 });

    advance(400);
    expect(getSmoothPlaybackTime()).toBeCloseTo(10.4, 3);

    advance(500);
    expect(getSmoothPlaybackTime()).toBeCloseTo(10.9, 3);
    off();
  });

  it('re-anchors on every real update instead of drifting', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 10, progress: 0.1, buffered: 0 });
    advance(900);

    // The engine reports a position slightly behind the estimate; the estimate
    // must follow the engine, not its own extrapolation.
    emitPlaybackProgress({ currentTime: 10.8, progress: 0.2, buffered: 0 });
    expect(getSmoothPlaybackTime()).toBeCloseTo(10.8, 3);

    advance(100);
    expect(getSmoothPlaybackTime()).toBeCloseTo(10.9, 3);
    off();
  });

  it('freezes while paused', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 30, progress: 0.3, buffered: 0 });
    advance(200);

    usePlayerStore.setState({ isPlaying: false });
    const atPause = getSmoothPlaybackTime();

    advance(5000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(atPause, 3);
    off();
  });

  it('does not advance while buffering', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 5, progress: 0.05, buffered: 0, buffering: true });

    advance(1000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(5, 3);
    off();
  });

  it('scales with the playback rate when one is active', () => {
    usePlaybackRateStore.setState({ enabled: true, speed: 1.5 });
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 0, progress: 0, buffered: 0 });

    advance(1000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(1.5, 3);
    off();
  });

  it('ignores the rate while the feature is disabled', () => {
    usePlaybackRateStore.setState({ enabled: false, speed: 1.5 });
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 0, progress: 0, buffered: 0 });

    advance(1000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(1, 3);
    off();
  });

  it('caps how far it runs past the last update', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 100, progress: 0.5, buffered: 0 });

    // Updates stop arriving; the estimate must not run away.
    advance(60_000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(102, 3);
    off();
  });
});

describe('subscribeSmoothPlaybackTime', () => {
  it('pushes the current estimate to listeners on each update', () => {
    const seen: number[] = [];
    const off = subscribeSmoothPlaybackTime(v => seen.push(v));

    emitPlaybackProgress({ currentTime: 7, progress: 0.07, buffered: 0 });
    emitPlaybackProgress({ currentTime: 8, progress: 0.08, buffered: 0 });

    expect(seen).toEqual([7, 8]);
    off();
  });

  it('stops listening once the last subscriber leaves', () => {
    const cb = vi.fn();
    const off = subscribeSmoothPlaybackTime(cb);
    emitPlaybackProgress({ currentTime: 1, progress: 0.01, buffered: 0 });
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    emitPlaybackProgress({ currentTime: 2, progress: 0.02, buffered: 0 });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
