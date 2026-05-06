import React, { useEffect, useRef, useState } from 'react';
import { usePlayerStore, getPlaybackProgressSnapshot, subscribePlaybackProgress } from '../store/playerStore';
import { usePreviewStore } from '../store/previewStore';
import { useAuthStore, type SeekbarStyle } from '../store/authStore';
import { bumpPerfCounter } from '../utils/perfTelemetry';
function fmt(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

const BAR_COUNT = 500;
/** Stored waveform bins per track (matches backend `bin_count` / PCM bins). */
const WAVE_BIN_COUNT = 500;
/** `0.7 * mean + 0.3 * max` in normalized 0..1 space (v4 cache: first half = peak, second = mean-abs). */
const WAVE_MIX_MEAN = 0.7;
const WAVE_MIX_MAX = 0.3;
const SEG_COUNT = 60;
const FLAT_WAVE_NORM = 0.06;
const WAVE_MORPH_MS = 1000;
const STATIC_REDRAW_MIN_MS = 90;
const STATIC_REDRAW_FORCE_MS = 220;
const INTERPOLATION_PAINT_MIN_MS = 80;

// ── animation state ───────────────────────────────────────────────────────────

type Particle = {
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

const ANIMATED_STYLES = new Set<SeekbarStyle>(['particletrail', 'pulsewave', 'liquidfill', 'retrotape']);

// ── color helper ──────────────────────────────────────────────────────────────

type SeekbarColors = {
  played: string;
  buffered: string;
  unplayed: string;
};

let cachedColors: SeekbarColors | null = null;
let cachedColorsKey = '';

function invalidateColorCache() {
  cachedColors = null;
}

function getColors(): SeekbarColors {
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

// ── canvas setup ──────────────────────────────────────────────────────────────

function setupCanvas(
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

function setShadowBlur(ctx: CanvasRenderingContext2D, blur: number) {
  ctx.shadowBlur = Math.max(0, blur);
}

// ── waveform heights ──────────────────────────────────────────────────────────

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

// ── draw functions ────────────────────────────────────────────────────────────

function makeFlatWaveHeights(): Float32Array {
  const h = new Float32Array(BAR_COUNT);
  h.fill(FLAT_WAVE_NORM);
  return h;
}

function easeOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - x, 3);
}

function binsToHeights(src: number[]): Float32Array {
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

function heightsNearlyEqual(a: Float32Array, b: Float32Array, eps: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > eps) return false;
  }
  return true;
}

function waveformBarThickness(logicalH: number, norm: number): number {
  const safeNorm = Math.max(FLAT_WAVE_NORM, norm);
  return Math.max(1, safeNorm * logicalH);
}

function quantizeProgressByBars(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return Math.max(0, Math.min(1, Math.floor(clamped * BAR_COUNT) / BAR_COUNT));
}

function isBarQuantizedSeekStyle(style: SeekbarStyle): boolean {
  return style === 'truewave' || style === 'pseudowave';
}

function drawWaveform(
  canvas: HTMLCanvasElement,
  heights: Float32Array | null,
  progress: number,
  buffered: number,
) {
  const r = setupCanvas(canvas);
  if (!r) return;
  const { ctx, w, h } = r;
  const { played, buffered: buffCol, unplayed } = getColors();
  const pNorm = Math.max(0, Math.min(1, progress));
  const bNorm = Math.max(pNorm, Math.min(1, buffered));

  if (!heights) {
    // No waveform data yet: flat rail like `drawLineDot`, but do not return early
    // before played/buffered — otherwise there is no visible playhead.
    const cy = h / 2;
    const lh = 2;
    const dotR = 5;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = unplayed;
    ctx.fillRect(0, cy - lh / 2, w, lh);
    if (buffered > 0) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = buffCol;
      ctx.fillRect(0, cy - lh / 2, Math.min(1, buffered) * w, lh);
    }
    if (progress > 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = played;
      ctx.shadowColor = played;
      setShadowBlur(ctx, 5);
      ctx.fillRect(0, cy - lh / 2, pNorm * w, lh);
      setShadowBlur(ctx, 0);
    }
    ctx.globalAlpha = 1;
    if (w > 0) {
      const dx = Math.max(dotR, Math.min(w - dotR, pNorm * w));
      ctx.shadowColor = played;
      setShadowBlur(ctx, 7);
      ctx.beginPath();
      ctx.arc(dx, cy, dotR, 0, Math.PI * 2);
      ctx.fillStyle = played;
      ctx.fill();
      setShadowBlur(ctx, 0);
    }
    ctx.globalAlpha = 1;
    return;
  }
  const x1Of = (i: number) => (i / BAR_COUNT) * w;
  const x2Of = (i: number) => ((i + 1) / BAR_COUNT) * w;
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = unplayed;
  for (let i = 0; i < BAR_COUNT; i++) {
    if (i / BAR_COUNT < bNorm) continue;
    const bh = waveformBarThickness(h, heights[i]);
    const x = x1Of(i);
    ctx.fillRect(x, (h - bh) / 2, x2Of(i) - x, bh);
  }

  ctx.globalAlpha = 0.45;
  ctx.fillStyle = buffCol;
  for (let i = 0; i < BAR_COUNT; i++) {
    const frac = i / BAR_COUNT;
    if (frac < pNorm || frac >= bNorm) continue;
    const bh = waveformBarThickness(h, heights[i]);
    const x = x1Of(i);
    ctx.fillRect(x, (h - bh) / 2, x2Of(i) - x, bh);
  }

  if (pNorm > 0) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = played;
    for (let i = 0; i < BAR_COUNT; i++) {
      if (i / BAR_COUNT >= pNorm) break;
      const bh = waveformBarThickness(h, heights[i]);
      const x = x1Of(i);
      ctx.fillRect(x, (h - bh) / 2, x2Of(i) - x, bh);
    }
  }
  ctx.globalAlpha = 1;
}

