import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCrossfadeTrimCacheForTest,
  getCrossfadeTransition,
  hasPlannedCrossfade,
  markPlannedCrossfade,
  setCrossfadeTransition,
} from './crossfadeTrimCache';

describe('crossfadeTrimCache', () => {
  beforeEach(() => _resetCrossfadeTrimCacheForTest());

  it('returns null for unknown / empty track ids', () => {
    expect(getCrossfadeTransition('nope')).toBeNull();
    expect(getCrossfadeTransition('')).toBeNull();
  });

  it('stores and reads a transition plan', () => {
    setCrossfadeTransition('t1', { bStartSec: 2.5, overlapSec: 4 });
    expect(getCrossfadeTransition('t1')).toEqual({ bStartSec: 2.5, overlapSec: 4 });
  });

  it('clamps negative values to 0 and ignores empty ids', () => {
    setCrossfadeTransition('t2', { bStartSec: -1, overlapSec: -2 });
    expect(getCrossfadeTransition('t2')).toEqual({ bStartSec: 0, overlapSec: 0 });
    setCrossfadeTransition('', { bStartSec: 3, overlapSec: 3 });
    expect(getCrossfadeTransition('')).toBeNull();
  });

  it('tracks planned ids independently', () => {
    expect(hasPlannedCrossfade('t3')).toBe(false);
    markPlannedCrossfade('t3');
    expect(hasPlannedCrossfade('t3')).toBe(true);
  });

  it('evicts oldest entries past the cap', () => {
    for (let i = 0; i < 40; i++) setCrossfadeTransition(`k${i}`, { bStartSec: i, overlapSec: 1 });
    // First entries should have been evicted (cap 32).
    expect(getCrossfadeTransition('k0')).toBeNull();
    expect(getCrossfadeTransition('k39')).toEqual({ bStartSec: 39, overlapSec: 1 });
  });
});
