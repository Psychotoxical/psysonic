import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetWaveformRefreshGenForTest,
  bumpWaveformRefreshGen,
  getWaveformRefreshGen,
} from './waveformRefreshGen';

afterEach(() => {
  _resetWaveformRefreshGenForTest();
});

describe('waveformRefreshGen', () => {
  it('returns 0 for an unknown track', () => {
    expect(getWaveformRefreshGen('missing')).toBe(0);
  });

  it('increments the per-track generation on each bump', () => {
    bumpWaveformRefreshGen('t1');
    expect(getWaveformRefreshGen('t1')).toBe(1);
    bumpWaveformRefreshGen('t1');
    expect(getWaveformRefreshGen('t1')).toBe(2);
  });

  it('keeps tracks independent', () => {
    bumpWaveformRefreshGen('a');
    bumpWaveformRefreshGen('a');
    bumpWaveformRefreshGen('b');
    expect(getWaveformRefreshGen('a')).toBe(2);
    expect(getWaveformRefreshGen('b')).toBe(1);
  });

  it('is a no-op for an empty trackId', () => {
    bumpWaveformRefreshGen('');
    expect(getWaveformRefreshGen('')).toBe(0);
  });

  it('captures the stale-result guard pattern: a snapshot is invalidated by a later bump', () => {
    bumpWaveformRefreshGen('t1');
    const snapshot = getWaveformRefreshGen('t1');
    expect(snapshot).toBe(1);
    bumpWaveformRefreshGen('t1');
    expect(getWaveformRefreshGen('t1')).not.toBe(snapshot);
  });
});