function drawLineDot(canvas: HTMLCanvasElement, progress: number, buffered: number) {
  const r = setupCanvas(canvas);
  if (!r) return;
  const { ctx, w, h } = r;
  const { played, buffered: buffCol, unplayed } = getColors();
  const cy = h / 2;
  const lh = 2;
  const dotR = 5;

  ctx.globalAlpha = 0.35;
  ctx.fillStyle = unplayed;
  ctx.fillRect(0, cy - lh / 2, w, lh);

  if (buffered > 0) {
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = buffCol;
    ctx.fillRect(0, cy - lh / 2, buffered * w, lh);
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = played;
  ctx.fillRect(0, cy - lh / 2, progress * w, lh);

  const dx = Math.max(dotR, Math.min(w - dotR, progress * w));
  ctx.shadowColor = played;
  setShadowBlur(ctx, 7);
  ctx.beginPath();
  ctx.arc(dx, cy, dotR, 0, Math.PI * 2);
  ctx.fillStyle = played;
  ctx.fill();
  setShadowBlur(ctx, 0);
  ctx.globalAlpha = 1;
}

function drawBar(canvas: HTMLCanvasElement, progress: number, buffered: number) {
  const r = setupCanvas(canvas);
  if (!r) return;
  const { ctx, w, h } = r;
  const { played, buffered: buffCol, unplayed } = getColors();
  const bh = 4;
  const rad = bh / 2;
  const y = (h - bh) / 2;

  ctx.globalAlpha = 0.3;
  ctx.fillStyle = unplayed;
  ctx.beginPath();
  ctx.roundRect(0, y, w, bh, rad);
  ctx.fill();

  if (buffered > 0) {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = buffCol;
    ctx.beginPath();
    ctx.roundRect(0, y, buffered * w, bh, rad);
    ctx.fill();
  }

  if (progress > 0) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = played;
    ctx.shadowColor = played;
    setShadowBlur(ctx, 5);
    ctx.beginPath();
    ctx.roundRect(0, y, progress * w, bh, rad);
    ctx.fill();
    setShadowBlur(ctx, 0);
  }
  ctx.globalAlpha = 1;
}

function drawThick(canvas: HTMLCanvasElement, progress: number, buffered: number) {
  const r = setupCanvas(canvas);
  if (!r) return;
  const { ctx, w, h } = r;
  const { played, buffered: buffCol, unplayed } = getColors();
  const bh = Math.min(14, h);
  const rad = bh / 2;
  const y = (h - bh) / 2;

  ctx.globalAlpha = 0.25;
  ctx.fillStyle = unplayed;
  ctx.beginPath();
  ctx.roundRect(0, y, w, bh, rad);
  ctx.fill();

  if (buffered > 0) {
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = buffCol;
    ctx.beginPath();
    ctx.roundRect(0, y, buffered * w, bh, rad);
    ctx.fill();
  }

  if (progress > 0) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = played;
    ctx.shadowColor = played;
    setShadowBlur(ctx, 10);
    ctx.beginPath();
    ctx.roundRect(0, y, progress * w, bh, rad);
    ctx.fill();
    setShadowBlur(ctx, 0);
  }
  ctx.globalAlpha = 1;
}

function drawSegmented(canvas: HTMLCanvasElement, progress: number, buffered: number) {
  const r = setupCanvas(canvas);
  if (!r) return;
  const { ctx, w, h } = r;
  const { played, buffered: buffCol, unplayed } = getColors();
  const gap = 2;
  const segW = (w - gap * (SEG_COUNT - 1)) / SEG_COUNT;
  const segH = h * 0.65;
  const y = (h - segH) / 2;
  const playedIdx = Math.floor(progress * SEG_COUNT);

  for (let i = 0; i < SEG_COUNT; i++) {
    const frac = i / SEG_COUNT;
    const x = i * (segW + gap);
    setShadowBlur(ctx, 0);
    if (frac < progress) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = played;
      if (i === playedIdx - 1) {
        ctx.shadowColor = played;
        setShadowBlur(ctx, 5);
      }
    } else if (frac < buffered) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = buffCol;
    } else {
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = unplayed;
    }
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(1, segW), segH, 1);
    ctx.fill();
  }
  setShadowBlur(ctx, 0);
  ctx.globalAlpha = 1;
}

// ── new styles ────────────────────────────────────────────────────────────────

