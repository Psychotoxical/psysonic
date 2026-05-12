/**
 * Direct unit coverage for the playback-progress pub/sub — focused on the
 * delta-short-circuit behaviour that keeps idle CPU bounded. The end-to-end
 * "Tauri event → emit → subscriber" path is covered by
 * `playerStore.progress.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPlaybackProgressForTest,
  emitPlaybackProgress,
  getPlaybackProgressSnapshot,
  subscribePlaybackProgress,
} from './playbackProgress';

afterEach(() => {
  _resetPlaybackProgressForTest();
});

describe('getPlaybackProgressSnapshot', () => {
  it('starts at zero', () => {
    const snap = getPlaybackProgressSnapshot();
    expect(snap).toEqual({ currentTime: 0, progress: 0, buffered: 0 });
  });

  it('returns the latest snapshot after an emit', () => {
    emitPlaybackProgress({ currentTime: 42, progress: 0.5, buffered: 0.7 });
    expect(getPlaybackProgressSnapshot()).toEqual({ currentTime: 42, progress: 0.5, buffered: 0.7 });
  });
});

describe('subscribePlaybackProgress', () => {
  it('fires the listener with (next, prev) on a meaningful change', () => {
    const cb = vi.fn();
    subscribePlaybackProgress(cb);
    emitPlaybackProgress({ currentTime: 1, progress: 0.1, buffered: 0.2 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toEqual({ currentTime: 1, progress: 0.1, buffered: 0.2 });
    expect(cb.mock.calls[0][1]).toEqual({ currentTime: 0, progress: 0, buffered: 0 });
  });

  it('returns an unsubscribe that detaches the listener', () => {
    const cb = vi.fn();
    const unsub = subscribePlaybackProgress(cb);
    unsub();
    emitPlaybackProgress({ currentTime: 1, progress: 0.1, buffered: 0.2 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('fans out to multiple listeners', () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribePlaybackProgress(a);
    subscribePlaybackProgress(b);
    emitPlaybackProgress({ currentTime: 1, progress: 0.1, buffered: 0.2 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('emitPlaybackProgress delta short-circuit', () => {
  it('skips emits whose deltas are below thresholds (currentTime <0.005, progress/buffered <0.0002)', () => {
    const cb = vi.fn();
    subscribePlaybackProgress(cb);
    emitPlaybackProgress({ currentTime: 1.0, progress: 0.5, buffered: 0.6 });
    expect(cb).toHaveBeenCalledTimes(1);
    // All deltas below the cut-off — must be suppressed.
    emitPlaybackProgress({ currentTime: 1.001, progress: 0.50005, buffered: 0.60005 });
    expect(cb).toHaveBeenCalledTimes(1);
    // currentTime delta crosses the 0.005 threshold — fires.
    emitPlaybackProgress({ currentTime: 1.01, progress: 0.50005, buffered: 0.60005 });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('fires when only progress crosses its threshold', () => {
    const cb = vi.fn();
    subscribePlaybackProgress(cb);
    emitPlaybackProgress({ currentTime: 1.0, progress: 0.5, buffered: 0.6 });
    cb.mockClear();
    emitPlaybackProgress({ currentTime: 1.0, progress: 0.5005, buffered: 0.6 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not advance the snapshot when an emit is suppressed', () => {
    emitPlaybackProgress({ currentTime: 1.0, progress: 0.5, buffered: 0.6 });
    emitPlaybackProgress({ currentTime: 1.001, progress: 0.5, buffered: 0.6 });
    expect(getPlaybackProgressSnapshot().currentTime).toBe(1.0);
  });
});
