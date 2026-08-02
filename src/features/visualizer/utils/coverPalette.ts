/**
 * Multi-swatch colour extraction from cover art, for the visualizer.
 *
 * This deliberately does not reuse `extractCoverColors` from `lib/dom`: that
 * helper returns a *single* colour and force-corrects it for WCAG contrast
 * against the fullscreen player's near-black backdrop. Both choices are right
 * for a text accent and wrong here — the visualizer wants several colours that
 * genuinely represent the artwork, adapted to whatever the current theme's
 * background happens to be (which may be light).
 *
 * The pixel maths is separated from the canvas work so it can be unit tested
 * against synthetic pixel buffers.
 */

import { rgbToHsl, type Rgb } from './visualizerColors';

/** Colours pulled from one cover. */
export interface CoverSwatches {
  /** Heaviest hue in the artwork — the colour the cover "is". */
  dominant: Rgb;
  /** A distinct second hue, for gradient travel. Falls back near `dominant`. */
  secondary: Rgb;
  /** The most vivid pixel — the highlight. */
  accent: Rgb;
  /**
   * True when the artwork carried no usable hue at all (black-and-white or
   * near-greyscale). The swatches are then plain greys, and forcing colour onto
   * them would invent a hue the cover never had — callers should fall back to
   * the theme instead.
   */
  neutral: boolean;
}

/** Hue buckets. 12 × 30° is coarse enough to group a gradient, fine enough to
 *  keep, say, orange and red apart. */
const HUE_BUCKETS = 12;
/** Below this saturation a pixel carries no usable hue. */
const MIN_SATURATION = 0.14;
/** Near-black and near-white pixels are structure, not colour. */
const MIN_LIGHTNESS = 0.07;
const MAX_LIGHTNESS = 0.95;
/** Minimum hue separation (in buckets) for `secondary` to count as distinct. */
const MIN_SECONDARY_SEPARATION = 2;

interface Bucket {
  weight: number;
  r: number;
  g: number;
  b: number;
}

/**
 * How much a pixel counts towards its hue bucket. Saturated, mid-lightness
 * pixels dominate: a large washed-out sky should not outvote the one saturated
 * element that gives a cover its identity.
 */
function pixelWeight(s: number, l: number): number {
  return s * s * (1 - Math.abs(l - 0.5) * 0.8);
}

function bucketMean(bucket: Bucket): Rgb {
  const n = Math.max(bucket.weight, 1e-6);
  return [
    Math.round(bucket.r / n),
    Math.round(bucket.g / n),
    Math.round(bucket.b / n),
  ];
}

/** Circular distance between two hue buckets. */
function bucketDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, HUE_BUCKETS - d);
}

/**
 * Derive swatches from raw RGBA pixels (as `getImageData().data`).
 * Returns null when the image carries no usable colour at all, so the caller
 * can fall back to the theme rather than render a grey smear.
 */
export function swatchesFromPixels(data: Uint8ClampedArray | number[]): CoverSwatches | null {
  if (data.length < 4) return null;

  const buckets: Bucket[] = Array.from({ length: HUE_BUCKETS }, () => ({
    weight: 0, r: 0, g: 0, b: 0,
  }));

  let bestSat = -1;
  let accent: Rgb | null = null;
  // Fallback for monochrome art: the plain mean of everything visible.
  let meanR = 0, meanG = 0, meanB = 0, meanCount = 0;

  for (let i = 0; i + 3 < data.length; i += 4) {
    const alpha = data[i + 3]!;
    if (alpha < 128) continue;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;

    const [h, s, l] = rgbToHsl([r, g, b]);
    if (l < MIN_LIGHTNESS || l > MAX_LIGHTNESS) continue;

    meanR += r; meanG += g; meanB += b; meanCount += 1;
    if (s < MIN_SATURATION) continue;

    const weight = pixelWeight(s, l);
    const index = Math.min(HUE_BUCKETS - 1, Math.floor(h * HUE_BUCKETS));
    const bucket = buckets[index]!;
    bucket.weight += weight;
    bucket.r += r * weight;
    bucket.g += g * weight;
    bucket.b += b * weight;

    if (s > bestSat) {
      bestSat = s;
      accent = [r, g, b];
    }
  }

  const ranked = buckets
    .map((bucket, index) => ({ bucket, index }))
    .filter(entry => entry.bucket.weight > 0)
    .sort((a, b) => b.bucket.weight - a.bucket.weight);

  if (ranked.length === 0) {
    // Monochrome / greyscale artwork. Still usable — the palette builder will
    // saturate it — but only if we saw anything at all.
    if (meanCount === 0) return null;
    const mean: Rgb = [
      Math.round(meanR / meanCount),
      Math.round(meanG / meanCount),
      Math.round(meanB / meanCount),
    ];
    return { dominant: mean, secondary: mean, accent: accent ?? mean, neutral: true };
  }

  const top = ranked[0]!;
  const dominant = bucketMean(top.bucket);

  // Prefer a second hue that is actually different; a near-neighbour bucket is
  // the same colour split across a boundary and would make a flat gradient.
  const distinct = ranked.find(
    entry => bucketDistance(entry.index, top.index) >= MIN_SECONDARY_SEPARATION,
  );
  const secondary = distinct ? bucketMean(distinct.bucket) : dominant;

  return { dominant, secondary, accent: accent ?? dominant, neutral: false };
}

/** Size the cover is sampled at. 24² = 576 pixels — enough to be representative,
 *  small enough that decode plus read stays well under a frame. */
const SAMPLE_SIZE = 24;

/**
 * Draw an already-loaded image into an offscreen canvas and extract swatches.
 * Returns null if the canvas is unavailable or tainted.
 */
export function swatchesFromImage(img: CanvasImageSource): CoverSwatches | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return swatchesFromPixels(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
  } catch {
    // Tainted canvas or a decode failure — the caller falls back to the theme.
    return null;
  }
}

/** Load a blob URL and extract its swatches. */
export function swatchesFromObjectUrl(url: string): Promise<CoverSwatches | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(swatchesFromImage(img));
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