function drawNeon(canvas: HTMLCanvasElement, progress: number, buffered: number) {
  const r = setupCanvas(canvas);
  if (!r) return;
  const { ctx, w, h } = r;
  const { played, unplayed } = getColors();
  const cy = h / 2;

  // Ghost track — barely visible
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = unplayed;
  ctx.fillRect(0, cy - 1, w, 2);

  if (buffered > 0) {
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = unplayed;
    ctx.fillRect(0, cy - 1, buffered * w, 2);
  }

  if (progress <= 0) return;

  const px = progress * w;

  // Wide outer glow
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = played;
  ctx.shadowColor = played;
  setShadowBlur(ctx, 22);
  ctx.fillRect(0, cy - 5, px, 10);

  // Mid glow
  ctx.globalAlpha = 0.45;
  setShadowBlur(ctx, 12);
  ctx.fillRect(0, cy - 2.5, px, 5);

  // Inner glow
  ctx.globalAlpha = 0.85;
  setShadowBlur(ctx, 5);
  ctx.fillRect(0, cy - 1.5, px, 3);

  // Bright white core
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = played;
  setShadowBlur(ctx, 4);
  ctx.fillRect(0, cy - 0.75, px, 1.5);

  // End-cap flare
  setShadowBlur(ctx, 16);
  ctx.beginPath();
  ctx.arc(px, cy, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  setShadowBlur(ctx, 0);
  ctx.globalAlpha = 1;
}

function drawPulseWave(
  canvas: HTMLCanvasElement,
  progress: number,
  buffered: number,
  animState: AnimState,
) {
  const r = setupCanvas(canvas);
  if (!r) return;
  const { ctx, w, h } = r;
  const { played, buffered: buffCol, unplayed } = getColors();
  const cy = h / 2;
  const px = progress * w;
  const t = animState.time;

  // Base line
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = unplayed;
  ctx.fillRect(0, cy - 1, w, 2);

  if (buffered > 0) {
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = buffCol;
    ctx.fillRect(0, cy - 1, buffered * w, 2);
  }

  // Animated pulse centered at playhead
  const pulseR = Math.min(38, w * 0.13);
  const amp = Math.min(h * 0.42, 5.5);
  const sigma = pulseR * 0.42;
  const startX = Math.max(0, px - pulseR);
  const endX   = Math.min(w, px + pulseR);

  // Flat played line up to where the wave envelope starts
  if (progress > 0) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = played;
    ctx.shadowColor = played;
    setShadowBlur(ctx, 3);
    ctx.fillRect(0, cy - 1, startX, 2);
    setShadowBlur(ctx, 0);
  }

  ctx.globalAlpha = 1;
  ctx.strokeStyle = played;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = played;
  setShadowBlur(ctx, 7);
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  ctx.beginPath();
  ctx.moveTo(startX, cy);
  for (let x = startX; x <= endX; x += 0.75) {
    const dx  = x - px;
    const env = Math.exp(-(dx * dx) / (2 * sigma * sigma));
    const wave = env * amp * Math.sin(dx * 0.28 - t * 18);
    ctx.lineTo(x, cy - wave);
  }
  ctx.stroke();
  setShadowBlur(ctx, 0);
  ctx.globalAlpha = 1;
}

function drawParticleTrail(
  canvas: HTMLCanvasElement,
  progress: number,
  buffered: number,
  animState: AnimState,
) {
  const r = setupCanvas(canvas);
  if (!r) return;
  const { ctx, w, h } = r;
  const { played, buffered: buffCol, unplayed } = getColors();
  const cy = h / 2;
  const px = progress * w;

  // Spawn particles at playhead based on movement
  const prevPx = animState.lastProgress * w;
  const moved  = Math.abs(px - prevPx);
  const spawnN = Math.min(5, 1 + Math.floor(moved * 1.5));
  for (let i = 0; i < spawnN; i++) {
    animState.particles.push({
      x:       px + (Math.random() - 0.5) * 3,
      y:       cy + (Math.random() - 0.5) * (h * 0.55),
      vx:      -(Math.random() * 1.0 + 0.3),
      vy:      (Math.random() - 0.5) * 0.6,
      life:    1,
      maxLife: 25 + Math.random() * 35,
      size:    Math.random() * 1.8 + 0.8,
    });
  }
  animState.lastProgress = progress;

  // Update + cull
  for (const p of animState.particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy *= 0.97;
    p.life -= 1 / p.maxLife;
  }
  animState.particles = animState.particles.filter(p => p.life > 0);
  if (animState.particles.length > 180) {
    animState.particles = animState.particles.slice(-180);
  }

  // Background line
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = unplayed;
  ctx.fillRect(0, cy - 1, w, 2);

  if (buffered > 0) {
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = buffCol;
    ctx.fillRect(0, cy - 1, buffered * w, 2);
  }

  // Played line
  if (progress > 0) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = played;
    ctx.shadowColor = played;
    setShadowBlur(ctx, 4);
    ctx.fillRect(0, cy - 1, px, 2);
    setShadowBlur(ctx, 0);
  }

  // Particles
  ctx.shadowColor = played;
  for (const p of animState.particles) {
    ctx.globalAlpha = p.life * 0.85;
    setShadowBlur(ctx, 5);
    ctx.fillStyle = played;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  setShadowBlur(ctx, 0);

  // Playhead dot
  if (progress > 0) {
    const dx = Math.max(5, Math.min(w - 5, px));
    ctx.globalAlpha = 1;
    ctx.fillStyle = played;
    ctx.shadowColor = played;
    setShadowBlur(ctx, 10);
    ctx.beginPath();
    ctx.arc(dx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    setShadowBlur(ctx, 0);
  }

  ctx.globalAlpha = 1;
}

function drawLiquidFill(
  canvas: HTMLCanvasElement,
  progress: number,
  buffered: number,
  animState: AnimState,
) {
  const r = setupCanvas(canvas);
  if (!r) return;
  const { ctx, w, h } = r;
  const { played, buffered: buffCol, unplayed } = getColors();
  const t = animState.time;

  const tubeH = Math.min(13, Math.max(6, h * 0.62));
  const tubeR = tubeH / 2;
  const y0    = (h - tubeH) / 2;
  const y1    = y0 + tubeH;

  // Glass tube background
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = unplayed;
  ctx.beginPath();
  ctx.roundRect(0, y0, w, tubeH, tubeR);
  ctx.fill();
  ctx.globalAlpha = 0.3;
  ctx.strokeStyle = unplayed;
  ctx.lineWidth = 0.8;
  ctx.stroke();

  if (buffered > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, y0, w, tubeH, tubeR);
    ctx.clip();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = buffCol;
    ctx.fillRect(0, y0, buffered * w, tubeH);
    ctx.restore();
  }

  if (progress > 0) {
    const px = progress * w;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, y0, w, tubeH, tubeR);
    ctx.clip();

    // Liquid body with animated wave on top surface
    const surfaceY  = y0 + tubeH * 0.22; // liquid surface ~78% full
    const waveAmp   = Math.min(2.0, tubeH * 0.14);
    const waveFreq  = 0.09;

    ctx.beginPath();
    ctx.moveTo(-1, y1 + 1);
    ctx.lineTo(-1, surfaceY);

    for (let x = 0; x <= px + 1; x += 1) {
      const wave = waveAmp * Math.sin(x * waveFreq + t * 2.2);
      ctx.lineTo(x, surfaceY + wave);
    }
    ctx.lineTo(px + 1, y1 + 1);
    ctx.closePath();

    ctx.globalAlpha = 1;
    ctx.fillStyle = played;
    ctx.shadowColor = played;
    setShadowBlur(ctx, 9);
    ctx.fill();
    setShadowBlur(ctx, 0);

    // Glass highlight on top
    const hl = ctx.createLinearGradient(0, y0, 0, y0 + tubeH * 0.45);
    hl.addColorStop(0, 'rgba(255,255,255,0.28)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = hl;
    ctx.fillRect(0, y0, px, tubeH * 0.45);

    ctx.restore();
  }

  // Tube outline (on top)
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = unplayed;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.roundRect(0, y0, w, tubeH, tubeR);
  ctx.stroke();

  ctx.globalAlpha = 1;
}

