import type { SeekbarStyle } from '../store/authStoreTypes';

export function fmt(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

export const BAR_COUNT = 500;
/** Stored waveform bins per track (matches backend `bin_count` / PCM bins). */
export const WAVE_BIN_COUNT = 500;
/** `0.7 * mean + 0.3 * max` in normalized 0..1 space (v4 cache: first half = peak, second = mean-abs). */
export const WAVE_MIX_MEAN = 0.7;
export const WAVE_MIX_MAX = 0.3;
export const SEG_COUNT = 60;
export const FLAT_WAVE_NORM = 0.06;
export const WAVE_MORPH_MS = 1000;
export const STATIC_REDRAW_MIN_MS = 90;
export const STATIC_REDRAW_FORCE_MS = 220;
export const INTERPOLATION_PAINT_MIN_MS = 80;

export type Particle = {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
};

export type AnimState = {
  particles: Particle[];
  time: number;
  lastProgress: number;
  angle: number;
};

export function makeAnimState(): AnimState {
  return { particles: [], time: 0, lastProgress: 0, angle: 0 };
}

export const ANIMATED_STYLES = new Set<SeekbarStyle>(['particletrail', 'pulsewave', 'liquidfill', 'retrotape']);

export type SeekbarColors = {
  played: string;
  buffered: string;
  unplayed: string;
};

let cachedColors: SeekbarColors | null = null;
let cachedColorsKey = '';

export function invalidateColorCache() {
  cachedColors = null;
}

export function getColors(): SeekbarColors {
  const root = document.documentElement;
  const style = root.style;
  const key = [
    root.getAttribute('data-theme') ?? '',
    style.getPropertyValue('--accent'),
    style.getPropertyValue('--waveform-played'),
    style.getPropertyValue('--waveform-buffered'),
    style.getPropertyValue('--waveform-unplayed'),
  ].join('|');
  if (cachedColors && cachedColorsKey === key) return cachedColors;
  const s = getComputedStyle(root);
  cachedColorsKey = key;
  cachedColors = {
    played: s.getPropertyValue('--waveform-played').trim() || s.getPropertyValue('--accent').trim() || '#cba6f7',
    buffered: s.getPropertyValue('--waveform-buffered').trim() || s.getPropertyValue('--ctp-overlay0').trim() || '#6c7086',
    unplayed: s.getPropertyValue('--waveform-unplayed').trim() || s.getPropertyValue('--ctp-surface1').trim() || '#313244',
  };
  return cachedColors;
}

export function setupCanvas(
  canvas: HTMLCanvasElement,
): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const w = canvas.clientWidth || canvas.getBoundingClientRect().width;
  const h = canvas.clientHeight || canvas.getBoundingClientRect().height;
  if (w === 0 || h === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function setShadowBlur(ctx: CanvasRenderingContext2D, blur: number) {
  ctx.shadowBlur = Math.max(0, blur);
}

function hashStr(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = (h ^ str.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function makeHeights(trackId: string): Float32Array {
  let s = hashStr(trackId);
  const h = new Float32Array(BAR_COUNT);
  for (let i = 0; i < BAR_COUNT; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    h[i] = s / 0xffffffff;
  }
  for (let pass = 0; pass < 5; pass++) {
    for (let i = 1; i < BAR_COUNT - 1; i++) {
      h[i] = h[i - 1] * 0.25 + h[i] * 0.5 + h[i + 1] * 0.25;
    }
  }
  let max = 0;
  for (let i = 0; i < BAR_COUNT; i++) if (h[i] > max) max = h[i];
  if (max > 0) for (let i = 0; i < BAR_COUNT; i++) h[i] = 0.12 + (h[i] / max) * 0.88;
  return h;
}

export function makeFlatWaveHeights(): Float32Array {
  const h = new Float32Array(BAR_COUNT);
  h.fill(FLAT_WAVE_NORM);
  return h;
}

export function easeOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - x, 3);
}

export function binsToHeights(src: number[]): Float32Array {
  const h = new Float32Array(BAR_COUNT);
  const n = src.length;
  if (n === WAVE_BIN_COUNT * 2) {
    for (let i = 0; i < BAR_COUNT; i++) {
      const idx = Math.min(WAVE_BIN_COUNT - 1, Math.floor((i / BAR_COUNT) * WAVE_BIN_COUNT));
      const maxNorm = Number(src[idx]) / 255;
      const meanNorm = Number(src[WAVE_BIN_COUNT + idx]) / 255;
      const v = WAVE_MIX_MEAN * meanNorm + WAVE_MIX_MAX * maxNorm;
      h[i] = Math.max(0.08, Math.min(1, v));
    }
    return h;
  }
  if (n === WAVE_BIN_COUNT) {
    for (let i = 0; i < BAR_COUNT; i++) {
      const idx = Math.min(WAVE_BIN_COUNT - 1, Math.floor((i / BAR_COUNT) * WAVE_BIN_COUNT));
      const v = src[idx];
      h[i] = Math.max(0.08, Math.min(1, (Number(v) / 255)));
    }
    return h;
  }
  for (let i = 0; i < BAR_COUNT; i++) {
    const idx = Math.min(n - 1, Math.floor((i / BAR_COUNT) * n));
    const v = src[idx];
    h[i] = Math.max(0.08, Math.min(1, (Number(v) / 255)));
  }
  return h;
}

export function heightsNearlyEqual(a: Float32Array, b: Float32Array, eps: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > eps) return false;
  }
  return true;
}

export function waveformBarThickness(logicalH: number, norm: number): number {
  const safeNorm = Math.max(FLAT_WAVE_NORM, norm);
  return Math.max(1, safeNorm * logicalH);
}

export function quantizeProgressByBars(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return Math.max(0, Math.min(1, Math.floor(clamped * BAR_COUNT) / BAR_COUNT));
}

export function isBarQuantizedSeekStyle(style: SeekbarStyle): boolean {
  return style === 'truewave' || style === 'pseudowave';
}
