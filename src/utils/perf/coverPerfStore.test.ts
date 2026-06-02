import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  getCoverCachedPerMinute,
  getCoverPerfState,
  getCoverUiPerMinute,
  recordCoverProgress,
  recordCoverUiTotal,
  resetCoverPerfStateForTest,
} from './coverPerfStore';

beforeEach(() => {
  resetCoverPerfStateForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('coverPerfStore', () => {
  it('derives covers-per-minute from done deltas over time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    recordCoverProgress({ done: 100, total: 1000, pending: 900 });
    vi.advanceTimersByTime(30_000);
    recordCoverProgress({ done: 130, total: 1000, pending: 870 });
    // +30 covers over 30s ≈ 60 cpm.
    expect(getCoverCachedPerMinute()).toBeCloseTo(60, 0);
    expect(getCoverPerfState().done).toBe(130);
  });

  it('returns 0 with a single sample and prunes the window after a minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    recordCoverProgress({ done: 10 });
    expect(getCoverCachedPerMinute()).toBe(0);
    vi.advanceTimersByTime(20_000);
    recordCoverProgress({ done: 20 });
    expect(getCoverCachedPerMinute()).toBeGreaterThan(0);
    vi.advanceTimersByTime(61_000);
    expect(getCoverCachedPerMinute()).toBe(0);
  });

  it('resets the window on a backwards jump (server switch / cache clear)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    recordCoverProgress({ done: 500 });
    vi.advanceTimersByTime(5_000);
    recordCoverProgress({ done: 5 });
    // Only the new baseline remains → no rate yet.
    expect(getCoverCachedPerMinute()).toBe(0);
    expect(getCoverPerfState().done).toBe(5);
  });

  it('derives UI covers-per-minute from backend total deltas and prunes the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    expect(getCoverUiPerMinute()).toBe(0);
    recordCoverUiTotal(100);
    // A single sample has no delta yet.
    expect(getCoverUiPerMinute()).toBe(0);
    vi.advanceTimersByTime(30_000);
    recordCoverUiTotal(130);
    // +30 produced over 30s ≈ 60 cpm; lib series stays untouched.
    expect(getCoverUiPerMinute()).toBeCloseTo(60, 0);
    expect(getCoverCachedPerMinute()).toBe(0);
    vi.advanceTimersByTime(61_000);
    expect(getCoverUiPerMinute()).toBe(0);
  });

  it('resets the UI window on a backwards jump (process restart)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    recordCoverUiTotal(500);
    vi.advanceTimersByTime(5_000);
    recordCoverUiTotal(3);
    expect(getCoverUiPerMinute()).toBe(0);
  });
});
