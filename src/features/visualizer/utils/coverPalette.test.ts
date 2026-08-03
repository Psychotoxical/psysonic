import { describe, expect, it } from 'vitest';
import { swatchesFromPixels } from './coverPalette';
import { rgbToHsl, type Rgb } from './visualizerColors';

/** Build an RGBA buffer from a list of [colour, repeatCount] runs. */
function pixels(runs: Array<[Rgb, number]>, alpha = 255): Uint8ClampedArray {
  const total = runs.reduce((n, [, count]) => n + count, 0);
  const data = new Uint8ClampedArray(total * 4);
  let i = 0;
  for (const [[r, g, b], count] of runs) {
    for (let n = 0; n < count; n++) {
      data[i++] = r;
      data[i++] = g;
      data[i++] = b;
      data[i++] = alpha;
    }
  }
  return data;
}

const RED: Rgb = [200, 40, 40];
const BLUE: Rgb = [40, 60, 200];
const GREEN: Rgb = [40, 190, 60];

describe('swatchesFromPixels', () => {
  it('returns null for an empty buffer', () => {
    expect(swatchesFromPixels(new Uint8ClampedArray(0))).toBeNull();
  });

  it('returns null when every pixel is transparent', () => {
    expect(swatchesFromPixels(pixels([[RED, 16]], 0))).toBeNull();
  });

  it('returns null for pure black artwork', () => {
    // Below the lightness floor — structure, not colour.
    expect(swatchesFromPixels(pixels([[[0, 0, 0], 32]]))).toBeNull();
  });

  it('picks the majority hue as dominant', () => {
    const swatches = swatchesFromPixels(pixels([[RED, 40], [BLUE, 4]]));
    expect(swatches).not.toBeNull();
    const hue = rgbToHsl(swatches!.dominant)[0];
    // Red sits at either end of the hue circle.
    expect(hue < 0.06 || hue > 0.94).toBe(true);
  });

  it('picks a genuinely different hue as secondary', () => {
    const swatches = swatchesFromPixels(pixels([[RED, 40], [BLUE, 20]]))!;
    const dom = rgbToHsl(swatches.dominant)[0];
    const sec = rgbToHsl(swatches.secondary)[0];
    const distance = Math.min(Math.abs(dom - sec), 1 - Math.abs(dom - sec));
    expect(distance).toBeGreaterThan(0.1);
  });

  it('does not split one hue across two swatches', () => {
    // A single-hue cover has no distinct second colour to offer.
    const swatches = swatchesFromPixels(pixels([[RED, 40]]))!;
    expect(swatches.secondary).toEqual(swatches.dominant);
  });

  it('weights saturated pixels over a large washed-out area', () => {
    // A big pale field should not outvote the small vivid element that gives
    // the cover its identity.
    const pale: Rgb = [180, 176, 184];
    const swatches = swatchesFromPixels(pixels([[pale, 200], [GREEN, 20]]))!;
    const hue = rgbToHsl(swatches.dominant)[0];
    expect(hue).toBeGreaterThan(0.25);
    expect(hue).toBeLessThan(0.45);
  });

  it('reports the most vivid pixel as the accent', () => {
    const vivid: Rgb = [255, 0, 0];
    const swatches = swatchesFromPixels(pixels([[BLUE, 40], [vivid, 1]]))!;
    expect(rgbToHsl(swatches.accent)[1]).toBeCloseTo(1, 1);
  });

  it('falls back to the mean for greyscale artwork', () => {
    const swatches = swatchesFromPixels(pixels([[[100, 100, 100], 10], [[140, 140, 140], 10]]))!;
    expect(swatches.dominant[0]).toBeGreaterThan(95);
    expect(swatches.dominant[0]).toBeLessThan(145);
    expect(swatches.secondary).toEqual(swatches.dominant);
  });

  it('ignores transparent pixels when averaging', () => {
    const half = new Uint8ClampedArray(8 * 4);
    for (let i = 0; i < 4; i++) {
      half[i * 4] = 200; half[i * 4 + 1] = 40; half[i * 4 + 2] = 40; half[i * 4 + 3] = 255;
    }
    for (let i = 4; i < 8; i++) {
      half[i * 4] = 40; half[i * 4 + 1] = 60; half[i * 4 + 2] = 200; half[i * 4 + 3] = 0;
    }
    const swatches = swatchesFromPixels(half)!;
    const hue = rgbToHsl(swatches.dominant)[0];
    expect(hue < 0.06 || hue > 0.94).toBe(true);
  });

  it('skips near-white pixels so a white border does not become the palette', () => {
    const swatches = swatchesFromPixels(pixels([[[252, 252, 252], 200], [GREEN, 10]]))!;
    const hue = rgbToHsl(swatches.dominant)[0];
    expect(hue).toBeGreaterThan(0.25);
    expect(hue).toBeLessThan(0.45);
  });

  it('always returns three usable swatches when it returns at all', () => {
    const swatches = swatchesFromPixels(pixels([[RED, 20], [BLUE, 10], [GREEN, 5]]))!;
    for (const key of ['dominant', 'secondary', 'accent'] as const) {
      expect(swatches[key]).toHaveLength(3);
      for (const channel of swatches[key]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });

  it('tolerates a truncated buffer', () => {
    expect(() => swatchesFromPixels(new Uint8ClampedArray([200, 40, 40, 255, 1, 2]))).not.toThrow();
  });
});