function drawRetroTape(
  canvas: HTMLCanvasElement,
  progress: number,
  buffered: number,
  animState: AnimState,
) {
  const r = setupCanvas(canvas);
  if (!r) return;
  const { ctx, w, h } = r;
  const { played, buffered: buffCol, unplayed } = getColors();
  const cy = h / 2;

  animState.angle += 0.055;

  const reelR = Math.min(h / 2 - 0.5, 9);
  // Map progress to a center x that keeps the reel fully within the canvas
  const px = reelR + (w - 2 * reelR) * progress;

  // Background track
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = unplayed;
  ctx.fillRect(0, cy - 1, w, 2);

  if (buffered > 0) {
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = buffCol;
    ctx.fillRect(0, cy - 1, buffered * w, 2);
  }

  // Played portion — up to the left edge of the reel
  if (progress > 0) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = played;
    ctx.shadowColor = played;
    setShadowBlur(ctx, 4);
    ctx.fillRect(0, cy - 1, px - reelR, 2);
    setShadowBlur(ctx, 0);
  }

  // Spinning reel at playhead
  ctx.globalAlpha = 1;
  ctx.strokeStyle = played;
  ctx.lineWidth = 1;
  ctx.shadowColor = played;
  setShadowBlur(ctx, 7);

  // Outer ring
  ctx.beginPath();
  ctx.arc(px, cy, reelR, 0, Math.PI * 2);
  ctx.stroke();
  setShadowBlur(ctx, 0);

  // Hub
  const hubR = Math.max(1.5, reelR * 0.28);
  ctx.fillStyle = played;
  ctx.beginPath();
  ctx.arc(px, cy, hubR, 0, Math.PI * 2);
  ctx.fill();

  // Spokes
  if (reelR > hubR + 2) {
    ctx.lineWidth = 0.9;
    ctx.strokeStyle = played;
    for (let s = 0; s < 3; s++) {
      const a = animState.angle + (s * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(a) * (hubR + 0.5), cy + Math.sin(a) * (hubR + 0.5));
      ctx.lineTo(px + Math.cos(a) * (reelR - 0.5), cy + Math.sin(a) * (reelR - 0.5));
      ctx.stroke();
    }
  }

  setShadowBlur(ctx, 0);
  ctx.globalAlpha = 1;
}

// ── dispatcher ────────────────────────────────────────────────────────────────

export function drawSeekbar(
  canvas: HTMLCanvasElement,
  style: SeekbarStyle,
  heights: Float32Array | null,
  progress: number,
  buffered: number,
  animState?: AnimState,
) {
  bumpPerfCounter('waveformDraws');
  const anim = animState ?? makeAnimState();
  switch (style) {
    case 'truewave':      drawWaveform(canvas, heights, progress, buffered); break;
    case 'pseudowave':    drawWaveform(canvas, heights, progress, buffered); break;
    case 'linedot':       drawLineDot(canvas, progress, buffered); break;
    case 'bar':           drawBar(canvas, progress, buffered); break;
    case 'thick':         drawThick(canvas, progress, buffered); break;
    case 'segmented':     drawSegmented(canvas, progress, buffered); break;
    case 'neon':          drawNeon(canvas, progress, buffered); break;
    case 'pulsewave':     drawPulseWave(canvas, progress, buffered, anim); break;
    case 'particletrail': drawParticleTrail(canvas, progress, buffered, anim); break;
    case 'liquidfill':    drawLiquidFill(canvas, progress, buffered, anim); break;
    case 'retrotape':     drawRetroTape(canvas, progress, buffered, anim); break;
    // Safety net: if a legacy or tampered persisted style sneaks past the
    // authStore migration, fall back to the truewave renderer instead of
    // leaving a blank canvas.
    default:              drawWaveform(canvas, heights, progress, buffered); break;
  }
}

