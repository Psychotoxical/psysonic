import type { SeekbarStyle } from '../store/authStoreTypes';
import { bumpPerfCounter } from './perfTelemetry';
import {
  AnimState, BAR_COUNT, SEG_COUNT,
  getColors, makeAnimState, setShadowBlur, setupCanvas, waveformBarThickness,
} from './waveformSeekHelpers';

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
