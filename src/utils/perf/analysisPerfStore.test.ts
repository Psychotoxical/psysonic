import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  getAnalysisTracksPerMinute,
  recordAnalysisTrackPerf,
  resetAnalysisPerfStateForTest,
} from './analysisPerfStore';

beforeEach(() => {
  resetAnalysisPerfStateForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('analysisPerfStore', () => {
  const record = (trackId: string): void =>
    recordAnalysisTrackPerf({ trackId, fetchMs: 1, seedMs: 1, bpmMs: 1, totalMs: 3 });

  it('records last track timings and trailing-window tpm', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    record('t1');
    vi.advanceTimersByTime(100);
    // 1 completion in the trailing 5s → 1 / 5s × 60 = 12 tpm.
    expect(getAnalysisTracksPerMinute()).toBeCloseTo(12, 0);
  });

  it('extrapolates a burst over the trailing 5s window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    record('a');
    vi.advanceTimersByTime(1_000);
    record('b');
    vi.advanceTimersByTime(1_000);
    record('c');
    // 3 completions within the last 5s → 3 / 5s × 60 = 36 tpm.
    expect(getAnalysisTracksPerMinute()).toBeCloseTo(36, 0);
  });

  it('decays to 0 once completions fall outside the trailing window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    record('old');
    expect(getAnalysisTracksPerMinute()).toBeGreaterThan(0);
    vi.advanceTimersByTime(6_000);
    expect(getAnalysisTracksPerMinute()).toBe(0);
  });
});
