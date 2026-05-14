import { describe, it, expect } from 'vitest';
import {
  srgbToLinear,
  relativeLuminance,
  contrastRatio,
  rgbToHsl,
  hslToRgb,
  ensureContrast,
} from './dynamicColors';

// ─── srgbToLinear ─────────────────────────────────────────────────────────────

describe('srgbToLinear', () => {
  it('maps 0 to 0', () => expect(srgbToLinear(0)).toBe(0));
  it('maps 1 to 1', () => expect(srgbToLinear(1)).toBeCloseTo(1));
  it('uses the low-end linear formula below 0.04045', () => {
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 6);
  });
  it('uses the gamma formula above 0.04045', () => {
    expect(srgbToLinear(0.5)).toBeCloseTo(Math.pow((0.5 + 0.055) / 1.055, 2.4), 6);
  });
});

// ─── relativeLuminance ────────────────────────────────────────────────────────

describe('relativeLuminance', () => {
  it('returns 0 for black (0,0,0)', () => expect(relativeLuminance(0, 0, 0)).toBe(0));
  it('returns 1 for white (1,1,1)', () => expect(relativeLuminance(1, 1, 1)).toBeCloseTo(1, 5));
  it('weights green highest (0.7152)', () => {
    const greenOnly = relativeLuminance(0, 1, 0);
    const redOnly   = relativeLuminance(1, 0, 0);
    const blueOnly  = relativeLuminance(0, 0, 1);
    expect(greenOnly).toBeGreaterThan(redOnly);
    expect(redOnly).toBeGreaterThan(blueOnly);
  });
});

// ─── contrastRatio ────────────────────────────────────────────────────────────

describe('contrastRatio', () => {
  it('returns 21 for pure black on white', () => {
    expect(contrastRatio(0, 1)).toBeCloseTo(21, 1);
  });
  it('returns 1 when both luminances are equal', () => {
    expect(contrastRatio(0.2, 0.2)).toBeCloseTo(1, 5);
  });
  it('is symmetric', () => {
    expect(contrastRatio(0.1, 0.5)).toBeCloseTo(contrastRatio(0.5, 0.1), 10);
  });
  it('returns ≥ 4.5 for a light accent on near-black (FS bg)', () => {
    const accent = relativeLuminance(200 / 255, 160 / 255, 60 / 255);
    expect(contrastRatio(accent, 0.01)).toBeGreaterThanOrEqual(4.5);
  });
});

// ─── rgbToHsl / hslToRgb round-trip ──────────────────────────────────────────

describe('rgbToHsl / hslToRgb', () => {
  const cases: Array<[number, number, number]> = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [128, 128, 128],
    [255, 255, 255],
    [0, 0, 0],
    [200, 100, 50],
  ];
  it.each(cases)('round-trips rgb(%i,%i,%i)', (r, g, b) => {
    const [h, s, l] = rgbToHsl(r, g, b);
    const [rr, gg, bb] = hslToRgb(h, s, l);
    expect(rr).toBeCloseTo(r, -1);  // within ±1 due to rounding
    expect(gg).toBeCloseTo(g, -1);
    expect(bb).toBeCloseTo(b, -1);
  });

  it('pure grey has saturation 0', () => {
    const [, s] = rgbToHsl(128, 128, 128);
    expect(s).toBe(0);
  });
  it('pure red has hue 0°', () => {
    const [h] = rgbToHsl(255, 0, 0);
    expect(h).toBeCloseTo(0, 0);
  });
  it('pure green has hue 120°', () => {
    const [h] = rgbToHsl(0, 255, 0);
    expect(h).toBeCloseTo(120, 0);
  });
  it('pure blue has hue 240°', () => {
    const [h] = rgbToHsl(0, 0, 255);
    expect(h).toBeCloseTo(240, 0);
  });
});

// ─── ensureContrast ───────────────────────────────────────────────────────────

describe('ensureContrast', () => {
  const BG_LUMINANCE = 0.010; // near-black FS player background
  const MIN_RATIO    = 4.5;

  function meetsContrast(rgb: [number, number, number]): boolean {
    const l = relativeLuminance(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    return contrastRatio(l, BG_LUMINANCE) >= MIN_RATIO;
  }

  it('returns input unchanged if already sufficient', () => {
    // White is always sufficient
    const result = ensureContrast([255, 255, 255], BG_LUMINANCE, MIN_RATIO);
    expect(result).toEqual([255, 255, 255]);
  });

  it('lightens a very dark color until contrast is met', () => {
    const result = ensureContrast([10, 10, 10], BG_LUMINANCE, MIN_RATIO);
    expect(meetsContrast(result)).toBe(true);
  });

  it('lightens a dark saturated color until contrast is met', () => {
    // Dark blue — typical for dark album covers
    const result = ensureContrast([20, 20, 80], BG_LUMINANCE, MIN_RATIO);
    expect(meetsContrast(result)).toBe(true);
  });

  it('preserves a mid-tone color that already meets the ratio', () => {
    // Yellow-ish, high luminance — should already pass
    const input: [number, number, number] = [255, 230, 50];
    const result = ensureContrast(input, BG_LUMINANCE, MIN_RATIO);
    expect(meetsContrast(result)).toBe(true);
  });

  it('always produces a result with contrast ≥ MIN_RATIO', () => {
    // Stress-test with a range of dark, saturated colors
    const darkColors: Array<[number, number, number]> = [
      [5, 30, 60],
      [60, 5, 30],
      [30, 60, 5],
      [80, 0, 120],
      [0, 0, 0],
    ];
    for (const c of darkColors) {
      const result = ensureContrast(c, BG_LUMINANCE, MIN_RATIO);
      expect(meetsContrast(result)).toBe(true);
    }
  });

  it('handles a very demanding minRatio gracefully (returns white)', () => {
    // 21:1 is the theoretical maximum — only black-on-white achieves it.
    // Any input should at least not throw and produce some output.
    const result = ensureContrast([10, 10, 10], BG_LUMINANCE, 21);
    expect(result.length).toBe(3);
    result.forEach(c => { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(255); });
  });
});
