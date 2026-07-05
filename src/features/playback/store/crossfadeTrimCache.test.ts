import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetCrossfadeTrimCacheForTest,
  armCrossfadeDynamicOverlap,
  consumeCrossfadeDynamicOverlap,
  peekArmedCrossfadeDynamicOverlap,
  getCrossfadeTransition,
  hasPlannedCrossfade,
  markPlannedCrossfade,
  setCrossfadeTransition,
} from '@/features/playback/store/crossfadeTrimCache';

describe('crossfadeTrimCache', () => {
  beforeEach(() => _resetCrossfadeTrimCacheForTest());

  it('returns null for unknown / empty track ids', () => {
    expect(getCrossfadeTransition('nope')).toBeNull();
    expect(getCrossfadeTransition('')).toBeNull();
  });

  it('stores and reads a transition plan', () => {
    setCrossfadeTransition('t1', { bStartSec: 2.5, overlapSec: 4, outgoingFadeSec: 0 });
    expect(getCrossfadeTransition('t1')).toEqual({ bStartSec: 2.5, overlapSec: 4, outgoingFadeSec: 0 });
  });

  it('clamps negative values to 0 and ignores empty ids', () => {
    setCrossfadeTransition('t2', { bStartSec: -1, overlapSec: -2, outgoingFadeSec: -3 });
    expect(getCrossfadeTransition('t2')).toEqual({ bStartSec: 0, overlapSec: 0, outgoingFadeSec: 0 });
    setCrossfadeTransition('', { bStartSec: 3, overlapSec: 3, outgoingFadeSec: 3 });
    expect(getCrossfadeTransition('')).toBeNull();
  });

  it('tracks planned ids independently', () => {
    expect(hasPlannedCrossfade('t3')).toBe(false);
    markPlannedCrossfade('t3');
    expect(hasPlannedCrossfade('t3')).toBe(true);
  });

  it('evicts oldest entries past the cap', () => {
    for (let i = 0; i < 40; i++) {
      setCrossfadeTransition(`k${i}`, { bStartSec: i, overlapSec: 1, outgoingFadeSec: 1 });
    }
    // First entries should have been evicted (cap 32).
    expect(getCrossfadeTransition('k0')).toBeNull();
    expect(getCrossfadeTransition('k39')).toEqual({ bStartSec: 39, overlapSec: 1, outgoingFadeSec: 1 });
  });

  it('arms and consumes the dynamic overlap once, for the matching track', () => {
    armCrossfadeDynamicOverlap('b1', 4, 0);
    // Mismatched id consumes nothing and leaves the armed value intact.
    expect(consumeCrossfadeDynamicOverlap('other')).toBeNull();
    expect(consumeCrossfadeDynamicOverlap('b1')).toEqual({ overlapSec: 4, outgoingFadeSec: 0 });
    // One-shot: a second consume returns null.
    expect(consumeCrossfadeDynamicOverlap('b1')).toBeNull();
  });

  it('peeks armed overlap without consuming', () => {
    armCrossfadeDynamicOverlap('b3', 2, 2);
    expect(peekArmedCrossfadeDynamicOverlap('b3')).toBe(true);
    expect(peekArmedCrossfadeDynamicOverlap('other')).toBe(false);
    expect(consumeCrossfadeDynamicOverlap('b3')).not.toBeNull();
    expect(peekArmedCrossfadeDynamicOverlap('b3')).toBe(false);
  });

  it('carries the engine fade-out length for A (non-scenario-A swaps)', () => {
    armCrossfadeDynamicOverlap('b2', 0.5, 0.5);
    expect(consumeCrossfadeDynamicOverlap('b2')).toEqual({ overlapSec: 0.5, outgoingFadeSec: 0.5 });
  });
});