// ── SeekbarPreview (animated, for Settings) ───────────────────────────────────

export function SeekbarPreview({
  style,
  label,
  selected,
  onClick,
}: {
  style: SeekbarStyle;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let heights: Float32Array | null = null;
    if (style === 'truewave' || style === 'pseudowave') {
      heights = makeHeights('seekbar-preview-demo');
    }
    const animState = makeAnimState();
    let t = 0;
    let rafId: number | null = null;
    let pollId: number | null = null;
    const stop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (pollId !== null) {
        window.clearTimeout(pollId);
        pollId = null;
      }
    };
    const tick = () => {
      if (document.hidden || window.__psyHidden) {
        pollId = window.setTimeout(() => {
          pollId = null;
          tick();
        }, 400);
        return;
      }
      t += 0.016;
      animState.time = t;
      const progress = 0.15 + 0.65 * (0.5 + 0.5 * Math.sin(t));
      const buffered  = Math.min(1, progress + 0.18);
      drawSeekbar(canvas, style, heights, progress, buffered, animState);
      rafId = requestAnimationFrame(tick);
    };
    tick();
    return () => stop();
  }, [style]);

  return (
    <button
      onClick={onClick}
      style={{
        border: `2px solid ${selected ? 'var(--accent)' : 'var(--ctp-surface1)'}`,
        borderRadius: 8,
        background: selected
          ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
          : 'var(--bg-card, var(--ctp-base))',
        padding: '10px 12px 8px',
        cursor: 'pointer',
        width: 130,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        alignItems: 'stretch',
        transition: 'border-color 0.15s, background 0.15s',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: 24, display: 'block' }}
      />
      <span style={{
        fontSize: 11,
        color: selected ? 'var(--accent)' : 'var(--text-secondary)',
        textAlign: 'center',
        fontWeight: selected ? 600 : 400,
      }}>
        {label}
      </span>
    </button>
  );
}

// ── main component ────────────────────────────────────────────────────────────
//
// Architecture:
//   Static styles  (waveform, bar, …): drawn directly in the Zustand subscription
//     callback — no React re-renders, no rAF loop.  2 draws/s at the 500 ms
//     Rust interval.  shadowBlur + 500 canvas bars on a software-rendered
//     WebKitGTK context is too expensive for a continuous 60 fps loop.
//   Animated styles (pulsewave, particletrail, …): rAF loop at 60 fps, reads
//     refs that the subscription keeps up-to-date.
//   Drag: draws synchronously in seekToFraction for 1:1 responsiveness.

interface Props {
  trackId: string | undefined;
}

