import { describe, expect, it } from 'vitest';
import {
  adjustLightness,
  buildPalette,
  contrast,
  ensureSaturation,
  ensureVisibleOn,
  hslToRgb,
  isLightSurface,
  luminance,
  mixRgb,
  parseCssColor,
  rgbToCss,
  rgbToHsl,
  shiftHue,
  themePalette,
  type Rgb,
} from './visualizerColors';

describe('parseCssColor', () => {
  it('parses the rgb() form extractCoverColors emits', () => {
    expect(parseCssColor('rgb(12,34,56)')).toEqual([12, 34, 56]);
    expect(parseCssColor('rgb(12, 34, 56)')).toEqual([12, 34, 56]);
  });

  it('parses rgba() by ignoring the alpha', () => {
    expect(parseCssColor('rgba(12, 34, 56, 0.5)')).toEqual([12, 34, 56]);
  });

  it('parses long and short hex', () => {
    expect(parseCssColor('#8b5cf6')).toEqual([139, 92, 246]);
    expect(parseCssColor('#abc')).toEqual([170, 187, 204]);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseCssColor('  #8B5CF6 ')).toEqual([139, 92, 246]);
  });

  it('returns null for values it cannot read', () => {
    expect(parseCssColor('rebeccapurple')).toBeNull();
    expect(parseCssColor('color-mix(in srgb, red, blue)')).toBeNull();
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor(null)).toBeNull();
    expect(parseCssColor(undefined)).toBeNull();
  });

  it('clamps out-of-gamut channels', () => {
    expect(parseCssColor('rgb(300, 20, 40)')).toEqual([255, 20, 40]);
  });
});

describe('rgbToCss', () => {
  it('emits rgb() at full alpha and rgba() below', () => {
    expect(rgbToCss([1, 2, 3])).toBe('rgb(1, 2, 3)');
    expect(rgbToCss([1, 2, 3], 0.5)).toBe('rgba(1, 2, 3, 0.5)');
  });

  it('clamps the alpha', () => {
    expect(rgbToCss([1, 2, 3], 5)).toBe('rgb(1, 2, 3)');
    expect(rgbToCss([1, 2, 3], -1)).toBe('rgba(1, 2, 3, 0)');
  });
});

describe('mixRgb', () => {
  it('returns the endpoints at 0 and 1', () => {
    expect(mixRgb([0, 0, 0], [255, 255, 255], 0)).toEqual([0, 0, 0]);
    expect(mixRgb([0, 0, 0], [255, 255, 255], 1)).toEqual([255, 255, 255]);
  });

  it('blends linearly', () => {
    expect(mixRgb([0, 0, 0], [100, 200, 40], 0.5)).toEqual([50, 100, 20]);
  });

  it('clamps t', () => {
    expect(mixRgb([10, 10, 10], [20, 20, 20], -3)).toEqual([10, 10, 10]);
    expect(mixRgb([10, 10, 10], [20, 20, 20], 3)).toEqual([20, 20, 20]);
  });
});

