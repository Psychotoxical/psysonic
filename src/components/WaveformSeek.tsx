import React, { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore, type SeekbarStyle } from '../store/authStore';

function fmt(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

const BAR_COUNT = 500;
const SEG_COUNT = 60;

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

function getColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    played:   s.getPropertyValue('--waveform-played').trim()   || s.getPropertyValue('--accent').trim()       || '#cba6f7',
    buffered: s.getPropertyValue('--waveform-buffered').trim() || s.getPropertyValue('--ctp-overlay0').trim() || '#6c7086',
    unplayed: s.getPropertyValue('--waveform-unplayed').trim() || s.getPropertyValue('--ctp-surface1').trim() || '#313244',
  };
}

// ── canvas setup ──────────────────────────────────────────────────────────────

function setupCanvas(
  canvas: HTMLCanvasElement,
): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || canvas.clientWidth;
  const h = rect.height || canvas.clientHeight;
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

  if (!heights) {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = unplayed;
    ctx.fillRect(0, (h - 2) / 2, w, 2);
    ctx.globalAlpha = 1;
    return;
  }

  const x1Of = (i: number) => (i / BAR_COUNT) * w;
  const x2Of = (i: number) => ((i + 1) / BAR_COUNT) * w;

  ctx.globalAlpha = 0.28;
  ctx.fillStyle = unplayed;
  for (let i = 0; i < BAR_COUNT; i++) {
    if (i / BAR_COUNT < buffered) continue;
    const bh = Math.max(1, heights[i] * h);
    const x = x1Of(i);
    ctx.fillRect(x, (h - bh) / 2, x2Of(i) - x, bh);
  }

  ctx.globalAlpha = 0.45;
  ctx.fillStyle = buffCol;
  for (let i = 0; i < BAR_COUNT; i++) {
    const frac = i / BAR_COUNT;
    if (frac < progress || frac >= buffered) continue;
    const bh = Math.max(1, heights[i] * h);
    const x = x1Of(i);
    ctx.fillRect(x, (h - bh) / 2, x2Of(i) - x, bh);
  }

  if (progress > 0) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = played;
    ctx.shadowColor = played;
    ctx.shadowBlur = 5;
    for (let i = 0; i < BAR_COUNT; i++) {
      if (i / BAR_COUNT >= progress) break;
      const bh = Math.max(1, heights[i] * h);
      const x = x1Of(i);
      ctx.fillRect(x, (h - bh) / 2, x2Of(i) - x, bh);
    }
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;

  // Fade both edges to transparent using destination-in gradient mask
  const fadeW = Math.min(22, w * 0.07);
  const mask = ctx.createLinearGradient(0, 0, w, 0);
  mask.addColorStop(0, 'transparent');
  mask.addColorStop(fadeW / w, 'black');
  mask.addColorStop(1 - fadeW / w, 'black');
  mask.addColorStop(1, 'transparent');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
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
  ctx.shadowBlur = 7;
  ctx.beginPath();
  ctx.arc(dx, cy, dotR, 0, Math.PI * 2);
  ctx.fillStyle = played;
  ctx.fill();
  ctx.shadowBlur = 0;
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
    ctx.shadowBlur = 5;
    ctx.beginPath();
    ctx.roundRect(0, y, progress * w, bh, rad);
    ctx.fill();
    ctx.shadowBlur = 0;
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
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.roundRect(0, y, progress * w, bh, rad);
    ctx.fill();
    ctx.shadowBlur = 0;
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
    ctx.shadowBlur = 0;
    if (frac < progress) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = played;
      if (i === playedIdx - 1) {
        ctx.shadowColor = played;
        ctx.shadowBlur = 5;
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
  ctx.shadowBlur = 0;
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
  ctx.shadowBlur = 22;
  ctx.fillRect(0, cy - 5, px, 10);

  // Mid glow
  ctx.globalAlpha = 0.45;
  ctx.shadowBlur = 12;
  ctx.fillRect(0, cy - 2.5, px, 5);

  // Inner glow
  ctx.globalAlpha = 0.85;
  ctx.shadowBlur = 5;
  ctx.fillRect(0, cy - 1.5, px, 3);

  // Bright white core
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = played;
  ctx.shadowBlur = 4;
  ctx.fillRect(0, cy - 0.75, px, 1.5);

  // End-cap flare
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.arc(px, cy, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  ctx.shadowBlur = 0;
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
    ctx.shadowBlur = 3;
    ctx.fillRect(0, cy - 1, startX, 2);
    ctx.shadowBlur = 0;
  }

  ctx.globalAlpha = 1;
  ctx.strokeStyle = played;
  ctx.lineWidth = 1.5;
  ctx.shadowColor = played;
  ctx.shadowBlur = 7;
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
  ctx.shadowBlur = 0;
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
    ctx.shadowBlur = 4;
    ctx.fillRect(0, cy - 1, px, 2);
    ctx.shadowBlur = 0;
  }

  // Particles
  ctx.shadowColor = played;
  for (const p of animState.particles) {
    ctx.globalAlpha = p.life * 0.85;
    ctx.shadowBlur = 5;
    ctx.fillStyle = played;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // Playhead dot
  if (progress > 0) {
    const dx = Math.max(5, Math.min(w - 5, px));
    ctx.globalAlpha = 1;
    ctx.fillStyle = played;
    ctx.shadowColor = played;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(dx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
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
    ctx.shadowBlur = 9;
    ctx.fill();
    ctx.shadowBlur = 0;

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
    ctx.shadowBlur = 4;
    ctx.fillRect(0, cy - 1, px - reelR, 2);
    ctx.shadowBlur = 0;
  }

  // Spinning reel at playhead
  ctx.globalAlpha = 1;
  ctx.strokeStyle = played;
  ctx.lineWidth = 1;
  ctx.shadowColor = played;
  ctx.shadowBlur = 7;

  // Outer ring
  ctx.beginPath();
  ctx.arc(px, cy, reelR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;

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

  ctx.shadowBlur = 0;
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
  const anim = animState ?? makeAnimState();
  switch (style) {
    case 'waveform':      drawWaveform(canvas, heights, progress, buffered); break;
    case 'linedot':       drawLineDot(canvas, progress, buffered); break;
    case 'bar':           drawBar(canvas, progress, buffered); break;
    case 'thick':         drawThick(canvas, progress, buffered); break;
    case 'segmented':     drawSegmented(canvas, progress, buffered); break;
    case 'neon':          drawNeon(canvas, progress, buffered); break;
    case 'pulsewave':     drawPulseWave(canvas, progress, buffered, anim); break;
    case 'particletrail': drawParticleTrail(canvas, progress, buffered, anim); break;
    case 'liquidfill':    drawLiquidFill(canvas, progress, buffered, anim); break;
    case 'retrotape':     drawRetroTape(canvas, progress, buffered, anim); break;
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
  const rafRef    = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const heights   = style === 'waveform' ? makeHeights('seekbar-preview-demo') : null;
    const animState = makeAnimState();
    let t = 0;
    const tick = () => {
      t += 0.016;
      animState.time = t;
      const progress = 0.15 + 0.65 * (0.5 + 0.5 * Math.sin(t));
      const buffered  = Math.min(1, progress + 0.18);
      drawSeekbar(canvas, style, heights, progress, buffered, animState);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
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
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const heightsRef   = useRef<Float32Array | null>(null);
  const progressRef  = useRef(usePlayerStore.getState().progress);
  const bufferedRef  = useRef(usePlayerStore.getState().buffered);
  const isDragging   = useRef(false);
  const animStateRef = useRef<AnimState>(makeAnimState());

  const [hoverPct, setHoverPct] = useState<number | null>(null);

  const seek         = usePlayerStore(s => s.seek);
  const duration     = usePlayerStore(s => s.currentTrack?.duration ?? 0);
  const seekbarStyle = useAuthStore(s => s.seekbarStyle);

  // Ref so the subscription callback (closed over at mount) can read the
  // current style without stale-closure issues.
  const styleRef = useRef(seekbarStyle);
  styleRef.current = seekbarStyle;

  useEffect(() => {
    heightsRef.current = trackId ? makeHeights(trackId) : null;
  }, [trackId]);

  // Imperative subscription — no React re-renders from progress changes.
  // Static styles draw here; animated styles only update refs.
  useEffect(() => {
    return usePlayerStore.subscribe((state, prev) => {
      if (state.progress === prev.progress && state.buffered === prev.buffered) return;
      progressRef.current = state.progress;
      bufferedRef.current = state.buffered;
      if (!ANIMATED_STYLES.has(styleRef.current)) {
        const canvas = canvasRef.current;
        if (canvas) drawSeekbar(canvas, styleRef.current, heightsRef.current, state.progress, state.buffered);
      }
    });
  }, []);

  // Initial draw for static styles when style or track changes.
  useEffect(() => {
    if (ANIMATED_STYLES.has(seekbarStyle)) return;
    const canvas = canvasRef.current;
    if (canvas) drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current);
  }, [seekbarStyle, trackId]);

  // rAF loop — animated styles only.
  useEffect(() => {
    if (!ANIMATED_STYLES.has(seekbarStyle)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    animStateRef.current = makeAnimState();
    let rafId: number;
    const tick = () => {
      animStateRef.current.time += 0.016;
      drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [seekbarStyle]);

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
      drawSeekbar(canvas, seekbarStyle, heightsRef.current, progressRef.current, bufferedRef.current, animStateRef.current);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [seekbarStyle]);

  const trackIdRef = useRef(trackId);
  trackIdRef.current = trackId;
  const seekRef = useRef(seek);
  seekRef.current = seek;

  // Seek to a 0–1 fraction: draw immediately for 1:1 responsiveness, then
  // let the store + Rust catch up asynchronously.
  const seekToFraction = (fraction: number) => {
    progressRef.current = fraction;
    const canvas = canvasRef.current;
    if (canvas && !ANIMATED_STYLES.has(styleRef.current)) {
      drawSeekbar(canvas, styleRef.current, heightsRef.current, fraction, bufferedRef.current);
    }
    seekRef.current(fraction);
  };

  useEffect(() => {
    const seekFromX = (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !trackIdRef.current) return;
      const rect = canvas.getBoundingClientRect();
      seekToFraction(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
    };
    const onMove = (e: MouseEvent) => { if (isDragging.current) seekFromX(e.clientX); };
    const onUp   = () => { isDragging.current = false; };
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
        onMouseDown={e => {
          isDragging.current = true;
          const rect = e.currentTarget.getBoundingClientRect();
          seekToFraction(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
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
