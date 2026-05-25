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
  it('records last track timings and rolling tpm', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    recordAnalysisTrackPerf({
      trackId: 't1',
      fetchMs: 1000,
      seedMs: 2000,
      bpmMs: 500,
      totalMs: 3500,
    });
    vi.advanceTimersByTime(100);
    expect(getAnalysisTracksPerMinute()).toBeGreaterThan(0);
  });

  it('prunes completions older than one minute from tpm window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    recordAnalysisTrackPerf({
      trackId: 'old',
      fetchMs: 1,
      seedMs: 1,
      bpmMs: 1,
      totalMs: 3,
    });
    vi.advanceTimersByTime(61_000);
    expect(getAnalysisTracksPerMinute()).toBe(0);
  });
});
