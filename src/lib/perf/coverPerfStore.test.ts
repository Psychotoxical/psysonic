import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  getCoverCachedPerMinute,
  getCoverPerfState,
  getCoverUiPerMinute,
  recordCoverProgress,
  recordCoverUiTotal,
  resetCoverPerfStateForTest,
} from '@/lib/perf/coverPerfStore';

beforeEach(() => {
  resetCoverPerfStateForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('coverPerfStore', () => {
  it('derives covers-per-minute from done deltas over the trailing window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    recordCoverProgress({ done: 100, total: 1000, pending: 900 });
    vi.advanceTimersByTime(1_000);
    recordCoverProgress({ done: 110, total: 1000, pending: 890 });
    vi.advanceTimersByTime(1_000);
    recordCoverProgress({ done: 120, total: 1000, pending: 880 });
    // +20 covers over the last 2s ≈ 600 cpm (no minute-long inertia).
    expect(getCoverCachedPerMinute()).toBeCloseTo(600, 0);
    expect(getCoverPerfState().done).toBe(120);
  });

  it('returns 0 with a single sample and decays once the trailing window empties', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    recordCoverProgress({ done: 10 });
    expect(getCoverCachedPerMinute()).toBe(0);
    vi.advanceTimersByTime(1_000);
    recordCoverProgress({ done: 20 });
    expect(getCoverCachedPerMinute()).toBeGreaterThan(0);
    // No fresh samples for >5s → trailing window empties → back to 0.
    vi.advanceTimersByTime(6_000);
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

  it('derives UI covers-per-minute from backend total deltas over the trailing window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    expect(getCoverUiPerMinute()).toBe(0);
    recordCoverUiTotal(100);
    // A single sample has no delta yet.
    expect(getCoverUiPerMinute()).toBe(0);
    vi.advanceTimersByTime(2_000);
    recordCoverUiTotal(130);
    // +30 produced over the last 2s ≈ 900 cpm; lib series stays untouched.
    expect(getCoverUiPerMinute()).toBeCloseTo(900, 0);
    expect(getCoverCachedPerMinute()).toBe(0);
    // Idle poll keeps reporting the same total → delta 0 → rate decays to 0.
    vi.advanceTimersByTime(6_000);
    recordCoverUiTotal(130);
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
