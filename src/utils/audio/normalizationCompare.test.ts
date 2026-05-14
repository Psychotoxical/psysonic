import { describe, expect, it } from 'vitest';
import { normalizationAlmostEqual } from './normalizationCompare';

describe('normalizationAlmostEqual', () => {
  it('returns true for two nulls', () => {
    expect(normalizationAlmostEqual(null, null)).toBe(true);
  });

  it('returns false for mixed null / number', () => {
    expect(normalizationAlmostEqual(null, 0)).toBe(false);
    expect(normalizationAlmostEqual(0, null)).toBe(false);
  });

  it('returns true for values within the default epsilon (0.12)', () => {
    expect(normalizationAlmostEqual(-14.0, -14.05)).toBe(true);
    expect(normalizationAlmostEqual(-14.0, -14.12)).toBe(true);
  });

  it('returns false just past the default epsilon', () => {
    expect(normalizationAlmostEqual(-14.0, -14.13)).toBe(false);
  });

  it('honours a custom epsilon', () => {
    expect(normalizationAlmostEqual(-14.0, -14.5, 1.0)).toBe(true);
    expect(normalizationAlmostEqual(-14.0, -14.5, 0.4)).toBe(false);
  });

  it('treats exact equality as equal', () => {
    expect(normalizationAlmostEqual(-10, -10)).toBe(true);
    expect(normalizationAlmostEqual(0, 0)).toBe(true);
  });
});
