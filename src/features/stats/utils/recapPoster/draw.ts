/**
 * Low-level canvas helpers for the Rewind posters: background recipe, grain,
 * glow text, cards. Everything randomised is seeded so a re-render of the same
 * poster is pixel-stable (the export modal re-renders on every option change).
 */

import { REWIND_CARD_BORDER, REWIND_CARD_RADIUS, REWIND_COLORS } from './tokens';

/** mulberry32 — tiny deterministic PRNG for grain and waveform shapes. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ellipsizes `text` to fit `maxWidth` at the current ctx font. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

/**
 * §10: long names may wrap to at most two balanced lines; each line is still
 * ellipsized as a last resort. Returns 1–2 lines.
 */
export function splitTwoLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const words = text.split(' ');
  if (words.length < 2) return [fitText(ctx, text, maxWidth)];
  let best = 1;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const a = ctx.measureText(words.slice(0, i).join(' ')).width;
    const b = ctx.measureText(words.slice(i).join(' ')).width;
    const delta = Math.abs(a - b);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return [
    fitText(ctx, words.slice(0, best).join(' '), maxWidth),
    fitText(ctx, words.slice(best).join(' '), maxWidth),
  ];
}

export function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

export function strokeRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.stroke();
}

/**
 * §3 background recipe: base fill, dark violet run-out at the bottom, one
 * radial hero glow, optional cover-derived tint, corner vignette.
 */
export function paintBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  heroGlow: { x: number; y: number; r: number },
  coverTint?: string | null,
): void {
  ctx.fillStyle = REWIND_COLORS.background;
  ctx.fillRect(0, 0, w, h);

  const toAlt = ctx.createLinearGradient(0, h * 0.45, 0, h);
  toAlt.addColorStop(0, 'rgba(22, 12, 44, 0)');
  toAlt.addColorStop(1, REWIND_COLORS.backgroundAlt);
  ctx.fillStyle = toAlt;
  ctx.fillRect(0, 0, w, h);

  if (coverTint) {
    const tint = ctx.createRadialGradient(w * 0.5, h * 0.32, 0, w * 0.5, h * 0.32, h * 0.7);
    tint.addColorStop(0, coverTint);
    tint.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  const glow = ctx.createRadialGradient(heroGlow.x, heroGlow.y, 0, heroGlow.x, heroGlow.y, heroGlow.r);
  glow.addColorStop(0, 'rgba(167, 131, 255, 0.30)');
  glow.addColorStop(0.55, 'rgba(167, 131, 255, 0.10)');
  glow.addColorStop(1, 'rgba(167, 131, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.hypot(w, h) / 2);
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
}

/** §3 grain: a seeded noise tile repeated at 2–3 % perceived strength. */
export function paintGrain(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number): void {
  const tileSize = 144;
  const tile = document.createElement('canvas');
  tile.width = tileSize;
  tile.height = tileSize;
  const tileCtx = tile.getContext('2d');
  if (!tileCtx) return;
  const image = tileCtx.createImageData(tileSize, tileSize);
  const rand = seededRandom(seed);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = rand() < 0.5 ? 0 : 255;
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = Math.floor(rand() * 18);
  }
  tileCtx.putImageData(image, 0, 0);
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) return;
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/**
 * Hero glow text: layered shadow passes below a bright-core gradient fill —
 * the "5" treatment from the mockups. Draws left-aligned at (x, baseline).
 */
export function drawGlowText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  baseline: number,
  font: string,
  sizePx: number,
): number {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const width = ctx.measureText(text).width;

  ctx.shadowColor = 'rgba(167, 131, 255, 0.85)';
  ctx.fillStyle = REWIND_COLORS.primaryPurple;
  for (const blur of [sizePx * 0.45, sizePx * 0.18]) {
    ctx.shadowBlur = blur;
    ctx.fillText(text, x, baseline);
  }
  ctx.shadowBlur = 0;

  const core = ctx.createLinearGradient(0, baseline - sizePx, 0, baseline);
  core.addColorStop(0, '#EFE7FF');
  core.addColorStop(0.55, REWIND_COLORS.brightPurple);
  core.addColorStop(1, REWIND_COLORS.primaryPurple);
  ctx.fillStyle = core;
  ctx.fillText(text, x, baseline);
  ctx.restore();
  return width;
}

/** §3 card: translucent dark fill with a thin purple contour. */
export function drawCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius = REWIND_CARD_RADIUS,
): void {
  ctx.save();
  ctx.fillStyle = REWIND_COLORS.card;
  fillRoundRect(ctx, x, y, w, h, radius);
  ctx.strokeStyle = 'rgba(110, 80, 166, 0.55)';
  ctx.lineWidth = REWIND_CARD_BORDER;
  strokeRoundRect(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, radius);
  ctx.restore();
}

/** Thin vertical separator between inline stats (nerd/artist stat rows). */
export function drawDivider(ctx: CanvasRenderingContext2D, x: number, y: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(110, 80, 166, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + height);
  ctx.stroke();
  ctx.restore();
}