export default function WaveformSeek({ trackId }: Props) {
  const SEEK_COMMIT_GUARD_MS = 900;
  const SEEK_COMMIT_MIN_HOLD_MS = 320;
  const SEEK_COMMIT_PROGRESS_EPS = 0.02;
  const WHEEL_SEEK_STEP_SECONDS = 10;
  const WHEEL_SEEK_DEBOUNCE_MS = 350;
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const heightsRef   = useRef<Float32Array | null>(null);
  const progressRef  = useRef(getPlaybackProgressSnapshot().progress);
  const bufferedRef  = useRef(getPlaybackProgressSnapshot().buffered);
  const visualProgressRef = useRef(progressRef.current);
  const visualTargetProgressRef = useRef(progressRef.current);
  const isDragging   = useRef(false);
  const animStateRef = useRef<AnimState>(makeAnimState());
  const lastStaticDrawAtRef = useRef(0);
  const lastStaticDrawProgressRef = useRef(-1);
  const lastStaticDrawBufferedRef = useRef(-1);

  const [hoverPct, setHoverPct] = useState<number | null>(null);

  const seek         = usePlayerStore(s => s.seek);
  const isPlaying    = usePlayerStore(s => s.isPlaying);
  /** Track preview pauses the main sink in Rust; `isPlaying` stays true so the bar must not extrapolate. */
  const previewFreezesMainSeekbar = usePreviewStore(s => s.previewingId != null);
  const waveformBins = usePlayerStore(s => s.waveformBins);
  const duration     = usePlayerStore(s => s.currentTrack?.duration ?? 0);
  const seekbarStyle = useAuthStore(s => s.seekbarStyle);
  const animationMode = useAuthStore(s => s.animationMode);

  // Ref so the subscription callback (closed over at mount) can read the
  // current style without stale-closure issues.
  const styleRef = useRef(seekbarStyle);
  styleRef.current = seekbarStyle;
  const animationModeRef = useRef(animationMode);
  animationModeRef.current = animationMode;

  useEffect(() => {
    if (!trackId) {
      heightsRef.current = null;
      return;
    }
    // Pseudowave is the deterministic per-track-ID variant — no analysis needed,
    // no morph animation, no flat-fallback. It just sits there looking like a
    // waveform.
    if (seekbarStyle === 'pseudowave') {
      heightsRef.current = makeHeights(trackId);
      const canvas = canvasRef.current;
      if (canvas && !ANIMATED_STYLES.has(seekbarStyle)) {
        drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
      }
      return;
    }
    if (waveformBins && waveformBins.length > 0) {
      const h = binsToHeights(waveformBins);
      const prev = heightsRef.current;
      if (!prev || prev.length !== BAR_COUNT) {
        heightsRef.current = h;
        return;
      }
      if (heightsNearlyEqual(prev, h, 0.02)) {
        heightsRef.current = h;
        return;
      }
      const from = new Float32Array(prev);
      const to = h;
      const startedAt = performance.now();
      let raf = 0;
      const step = (now: number) => {
        const p = easeOutCubic((now - startedAt) / WAVE_MORPH_MS);
        const next = new Float32Array(BAR_COUNT);
        for (let i = 0; i < BAR_COUNT; i++) {
          next[i] = from[i] + (to[i] - from[i]) * p;
        }
        heightsRef.current = next;
        if (!ANIMATED_STYLES.has(styleRef.current)) {
          const canvas = canvasRef.current;
          if (canvas) drawSeekbar(canvas, styleRef.current, next, progressRef.current, bufferedRef.current, animStateRef.current);
        }
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    }
    if (heightsRef.current?.length === BAR_COUNT) {
      const current = heightsRef.current;
      let isAlreadyFlat = true;
      for (let i = 0; i < BAR_COUNT; i++) {
        if (Math.abs(current[i] - FLAT_WAVE_NORM) > 0.0001) {
          isAlreadyFlat = false;
          break;
        }
      }
      if (isAlreadyFlat) return;
      const from = new Float32Array(current);
      const to = makeFlatWaveHeights();
      const startedAt = performance.now();
      let raf = 0;
      const step = (now: number) => {
        const p = easeOutCubic((now - startedAt) / WAVE_MORPH_MS);
        const next = new Float32Array(BAR_COUNT);
        for (let i = 0; i < BAR_COUNT; i++) {
          next[i] = from[i] + (to[i] - from[i]) * p;
        }
        heightsRef.current = next;
        if (!ANIMATED_STYLES.has(styleRef.current)) {
          const canvas = canvasRef.current;
          if (canvas) drawSeekbar(canvas, styleRef.current, next, progressRef.current, bufferedRef.current, animStateRef.current);
        }
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf);
    }
    // No analysis bins yet: render 500 flat bars immediately.
    heightsRef.current = makeFlatWaveHeights();
  }, [trackId, waveformBins, seekbarStyle]);

  // Imperative subscription — no React re-renders from progress changes.
  // Static styles draw here; animated styles only update refs.
  useEffect(() => {
    return subscribePlaybackProgress((state, prev) => {
      if (state.progress === prev.progress && state.buffered === prev.buffered) return;
      // While user drags, keep the local preview stable. External progress ticks
      // during streaming/recovery would otherwise fight the cursor and flicker.
      if (isDragging.current) return;
      const now = Date.now();
      const wheelPreviewFraction = wheelPreviewFractionRef.current;
      if (wheelPreviewFraction != null) {
        if (now < wheelPreviewUntilRef.current) return;
        wheelPreviewFractionRef.current = null;
      }
      const pendingCommit = pendingCommittedSeekRef.current;
      if (pendingCommit) {
        const ageMs = Date.now() - pendingCommit.setAtMs;
        if (ageMs < SEEK_COMMIT_MIN_HOLD_MS) return;
        const matched = Math.abs(state.progress - pendingCommit.fraction) <= SEEK_COMMIT_PROGRESS_EPS;
        const expired = ageMs > SEEK_COMMIT_GUARD_MS;
        if (!matched && !expired) return;
        pendingCommittedSeekRef.current = null;
      }
      progressRef.current = state.progress;
      bufferedRef.current = state.buffered;
      progressAnchorRef.current = {
        progress: state.progress,
        atMs: performance.now(),
      };
      visualTargetProgressRef.current = isBarQuantizedSeekStyle(styleRef.current)
        ? quantizeProgressByBars(state.progress)
        : state.progress;
      // While paused the interpolation rAF is disabled, so keep the drawn playhead
      // in sync with external seeks (keyboard, MPRIS, queue). Drag/wheel still
      // update these refs via previewFraction.
      if (!usePlayerStore.getState().isPlaying) {
        visualProgressRef.current = visualTargetProgressRef.current;
      }
      // Static styles always redraw on progress; animated styles let the rAF
      // loop drive paints. In `static` animation mode we skip the rAF loop
      // entirely, so animated styles also need to repaint here on every tick.
      const drawNow =
        !ANIMATED_STYLES.has(styleRef.current) || animationModeRef.current === 'static';
      if (drawNow) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (!ANIMATED_STYLES.has(styleRef.current) && !isDragging.current) {
          const now = Date.now();
          const widthPx = Math.max(1, canvas.clientWidth || canvas.width || 1);
          const minVisualDelta = 0.35 / widthPx; // allow smoother progress while still skipping no-op paints
          const progressDelta = Math.abs(state.progress - lastStaticDrawProgressRef.current);
          const bufferedDelta = Math.abs(state.buffered - lastStaticDrawBufferedRef.current);
          const ageMs = now - lastStaticDrawAtRef.current;
          const visuallySame = progressDelta < minVisualDelta && bufferedDelta < minVisualDelta;
          if (
            ageMs < STATIC_REDRAW_MIN_MS &&
            visuallySame
          ) return;
          if (visuallySame && ageMs < STATIC_REDRAW_FORCE_MS) return;
          lastStaticDrawAtRef.current = now;
          lastStaticDrawProgressRef.current = state.progress;
          lastStaticDrawBufferedRef.current = state.buffered;
        }
        drawSeekbar(canvas, styleRef.current, heightsRef.current, visualProgressRef.current, state.buffered);
      }
    });
  }, []);

  // Initial draw for static styles when style, track, or waveform payload changes.
  useEffect(() => {
    if (ANIMATED_STYLES.has(seekbarStyle)) return;
    const canvas = canvasRef.current;
    if (canvas) drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current);
  }, [
    seekbarStyle,
    trackId,
    waveformBins,
    duration,
  ]);

  // rAF loop — animated styles only, and only in `full`/`reduced` mode.
  // In `static` mode the loop is skipped entirely; the imperative progress
  // subscription (~2 Hz audio heartbeat) handles repaints, so the seekbar
  // updates a couple of times per second with no wave animation.
  useEffect(() => {
    if (!ANIMATED_STYLES.has(seekbarStyle)) return;
    if (animationMode === 'static') {
      // Repaint once on entry so the canvas reflects current progress
      // without any wave morph and stays put until the next heartbeat.
      const canvas = canvasRef.current;
      if (canvas) {
        animStateRef.current = makeAnimState();
        drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
      }
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    animStateRef.current = makeAnimState();
    let rafId: number | null = null;
    let pollId: number | null = null;
    let skip = false;
    const stop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (pollId !== null) {
        window.clearTimeout(pollId);
        pollId = null;
      }
    };
    const tick = () => {
      if (document.hidden || window.__psyHidden) {
        pollId = window.setTimeout(() => {
          pollId = null;
          tick();
        }, 400);
        return;
      }
      // 30 fps cap in `reduced` mode: skip every other rAF, advance
      // animation time by a doubled delta so wave speed stays the same.
      const isReduced = animationModeRef.current === 'reduced';
      if (isReduced && skip) {
        skip = false;
        rafId = requestAnimationFrame(tick);
        return;
      }
      skip = isReduced;
      animStateRef.current.time += isReduced ? 0.032 : 0.016;
      drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
      rafId = requestAnimationFrame(tick);
    };
    tick();
    return () => stop();
  }, [seekbarStyle, animationMode]);

  // Smoothly advance progress between sparse transport ticks.
  // Preview pauses main sink in Rust while UI `isPlaying` may still be true.
  // When preview ends, interpolation must restart from "now", otherwise the
  // old anchor timestamp adds preview duration and causes a one-frame jump.
  useEffect(() => {
    progressAnchorRef.current = {
      progress: progressRef.current,
      atMs: performance.now(),
    };
    const quantizedOrRaw = isBarQuantizedSeekStyle(styleRef.current)
      ? quantizeProgressByBars(progressRef.current)
      : progressRef.current;
    visualTargetProgressRef.current = quantizedOrRaw;
    // Keep current visual position as-is; only reset timing anchor.
  }, [previewFreezesMainSeekbar]);

  useEffect(() => {
    if (!isPlaying || previewFreezesMainSeekbar || duration <= 0 || !isFinite(duration)) return;
    let rafId: number | null = null;
    let lastPaintAt = 0;
    const tick = (now: number) => {
      if (document.hidden || window.__psyHidden) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      if (isDragging.current) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const wheelPreviewFraction = wheelPreviewFractionRef.current;
      if (wheelPreviewFraction != null && Date.now() < wheelPreviewUntilRef.current) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      if (pendingCommittedSeekRef.current) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const anchor = progressAnchorRef.current;
      const elapsedSec = Math.max(0, (now - anchor.atMs) / 1000);
      const predicted = Math.max(0, Math.min(1, anchor.progress + elapsedSec / duration));
      const nextTargetProgress = isBarQuantizedSeekStyle(styleRef.current)
        ? quantizeProgressByBars(predicted)
        : predicted;
      if (Math.abs(nextTargetProgress - visualTargetProgressRef.current) > 0.000001) {
        visualTargetProgressRef.current = nextTargetProgress;
      }
      const currentVisual = visualProgressRef.current;
      const targetVisual = visualTargetProgressRef.current;
      const delta = targetVisual - currentVisual;
      if (Math.abs(delta) > 0.000001) {
        const smoothing = isBarQuantizedSeekStyle(styleRef.current) ? 0.22 : 0.28;
        const nextVisualProgress = Math.abs(delta) < 0.002
          ? targetVisual
          : currentVisual + delta * smoothing;
        visualProgressRef.current = nextVisualProgress;
        progressRef.current = nextVisualProgress;
        const needsDirectDraw =
          !ANIMATED_STYLES.has(styleRef.current) || animationModeRef.current === 'static';
        if (needsDirectDraw && now - lastPaintAt >= INTERPOLATION_PAINT_MIN_MS) {
          const canvas = canvasRef.current;
          if (canvas) {
            drawSeekbar(canvas, styleRef.current, heightsRef.current, nextVisualProgress, bufferedRef.current, animStateRef.current);
            lastPaintAt = now;
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [duration, isPlaying, previewFreezesMainSeekbar]);

  // Resize observer.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [seekbarStyle]);

  // Theme change observer — redraw canvas when theme changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new MutationObserver(() => {
      invalidateColorCache();
      drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [seekbarStyle]);

  const trackIdRef = useRef(trackId);
  trackIdRef.current = trackId;
  const seekRef = useRef(seek);
  seekRef.current = seek;
  const pendingSeekRef = useRef<number | null>(null);
  const pendingCommittedSeekRef = useRef<{ fraction: number; setAtMs: number } | null>(null);
  const progressAnchorRef = useRef<{ progress: number; atMs: number }>({
    progress: progressRef.current,
    atMs: performance.now(),
  });
  const wheelSeekTimerRef = useRef<number | null>(null);
  const queuedWheelSeekFractionRef = useRef<number | null>(null);
  const wheelPreviewFractionRef = useRef<number | null>(null);
  const wheelPreviewUntilRef = useRef(0);

  useEffect(() => () => {
    if (wheelSeekTimerRef.current != null) {
      window.clearTimeout(wheelSeekTimerRef.current);
      wheelSeekTimerRef.current = null;
    }
    wheelPreviewFractionRef.current = null;
    wheelPreviewUntilRef.current = 0;
  }, []);

  // Preview a 0–1 fraction while dragging: draw immediately for 1:1
  // responsiveness; the actual seek is committed on mouseup.
  const previewFraction = (fraction: number) => {
    progressRef.current = fraction;
    visualProgressRef.current = fraction;
    visualTargetProgressRef.current = fraction;
    progressAnchorRef.current = {
      progress: fraction,
      atMs: performance.now(),
    };
    pendingSeekRef.current = fraction;
    const canvas = canvasRef.current;
    if (canvas && !ANIMATED_STYLES.has(styleRef.current)) {
      drawSeekbar(canvas, styleRef.current, heightsRef.current, fraction, bufferedRef.current);
    }
  };

  const commitSeek = () => {
    const fraction = pendingSeekRef.current;
    if (fraction === null) return;
    pendingSeekRef.current = null;
    pendingCommittedSeekRef.current = { fraction, setAtMs: Date.now() };
    seekRef.current(fraction);
  };

  useEffect(() => {
    const seekFromX = (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !trackIdRef.current) return;
      const rect = canvas.getBoundingClientRect();
      previewFraction(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
    };
    const onMove = (e: MouseEvent) => { if (isDragging.current) seekFromX(e.clientX); };
    const onUp   = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      commitSeek();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {hoverPct !== null && duration > 0 && (
        <span
          className="player-volume-pct"
          style={{ left: `${hoverPct * 100}%` }}
        >
          {fmt(hoverPct * duration)}
        </span>
      )}
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '24px', cursor: trackId ? 'pointer' : 'default', display: 'block' }}
        onWheel={e => {
          if (!trackIdRef.current || duration <= 0 || isDragging.current) return;
          e.preventDefault();

          const wheelSteps = Math.max(1, Math.round(Math.abs(e.deltaY) / 100));
          if (wheelSteps <= 0) return;

          const now = Date.now();
          const currentSeconds = progressRef.current * duration;
          const deltaSeconds = (e.deltaY > 0 ? -1 : 1) * WHEEL_SEEK_STEP_SECONDS * wheelSteps;
          const nextSeconds = Math.max(0, Math.min(duration, currentSeconds + deltaSeconds));
          const nextFraction = Math.max(0, Math.min(1, nextSeconds / duration));

          // Preventive UI update: move visual playhead immediately on every wheel event.
          progressRef.current = nextFraction;
          visualProgressRef.current = nextFraction;
          visualTargetProgressRef.current = nextFraction;
          progressAnchorRef.current = {
            progress: nextFraction,
            atMs: performance.now(),
          };
          wheelPreviewFractionRef.current = nextFraction;
          wheelPreviewUntilRef.current = now + WHEEL_SEEK_DEBOUNCE_MS;
          const canvas = canvasRef.current;
          if (canvas && !ANIMATED_STYLES.has(styleRef.current)) {
            drawSeekbar(canvas, styleRef.current, heightsRef.current, nextFraction, bufferedRef.current);
          }

          // Trailing debounce: commit seek only after wheel activity settles.
          queuedWheelSeekFractionRef.current = nextFraction;
          if (wheelSeekTimerRef.current != null) {
            window.clearTimeout(wheelSeekTimerRef.current);
          }
          wheelSeekTimerRef.current = window.setTimeout(() => {
            wheelSeekTimerRef.current = null;
            const queuedFraction = queuedWheelSeekFractionRef.current;
            queuedWheelSeekFractionRef.current = null;
            if (queuedFraction == null) return;
            wheelPreviewFractionRef.current = null;
            wheelPreviewUntilRef.current = 0;
            pendingCommittedSeekRef.current = { fraction: queuedFraction, setAtMs: Date.now() };
            seekRef.current(queuedFraction);
          }, WHEEL_SEEK_DEBOUNCE_MS);
        }}
        onMouseDown={e => {
          isDragging.current = true;
          const rect = e.currentTarget.getBoundingClientRect();
          previewFraction(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
        }}
        onMouseMove={e => {
          if (!trackId) return;
          const rect = e.currentTarget.getBoundingClientRect();
          setHoverPct(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
        }}
        onMouseLeave={() => setHoverPct(null)}
      />
    </div>
  );
}
