/**
 * Backfill state: two parallel maps that retry the per-track loudness
 * analysis a bounded number of times. The interesting behaviours are the
 * `markBackfillInFlight` atomicity (both flag + counter bump in one call)
 * and the reseed reset that expands across the `stream:` / bare id forms
 * via `loudnessCacheStateKeysForTrackId` (re-used from loudnessGainCache).
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
  resetLoudnessBackfillStateForTrackId,
} from './loudnessBackfillState';

afterEach(() => {
  _resetBackfillStateForTest();
});

describe('initial state', () => {
  it('reports no inflight + 0 attempts for unknown tracks', () => {
    expect(isBackfillInFlight('t1')).toBe(false);
    expect(getBackfillAttempts('t1')).toBe(0);
  });
});

describe('markBackfillInFlight', () => {
  it('atomically sets inflight flag and counter', () => {
    markBackfillInFlight('t1', 1);
    expect(isBackfillInFlight('t1')).toBe(true);
    expect(getBackfillAttempts('t1')).toBe(1);
  });

  it('keeps tracks independent', () => {
    markBackfillInFlight('a', 1);
    markBackfillInFlight('b', 2);
    expect(getBackfillAttempts('a')).toBe(1);
    expect(getBackfillAttempts('b')).toBe(2);
    clearBackfillInFlight('a');
    expect(isBackfillInFlight('a')).toBe(false);
    expect(isBackfillInFlight('b')).toBe(true);
  });
});

describe('clearBackfillInFlight', () => {
  it('clears the flag without touching the counter', () => {
    markBackfillInFlight('t1', 1);
    clearBackfillInFlight('t1');
    expect(isBackfillInFlight('t1')).toBe(false);
    expect(getBackfillAttempts('t1')).toBe(1); // counter preserved
  });
});

describe('resetBackfillAttempts', () => {
  it('zeros the counter without touching the inflight flag', () => {
    markBackfillInFlight('t1', 2);
    resetBackfillAttempts('t1');
    expect(getBackfillAttempts('t1')).toBe(0);
    expect(isBackfillInFlight('t1')).toBe(true);
  });
});

describe('MAX_BACKFILL_ATTEMPTS_PER_TRACK', () => {
  it('is the hard-coded threshold the runtime uses', () => {
    expect(MAX_BACKFILL_ATTEMPTS_PER_TRACK).toBe(2);
  });
});

describe('resetLoudnessBackfillStateForTrackId', () => {
  it('clears both maps for both id forms (bare + stream:)', () => {
    markBackfillInFlight('t1', 1);
    markBackfillInFlight('stream:t1', 2);
    resetLoudnessBackfillStateForTrackId('t1');
    expect(isBackfillInFlight('t1')).toBe(false);
    expect(isBackfillInFlight('stream:t1')).toBe(false);
    expect(getBackfillAttempts('t1')).toBe(0);
    expect(getBackfillAttempts('stream:t1')).toBe(0);
  });

  it('also works when invoked with the stream-prefixed form', () => {
    markBackfillInFlight('t1', 1);
    markBackfillInFlight('stream:t1', 2);
    resetLoudnessBackfillStateForTrackId('stream:t1');
    expect(getBackfillAttempts('t1')).toBe(0);
    expect(getBackfillAttempts('stream:t1')).toBe(0);
  });
});
