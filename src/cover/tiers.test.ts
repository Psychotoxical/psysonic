import { describe, expect, it } from 'vitest';
import { resolveCoverDisplayTier } from './tiers';

describe('resolveCoverDisplayTier', () => {
  it('caps dense grids at 512', () => {
    expect(resolveCoverDisplayTier(300, { dpr: 2, surface: 'dense' })).toBe(512);
    expect(resolveCoverDisplayTier(300, { dpr: 1, surface: 'dense' })).toBe(512);
  });

  it('allows 800 on sparse surfaces', () => {
    expect(resolveCoverDisplayTier(300, { dpr: 2, surface: 'sparse' })).toBe(800);
  });

  it('returns 2000 for full-res', () => {
    expect(resolveCoverDisplayTier(40, { fullRes: true })).toBe(2000);
  });

  it('picks smallest tier >= needed px', () => {
    expect(resolveCoverDisplayTier(40, { dpr: 2, surface: 'dense' })).toBe(128);
    expect(resolveCoverDisplayTier(64, { dpr: 2, surface: 'dense' })).toBe(128);
  });
});
