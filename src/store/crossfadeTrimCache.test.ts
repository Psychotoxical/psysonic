import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCrossfadeTrimCacheForTest,
  getCrossfadeLeadSilence,
  hasFetchedCrossfadeLead,
  markFetchedCrossfadeLead,
  setCrossfadeLeadSilence,
} from './crossfadeTrimCache';

describe('crossfadeTrimCache', () => {
  beforeEach(() => _resetCrossfadeTrimCacheForTest());

  it('returns 0 for unknown / empty track ids', () => {
    expect(getCrossfadeLeadSilence('nope')).toBe(0);
    expect(getCrossfadeLeadSilence('')).toBe(0);
  });

  it('stores and reads a lead-silence offset', () => {
    setCrossfadeLeadSilence('t1', 2.5);
    expect(getCrossfadeLeadSilence('t1')).toBe(2.5);
  });

  it('clamps negative offsets to 0 and ignores empty ids', () => {
    setCrossfadeLeadSilence('t2', -1);
    expect(getCrossfadeLeadSilence('t2')).toBe(0);
    setCrossfadeLeadSilence('', 3);
    expect(getCrossfadeLeadSilence('')).toBe(0);
  });

  it('tracks fetched ids independently', () => {
    expect(hasFetchedCrossfadeLead('t3')).toBe(false);
    markFetchedCrossfadeLead('t3');
    expect(hasFetchedCrossfadeLead('t3')).toBe(true);
  });

  it('evicts oldest entries past the cap', () => {
    for (let i = 0; i < 40; i++) setCrossfadeLeadSilence(`k${i}`, i);
    // First entries should have been evicted (cap 32).
    expect(getCrossfadeLeadSilence('k0')).toBe(0);
    expect(getCrossfadeLeadSilence('k39')).toBe(39);
  });
});
