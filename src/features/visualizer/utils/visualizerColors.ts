/**
 * Colour derivation for the visualizer.
 *
 * The palette is built from the album cover's extracted accent (the same value
 * the immersive fullscreen player uses) with the theme accent as a fallback, so
 * the bars belong to whatever is playing instead of fighting the current theme.
 *
 * Palette math stays pure. `resolveCssColor` is the narrow browser adapter used
 * by the theme hook to canonicalise free-form community-theme CSS colours.
 */

export type Rgb = [number, number, number];

/** Neutral fallback if nothing resolves — the app's default violet accent. */
const FALLBACK_RGB: Rgb = [139, 92, 246];

function clampChannel(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Parse canonical sRGB forms produced by cover extraction and browser computed
 * styles. Free-form author syntax is handled by `resolveCssColor` below.
 */
export function parseCssColor(input: string | null | undefined): Rgb | null {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;

  const fn = /^rgba?\((.*)\)$/i.exec(value);
  if (fn) {
    const channels = fn[1]!.split('/')[0]!.replace(/,/g, ' ').trim().split(/\s+/);
    if (channels.length >= 3) {
      const parsed = channels.slice(0, 3).map(channel => {
        const percent = channel.endsWith('%');
        const number = Number.parseFloat(channel);
        return percent ? (number * 255) / 100 : number;
      });
      if (parsed.every(Number.isFinite)) {
        return [clampChannel(parsed[0]!), clampChannel(parsed[1]!), clampChannel(parsed[2]!)];
      }
    }
  }

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      return [
        parseInt(h[0]! + h[0]!, 16),
        parseInt(h[1]! + h[1]!, 16),
        parseInt(h[2]! + h[2]!, 16),
      ];
    }
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }

  // Chromium commonly serialises computed color-mix() values this way.
  const srgb = /^color\(\s*srgb\s+([^)]*)\)$/i.exec(value);
  if (srgb) {
    const channels = srgb[1]!.split('/')[0]!.trim().split(/\s+/);
    if (channels.length >= 3) {
      const parsed = channels.slice(0, 3).map(channel => {
        const percent = channel.endsWith('%');
        const number = Number.parseFloat(channel);
        return percent ? (number * 255) / 100 : number * 255;
      });
      if (parsed.every(Number.isFinite)) {
        return [clampChannel(parsed[0]!), clampChannel(parsed[1]!), clampChannel(parsed[2]!)];
      }
    }
  }

  return null;
}

export type CssColorComputer = (value: string) => string | null;

function computeBrowserCssColor(value: string): string | null {
  if (typeof document === 'undefined') return null;
  const host = document.body ?? document.documentElement;
  if (!host) return null;

  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.pointerEvents = 'none';
  probe.style.backgroundColor = value;
  if (!probe.style.backgroundColor) return null;

  host.appendChild(probe);
  try {
    const computed = getComputedStyle(probe).backgroundColor.trim();
    return computed && computed !== 'transparent' && computed !== 'rgba(0, 0, 0, 0)'
      ? computed
      : null;
  } catch {
    return null;
  } finally {
    probe.remove();
  }
}

/** Let the browser parse modern CSS syntax, then sample one pixel if computed
 * style preserves a non-rgb colour space such as oklch(). */
function sampleBrowserCssColor(value: string): Rgb | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.fillStyle = '#010203';
    ctx.fillStyle = value;
    const first = ctx.fillStyle;
    ctx.fillStyle = '#040506';
    ctx.fillStyle = value;
    const second = ctx.fillStyle;
    if (first !== second) return null;

    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    if ((pixel[3] ?? 0) === 0) return null;
    return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
  } catch {
    return null;
  }
}

/** Resolve any colour syntax accepted by the current WebView. The injectable
 * computer keeps modern-colour fixtures deterministic under jsdom. */
export function resolveCssColor(
  input: string | null | undefined,
  compute: CssColorComputer = computeBrowserCssColor,
): Rgb | null {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;
  const direct = parseCssColor(value);
  if (direct) return direct;

  const computed = compute(value);
  if (!computed) return null;
  return parseCssColor(computed)
    ?? sampleBrowserCssColor(computed)
    ?? sampleBrowserCssColor(value);
}

