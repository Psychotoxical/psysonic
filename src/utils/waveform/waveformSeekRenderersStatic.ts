import {
  BAR_COUNT, SEG_COUNT,
  getColors, setShadowBlur, setupCanvas, waveformBarThickness,
} from './waveformSeekHelpers';

export function drawWaveform(
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

export function drawLineDot(canvas: HTMLCanvasElement, progress: number, buffered: number) {
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

export function drawBar(canvas: HTMLCanvasElement, progress: number, buffered: number) {
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

export function drawThick(canvas: HTMLCanvasElement, progress: number, buffered: number) {
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

export function drawSegmented(canvas: HTMLCanvasElement, progress: number, buffered: number) {
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

export function drawNeon(canvas: HTMLCanvasElement, progress: number, buffered: number) {
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

