/**
 * Backfill state: two parallel maps that retry the per-track loudness
 * analysis a bounded number of times. The interesting behaviours are the
 * `markBackfillInFlight` atomicity (both flag + counter bump in one call)
 * and owner isolation when two servers expose the same raw track id.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_BACKFILL_ATTEMPTS_PER_TRACK,
  _resetBackfillStateForTest,
  clearBackfillInFlight,
  getBackfillAttempts,
  isBackfillInFlight,
  markBackfillInFlight,
  resetBackfillAttempts,
  restoreBackfillAttempts,
  resetLoudnessBackfillState,
} from '@/features/playback/store/loudnessBackfillState';
import { analysisTrackRef } from '@/features/playback/store/analysisTrackRef';

const ref = (trackId: string, serverId = 'server-a') => analysisTrackRef(trackId, serverId);

afterEach(() => {
  _resetBackfillStateForTest();
});

describe('initial state', () => {
  it('reports no inflight + 0 attempts for unknown tracks', () => {
    expect(isBackfillInFlight(ref('t1'))).toBe(false);
    expect(getBackfillAttempts(ref('t1'))).toBe(0);
  });
});

describe('markBackfillInFlight', () => {
  it('atomically sets inflight flag and counter', () => {
    markBackfillInFlight(ref('t1'), 1);
    expect(isBackfillInFlight(ref('t1'))).toBe(true);
    expect(getBackfillAttempts(ref('t1'))).toBe(1);
  });

  it('keeps tracks independent', () => {
    markBackfillInFlight(ref('same', 'server-a'), 1);
    markBackfillInFlight(ref('same', 'server-b'), 2);
    expect(getBackfillAttempts(ref('same', 'server-a'))).toBe(1);
    expect(getBackfillAttempts(ref('same', 'server-b'))).toBe(2);
    clearBackfillInFlight(ref('same', 'server-a'));
    expect(isBackfillInFlight(ref('same', 'server-a'))).toBe(false);
    expect(isBackfillInFlight(ref('same', 'server-b'))).toBe(true);
  });
});

describe('clearBackfillInFlight', () => {
  it('clears the flag without touching the counter', () => {
    markBackfillInFlight(ref('t1'), 1);
    clearBackfillInFlight(ref('t1'));
    expect(isBackfillInFlight(ref('t1'))).toBe(false);
    expect(getBackfillAttempts(ref('t1'))).toBe(1); // counter preserved
  });
});

describe('resetBackfillAttempts', () => {
  it('zeros the counter without touching the inflight flag', () => {
    markBackfillInFlight(ref('t1'), 2);
    resetBackfillAttempts(ref('t1'));
    expect(getBackfillAttempts(ref('t1'))).toBe(0);
    expect(isBackfillInFlight(ref('t1'))).toBe(true);
  });
});

describe('restoreBackfillAttempts', () => {
  it('restores the count without changing the inflight flag', () => {
    markBackfillInFlight(ref('t1'), 2);
    restoreBackfillAttempts(ref('t1'), 1);
    expect(getBackfillAttempts(ref('t1'))).toBe(1);
    expect(isBackfillInFlight(ref('t1'))).toBe(true);
  });
});

describe('MAX_BACKFILL_ATTEMPTS_PER_TRACK', () => {
  it('is the hard-coded threshold the runtime uses', () => {
    expect(MAX_BACKFILL_ATTEMPTS_PER_TRACK).toBe(2);
  });
});

describe('resetLoudnessBackfillState', () => {
  it('normalizes bare and stream-prefixed ids for the same owner', () => {
    markBackfillInFlight(ref('t1'), 1);
    expect(getBackfillAttempts(ref('stream:t1'))).toBe(1);
    resetLoudnessBackfillState(ref('stream:t1'));
    expect(isBackfillInFlight(ref('t1'))).toBe(false);
    expect(getBackfillAttempts(ref('t1'))).toBe(0);
  });

  it('does not reset the same raw id owned by another server', () => {
    markBackfillInFlight(ref('t1', 'server-a'), 1);
    markBackfillInFlight(ref('t1', 'server-b'), 2);
    resetLoudnessBackfillState(ref('t1', 'server-a'));
    expect(getBackfillAttempts(ref('t1', 'server-a'))).toBe(0);
    expect(getBackfillAttempts(ref('t1', 'server-b'))).toBe(2);
  });
});
