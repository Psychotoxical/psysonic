import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordHeroBackdropUpgrade,
  getHeroBackdropUpgrade,
  __test_resetHeroBackdropMemory,
} from './heroBackdropMemory';

describe('heroBackdropMemory', () => {
  beforeEach(() => __test_resetHeroBackdropMemory());

  it('records and reads back per album + surface', () => {
    recordHeroBackdropUpgrade('a1', 'banner', 'b.webp');
    recordHeroBackdropUpgrade('a1', 'fanart', 'f.webp');
    expect(getHeroBackdropUpgrade('a1')).toEqual({ banner: 'b.webp', fanart: 'f.webp' });
  });

  it('ignores an empty album id or url', () => {
    recordHeroBackdropUpgrade(undefined, 'banner', 'b.webp');
    recordHeroBackdropUpgrade('a1', 'banner', '');
    expect(getHeroBackdropUpgrade('a1')).toBeUndefined();
  });

  it('returns undefined for unknown / undefined album', () => {
    expect(getHeroBackdropUpgrade('nope')).toBeUndefined();
    expect(getHeroBackdropUpgrade(undefined)).toBeUndefined();
  });

  it('evicts the oldest entries beyond the cap (FIFO)', () => {
    for (let i = 0; i < 50; i += 1) recordHeroBackdropUpgrade(`a${i}`, 'banner', `u${i}`);
    expect(getHeroBackdropUpgrade('a0')).toBeUndefined(); // evicted
    expect(getHeroBackdropUpgrade('a1')).toBeUndefined(); // evicted
    expect(getHeroBackdropUpgrade('a49')).toEqual({ banner: 'u49' });
  });

  it('refreshes recency on re-touch so the most-recently-used evicts last', () => {
    for (let i = 0; i < 48; i += 1) recordHeroBackdropUpgrade(`a${i}`, 'banner', `u${i}`);
    recordHeroBackdropUpgrade('a0', 'fanart', 'f0'); // re-touch a0 → moves to newest
    recordHeroBackdropUpgrade('a48', 'banner', 'u48'); // pushes the oldest (a1) out
    expect(getHeroBackdropUpgrade('a0')).toEqual({ banner: 'u0', fanart: 'f0' }); // survived
    expect(getHeroBackdropUpgrade('a1')).toBeUndefined(); // oldest → evicted
  });
});