describe('hsl conversion', () => {
  it('round-trips saturated colours', () => {
    const colors: Rgb[] = [[139, 92, 246], [255, 0, 0], [0, 128, 64], [12, 34, 200]];
    for (const c of colors) {
      const back = hslToRgb(rgbToHsl(c));
      expect(Math.abs(back[0] - c[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(back[1] - c[1])).toBeLessThanOrEqual(1);
      expect(Math.abs(back[2] - c[2])).toBeLessThanOrEqual(1);
    }
  });

  it('round-trips greys', () => {
    expect(hslToRgb(rgbToHsl([128, 128, 128]))).toEqual([128, 128, 128]);
  });
});

describe('shiftHue', () => {
  it('is a no-op at 0 and at a full turn', () => {
    const c: Rgb = [200, 40, 90];
    expect(shiftHue(c, 0)).toEqual(shiftHue(c, 360));
  });

  it('actually moves the hue', () => {
    const c: Rgb = [200, 40, 90];
    expect(shiftHue(c, 120)).not.toEqual(c);
  });
});

describe('adjustLightness', () => {
  it('brightens above 1 and darkens below', () => {
    const c: Rgb = [100, 60, 140];
    const lighter = rgbToHsl(adjustLightness(c, 1.4))[2];
    const darker = rgbToHsl(adjustLightness(c, 0.6))[2];
    expect(lighter).toBeGreaterThan(rgbToHsl(c)[2]);
    expect(darker).toBeLessThan(rgbToHsl(c)[2]);
  });

  it('never drives a colour to pure black or white', () => {
    const l = rgbToHsl(adjustLightness([10, 10, 12], 0.01))[2];
    const h = rgbToHsl(adjustLightness([250, 250, 250], 40))[2];
    expect(l).toBeGreaterThan(0);
    expect(h).toBeLessThan(1);
  });
});

describe('ensureSaturation', () => {
  it('raises a washed-out but genuinely coloured pixel to the floor', () => {
    const boosted = ensureSaturation([150, 120, 120], 0.45);
    expect(rgbToHsl(boosted)[1]).toBeCloseTo(0.45, 2);
  });

  it('refuses to invent a hue for a grey', () => {
    // rgbToHsl reports hue 0 for any grey, and hue 0 is red — saturating it is
    // how a black-and-white cover rendered salmon.
    expect(ensureSaturation([128, 128, 128], 0.45)).toEqual([128, 128, 128]);
    expect(ensureSaturation([130, 129, 128], 0.45)).toEqual([130, 129, 128]);
  });

  it('leaves an already-saturated colour alone', () => {
    const c: Rgb = [255, 0, 0];
    expect(ensureSaturation(c, 0.45)).toEqual(c);
  });
});

describe('luminance / contrast', () => {
  it('ranks black below white', () => {
    expect(luminance([0, 0, 0])).toBeLessThan(luminance([255, 255, 255]));
  });

  it('gives black on white the maximum ratio', () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
  });

  it('is symmetric', () => {
    expect(contrast([12, 90, 200], [240, 240, 240]))
      .toBeCloseTo(contrast([240, 240, 240], [12, 90, 200]), 6);
  });
});

describe('isLightSurface', () => {
  it('classifies typical theme backgrounds', () => {
    expect(isLightSurface([255, 255, 255])).toBe(true);
    expect(isLightSurface([239, 241, 245])).toBe(true); // catppuccin latte base
    expect(isLightSurface([31, 31, 40])).toBe(false);   // kanagawa wave base
    expect(isLightSurface([0, 0, 0])).toBe(false);
  });
});

describe('ensureVisibleOn', () => {
  it('leaves an already-visible colour alone', () => {
    const c: Rgb = [255, 80, 80];
    expect(ensureVisibleOn(c, [10, 10, 14])).toEqual(c);
  });

  it('lightens against a dark surface', () => {
    const dark: Rgb = [8, 8, 12];
    const out = ensureVisibleOn([20, 20, 30], dark);
    expect(rgbToHsl(out)[2]).toBeGreaterThan(rgbToHsl([20, 20, 30])[2]);
    expect(contrast(out, dark)).toBeGreaterThan(contrast([20, 20, 30], dark));
  });

  it('darkens against a light surface', () => {
    // The old lib helper only ever lightened, which is why a light theme
    // needed its own path here.
    const light: Rgb = [245, 245, 248];
    const out = ensureVisibleOn([230, 225, 235], light);
    expect(rgbToHsl(out)[2]).toBeLessThan(rgbToHsl([230, 225, 235])[2]);
    expect(contrast(out, light)).toBeGreaterThan(contrast([230, 225, 235], light));
  });

  it('preserves hue while adjusting', () => {
    const c: Rgb = [40, 40, 90];
    const before = rgbToHsl(c)[0];
    const after = rgbToHsl(ensureVisibleOn(c, [10, 10, 14]))[0];
    expect(after).toBeCloseTo(before, 2);
  });

  it('gives up gracefully rather than looping forever', () => {
    // Nothing can reach a high ratio against mid-grey; it must still return.
    const out = ensureVisibleOn([128, 128, 128], [128, 128, 128], 21);
    expect(out).toHaveLength(3);
  });
});

describe('buildPalette', () => {
  const DARK = '#0a0a0e';
  const LIGHT = '#eff1f5';

  const cover = (dominant: Rgb, secondary: Rgb, accent: Rgb) => ({
    cover: { dominant, secondary, accent },
    themeAccent: '#8b5cf6',
    surface: DARK,
  });

  it('takes its colours from the cover when given one', () => {
    const palette = buildPalette(cover([200, 40, 40], [40, 60, 200], [255, 210, 60]));
    // Red-ish base, blue-ish middle — the cover's own two hues.
    expect(rgbToHsl(palette.base)[0]).toBeLessThan(0.08);
    const midHue = rgbToHsl(palette.mid)[0];
    expect(midHue).toBeGreaterThan(0.5);
    expect(midHue).toBeLessThan(0.75);
  });

  it('produces a travelling gradient, not three shades of one colour', () => {
    const palette = buildPalette(cover([200, 40, 40], [40, 60, 200], [255, 210, 60]));
    const hues = [palette.base, palette.mid, palette.tip].map(c => rgbToHsl(c)[0]);
    expect(Math.abs(hues[0]! - hues[1]!)).toBeGreaterThan(0.1);
  });

  it('fans out a flat cover so the gradient still reads', () => {
    // Every swatch identical — the builder must invent separation.
    const palette = buildPalette(cover([120, 60, 160], [120, 60, 160], [120, 60, 160]));
    expect(palette.mid).not.toEqual(palette.base);
  });

  it('falls back to the theme ramp with no cover', () => {
    const palette = buildPalette({ cover: null, themeAccent: '#00ff00', surface: DARK });
    const hue = rgbToHsl(palette.mid)[0];
    expect(hue).toBeGreaterThan(0.25);
    expect(hue).toBeLessThan(0.42);
  });

  it('uses the theme accent-dim for the base when the theme defines one', () => {
    const palette = buildPalette({
      cover: null,
      themeAccent: '#8b5cf6',
      themeAccentDim: '#4c1d95',
      surface: DARK,
    });
    expect(rgbToHsl(palette.base)[2]).toBeLessThan(rgbToHsl(palette.mid)[2]);
  });

  it('falls back to the default violet when nothing parses', () => {
    const palette = buildPalette({ cover: null, themeAccent: 'not a colour', surface: DARK });
    expect(rgbToHsl(palette.mid)[0]).toBeCloseTo(rgbToHsl([139, 92, 246])[0], 2);
  });

  it('falls back to the theme for a cover with no usable hue', () => {
    // A black-and-white cover has no colour to match. Inventing one produced a
    // red-ish palette for every greyscale sleeve.
    const palette = buildPalette({
      cover: { dominant: [128, 128, 128], secondary: [128, 128, 128], accent: [128, 128, 128], neutral: true },
      themeAccent: '#3b82f6',
      surface: DARK,
    });
    const hue = rgbToHsl(palette.mid)[0];
    expect(hue).toBeGreaterThan(0.5);
    expect(hue).toBeLessThan(0.68);
  });

  it('still colours a low-saturation cover that does have a hue', () => {
    const palette = buildPalette(cover([150, 120, 120], [120, 120, 150], [150, 120, 120]));
    expect(rgbToHsl(palette.base)[1]).toBeGreaterThan(0.3);
  });

  it('keeps every colour visible on a dark theme', () => {
    const palette = buildPalette(cover([18, 16, 22], [20, 18, 24], [22, 20, 26]));
    const surface: Rgb = [10, 10, 14];
    for (const c of [palette.base, palette.mid, palette.tip]) {
      expect(contrast(c, surface)).toBeGreaterThan(1.8);
    }
  });

  it('keeps every colour visible on a light theme', () => {
    const palette = buildPalette({
      cover: { dominant: [250, 248, 250], secondary: [246, 244, 248], accent: [252, 250, 252] },
      themeAccent: '#8b5cf6',
      surface: LIGHT,
    });
    const surface: Rgb = [239, 241, 245];
    for (const c of [palette.base, palette.mid, palette.tip]) {
      expect(contrast(c, surface)).toBeGreaterThan(1.8);
    }
  });

  it('drives the caps away from the surface in both directions', () => {
    const onDark = buildPalette(cover([120, 60, 200], [60, 120, 200], [200, 120, 60]));
    const onLight = buildPalette({
      cover: { dominant: [120, 60, 200], secondary: [60, 120, 200], accent: [200, 120, 60] },
      themeAccent: '#8b5cf6',
      surface: LIGHT,
    });
    // Caps read as "hot": brighter than the tip on dark, darker on light.
    expect(rgbToHsl(onDark.cap)[2]).toBeGreaterThan(rgbToHsl(onDark.tip)[2]);
    expect(rgbToHsl(onLight.cap)[2]).toBeLessThan(rgbToHsl(onLight.tip)[2]);
  });

  it('always returns all five roles', () => {
    const palette = buildPalette({ cover: null, themeAccent: null, surface: null });
    for (const key of ['base', 'mid', 'tip', 'cap', 'glow'] as const) {
      expect(palette[key]).toHaveLength(3);
    }
  });
});

describe('themePalette', () => {
  it('matches buildPalette with no cover', () => {
    expect(themePalette('#8b5cf6', null, '#0a0a0e'))
      .toEqual(buildPalette({ cover: null, themeAccent: '#8b5cf6', surface: '#0a0a0e' }));
  });
});
