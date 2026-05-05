// ─── Dynamic Cover Colors ─────────────────────────────────────────────────────
//
// Extracts a vibrant accent color from an album cover URL using the Canvas API.
// Designed exclusively for the Fullscreen Player — applied as a CSS custom
// property on the .fs-player root, inheriting down to all children.
//
// Guarantees WCAG 4.5:1 contrast against the FS player's near-black background
// by progressively lightening the extracted color in HSL space until the ratio
// is met. Falls back to an empty string (→ CSS falls back to var(--accent)).

export interface CoverColors {
  /** CSS color string, e.g. "rgb(200,120,60)".  Empty string = use fallback. */
  accent: string;
}

// ─── WCAG math (pure — unit-testable) ─────────────────────────────────────────

/** Convert a sRGB channel [0, 1] to linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance for linear-light RGB channels [0, 1]. */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio given two relative luminances. Always ≥ 1. */
export function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker  = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─── HSL helpers (pure) ───────────────────────────────────────────────────────

/** RGB [0–255] → HSL [0–360, 0–1, 0–1]. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l < 0.5 ? d / (max + min) : d / (2 - max - min);
  let h: number;
  switch (max) {
    case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
    case gn: h = ((bn - rn) / d + 2) / 6; break;
    default: h = ((rn - gn) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** HSL [0–360, 0–1, 0–1] → RGB [0–255]. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = h / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

// ─── Contrast enforcement (pure — unit-testable) ──────────────────────────────

/**
 * Given an RGB color [0–255] and the luminance of the background it will sit
 * on, progressively increases HSL lightness in 0.04 steps until the contrast
 * ratio reaches `minRatio`.  Returns white [255,255,255] as the ultimate
 * fallback if even L=1 doesn't suffice (can only happen at extreme minRatio
 * values, e.g. 21:1).
 */
export function ensureContrast(
  rgb: [number, number, number],
  bgLuminance: number,
  minRatio: number,
): [number, number, number] {
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);

  // Already meeting the requirement?
  const initialLum = relativeLuminance(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
  if (contrastRatio(initialLum, bgLuminance) >= minRatio) return [...rgb];

  // Lighten in steps of 4 % (25 iterations max → terminates)
  for (let step = 1; step <= 25; step++) {
    const newL = Math.min(1, l + step * 0.04);
    const newRgb = hslToRgb(h, s, newL);
    const newLum = relativeLuminance(newRgb[0] / 255, newRgb[1] / 255, newRgb[2] / 255);
    if (contrastRatio(newLum, bgLuminance) >= minRatio) return newRgb;
  }
  return [255, 255, 255];
}

// ─── Canvas extraction (requires DOM) ─────────────────────────────────────────

/**
 * The FS player mesh background is a very dark near-black.
 * luminance ≈ 0.010 is a conservative upper bound — the color contrast will be
 * at least this good.
 */
const FS_BG_LUMINANCE = 0.010;
const MIN_CONTRAST    = 4.5;

function isRemoteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isBlobOrDataUrl(url: string): boolean {
  return url.startsWith('blob:') || url.startsWith('data:');
}

/**
 * Samples decoded pixels from an HTMLImageElement (already loaded).
 * Throws if the canvas is tainted (caller should catch).
 */
function sampleImageToAccent(img: HTMLImageElement): CoverColors {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { accent: '' };

  ctx.drawImage(img, 0, 0, 8, 8);
  const { data } = ctx.getImageData(0, 0, 8, 8);

  let bestSat = -1;
  let bestR = 180;
  let bestG = 100;
  let bestB = 50;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const [, s] = rgbToHsl(r, g, b);
    if (s > bestSat) {
      bestSat = s;
      bestR = r;
      bestG = g;
      bestB = b;
    }
  }

  const [fr, fg, fb] = ensureContrast([bestR, bestG, bestB], FS_BG_LUMINANCE, MIN_CONTRAST);
  return { accent: `rgb(${fr},${fg},${fb})` };
}

function loadImage(url: string, crossOrigin: '' | 'anonymous'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.src = url;
  });
}

/**
 * Loads `imageUrl` into an 8×8 canvas and finds the most vibrant pixel
 * (highest HSL saturation).  Applies `ensureContrast` to guarantee
 * WCAG AA readability against the FS player background.
 *
 * Remote `https?://` URLs would taint a canvas if drawn from a plain `<img>`
 * without CORS — we prefer `fetch` → `blob:` for sampling, then fall back to
 * `crossOrigin = "anonymous"` when the server allows it.
 *
 * Resolves with `{ accent: '' }` on any error — the caller's CSS
 * `var(--dynamic-fs-accent, var(--accent))` then falls back to the theme accent.
 */
export async function extractCoverColors(imageUrl: string): Promise<CoverColors> {
  if (!imageUrl) return { accent: '' };
  if (imageUrl.includes('logo-psysonic')) return { accent: '' };

  const safeSample = async (url: string, co: '' | 'anonymous'): Promise<CoverColors> => {
    try {
      const img = await loadImage(url, co);
      try {
        return sampleImageToAccent(img);
      } catch {
        return { accent: '' };
      }
    } catch {
      return { accent: '' };
    }
  };

  if (isBlobOrDataUrl(imageUrl)) {
    return safeSample(imageUrl, '');
  }

  if (isRemoteHttpUrl(imageUrl)) {
    try {
      const resp = await fetch(imageUrl);
      if (resp.ok) {
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        try {
          return await safeSample(objectUrl, '');
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }
    } catch {
      // CORS / network — try credentialed image load if server sends ACAO for art
    }
    return safeSample(imageUrl, 'anonymous');
  }

  return safeSample(imageUrl, '');
}