export function rgbToCss(rgb: Rgb, alpha = 1): string {
  const a = Math.max(0, Math.min(1, alpha));
  return a >= 1
    ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
    : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

/** Blend two colours; `t` 0 → `a`, 1 → `b`. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t));
  return [
    clampChannel(a[0] + (b[0] - a[0]) * k),
    clampChannel(a[1] + (b[1] - a[1]) * k),
    clampChannel(a[2] + (b[2] - a[2]) * k),
  ];
}

/** Rotate hue by `degrees`, preserving saturation and lightness. */
export function shiftHue(rgb: Rgb, degrees: number): Rgb {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([(h + degrees / 360 + 1) % 1, s, l]);
}

/** Scale lightness by `factor` (1 = unchanged), clamped to a visible range. */
export function adjustLightness(rgb: Rgb, factor: number): Rgb {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([h, s, Math.max(0.06, Math.min(0.96, l * factor))]);
}

/** Raise saturation so a washed-out cover still yields readable bars. */
export function ensureSaturation(rgb: Rgb, min: number): Rgb {
  const [h, s, l] = rgbToHsl(rgb);
  // A grey has no hue at all — `rgbToHsl` reports 0 for it, and hue 0 is *red*.
  // Saturating that invents a colour the artwork never had, which is how a
  // black-and-white cover ended up rendering salmon.
  if (s < 0.02) return rgb;
  return s >= min ? rgb : hslToRgb([h, min, l]);
}

export function rgbToHsl(rgb: Rgb): [number, number, number] {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

export function hslToRgb(hsl: [number, number, number]): Rgb {
  const [h, s, l] = hsl;
  if (s === 0) {
    const v = clampChannel(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [
    clampChannel(channel(h + 1 / 3) * 255),
    clampChannel(channel(h) * 255),
    clampChannel(channel(h - 1 / 3) * 255),
  ];
}

/** Relative luminance, per WCAG. */
export function luminance(rgb: Rgb): number {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** True when a background is light enough that graphics must go darker to show. */
export function isLightSurface(surface: Rgb): boolean {
  return luminance(surface) > 0.25;
}

/**
 * Push `color` away from `surface` in lightness until it is clearly visible.
 *
 * Unlike `lib/dom`'s `ensureContrast`, which only ever lightens (it assumes the
 * near-black fullscreen backdrop), this moves whichever way the background
 * requires — so the same palette works on a light theme. The target ratio is
 * well below the 4.5 text threshold on purpose: these are broad graphic shapes,
 * and forcing text-grade contrast would wash every cover towards the extremes.
 */
export function ensureVisibleOn(color: Rgb, surface: Rgb, minRatio = 2.1): Rgb {
  if (contrast(color, surface) >= minRatio) return color;

  const [h, s, l] = rgbToHsl(color);
  const goDarker = !isLightSurface(surface) ? false : true;
  let best = color;
  for (let step = 1; step <= 24; step++) {
    const delta = step * 0.04;
    const nextL = goDarker ? l - delta : l + delta;
    if (nextL <= 0.02 || nextL >= 0.98) break;
    const candidate = hslToRgb([h, s, nextL]);
    best = candidate;
    if (contrast(candidate, surface) >= minRatio) return candidate;
  }
  return best;
}

/** Colours the renderers draw with. */
export interface VisualizerPalette {
  /** Bar base / trace colour — the gradient's cool end. */
  base: Rgb;
  /** Middle gradient stop. Distinct from `base` when the artwork has a second
   *  hue, which is what makes a colourful cover produce a colourful spectrum. */
  mid: Rgb;
  /** Bar tip colour — the gradient's hot end. */
  tip: Rgb;
  /** Peak-cap colour, deliberately brighter than the tip. */
  cap: Rgb;
  /** Background bloom colour. */
  glow: Rgb;
}

/** Swatch trio pulled from cover art. Mirrors `CoverSwatches`, re-declared here
 *  so this module stays the bottom of the colour stack (no import cycle). */
export interface PaletteSwatches {
  dominant: Rgb;
  secondary: Rgb;
  accent: Rgb;
  /** Artwork had no usable hue — treat as "no cover colour". */
  neutral?: boolean;
}

export interface PaletteInput {
  /** Cover swatches, or null to build purely from the theme. */
  cover: PaletteSwatches | null;
  /** `--accent` from the active theme. */
  themeAccent: string | null;
  /** `--accent-dim`, when the theme defines one. */
  themeAccentDim?: string | null;
  /** The background the visualizer will be drawn on (`--bg-app` / `--bg-card`). */
  surface: string | null;
}

/**
 * Build the render palette.
 *
 * Two sources, one output shape:
 *  • **Cover** — dominant hue at the base, the artwork's second hue in the
 *    middle, its most vivid pixel at the tip. A cover with real colour variety
 *    produces a gradient that travels; a monochrome one gets saturated up so it
 *    still reads as colour rather than grey.
 *  • **Theme** — the accent ramp, so the visualizer looks like part of the
 *    chosen theme rather than a foreign object sitting in it.
 *
 * Every colour is then contrast-adapted against `surface`, which is what lets
 * the same palette work on both light and dark themes.
 */
export function buildPalette(input: PaletteInput): VisualizerPalette {
  const surface = parseCssColor(input.surface) ?? [10, 10, 14];
  const themeAccent = parseCssColor(input.themeAccent) ?? FALLBACK_RGB;

  let base: Rgb;
  let mid: Rgb;
  let tip: Rgb;

  // A black-and-white cover has no colour to match. Rather than invent one,
  // use the theme ramp — the alternative is picking a hue at random and calling
  // it the album's.
  const cover = input.cover?.neutral ? null : input.cover;

  if (cover) {
    base = ensureSaturation(cover.dominant, 0.42);
    mid = ensureSaturation(cover.secondary, 0.42);
    tip = ensureSaturation(cover.accent, 0.5);
    // A cover whose swatches all collapsed to one colour still needs a visible
    // gradient, so fan it out by hue instead of showing a flat wash.
    if (contrast(base, mid) < 1.08 && rgbToHsl(base)[1] < 0.9) {
      mid = shiftHue(base, 26);
    }
    if (contrast(mid, tip) < 1.08) {
      tip = adjustLightness(shiftHue(mid, 22), 1.3);
    }
  } else {
    const dim = parseCssColor(input.themeAccentDim ?? null);
    base = dim ?? adjustLightness(themeAccent, 0.75);
    mid = themeAccent;
    tip = adjustLightness(shiftHue(themeAccent, 18), 1.3);
  }

  base = ensureVisibleOn(base, surface);
  mid = ensureVisibleOn(mid, surface);
  tip = ensureVisibleOn(tip, surface);

  // Caps sit on top of the bars, so they only need to beat the *tip*, not the
  // background — pushing them further from the surface is what reads as "hot".
  const capDirection = isLightSurface(surface) ? 0.72 : 1.55;
  const cap = ensureVisibleOn(adjustLightness(tip, capDirection), surface, 2.6);

  return {
    base,
    mid,
    tip,
    cap,
    glow: adjustLightness(mid, isLightSurface(surface) ? 0.9 : 0.85),
  };
}

/**
 * Colour for a given 0..1 intensity: `base` when quiet, through `mid`, to `tip`
 * when loud.
 *
 * Colouring by *level* rather than by screen position is what stops a
 * visualization reading as one flat wash — a quiet band and a loud one are
 * different colours, so the picture changes with the music instead of just the
 * heights moving.
 */
export function levelColor(palette: VisualizerPalette, level: number): Rgb {
  const t = level <= 0 ? 0 : level >= 1 ? 1 : level;
  return t < 0.5
    ? mixRgb(palette.base, palette.mid, t * 2)
    : mixRgb(palette.mid, palette.tip, (t - 0.5) * 2);
}

/** Hue drift across the spectrum, in degrees end to end. */
const SPECTRUM_HUE_SPREAD = 26;

/**
 * Intensity colour with a gentle hue drift by position, so neighbouring bands
 * of similar level still separate visually instead of merging into a block.
 * `position` is 0..1 across the spectrum (or around the ring).
 */
export function spectrumColor(
  palette: VisualizerPalette,
  level: number,
  position: number,
): Rgb {
  const p = position <= 0 ? 0 : position >= 1 ? 1 : position;
  return shiftHue(levelColor(palette, level), (p - 0.5) * SPECTRUM_HUE_SPREAD);
}

/** Palette built from the theme alone — the "no cover yet" state. */
export function themePalette(
  themeAccent: string | null,
  themeAccentDim: string | null,
  surface: string | null,
): VisualizerPalette {
  return buildPalette({ cover: null, themeAccent, themeAccentDim, surface });
}
