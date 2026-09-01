/**
 * The recurring Psysonic audio motifs (§5 WaveformMotif) plus the small
 * line icons the stat cards use. All strokes are hand-drawn paths so the
 * posters need no image assets beyond the wordmark and album covers.
 */

import { seededRandom } from './draw';
import { REWIND_COLORS } from './tokens';

/**
 * Layered light-trail waveform inside (x, y, w, h), centred vertically.
 * Seeded, so the same poster renders the same wave every time. `intensity`
 * scales amplitude and glow (hero waves 1, connective waves ~0.5).
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  intensity = 1,
): void {
  const rand = seededRandom(seed);
  const midY = y + h / 2;

  // A curve = smooth superimposed sines with a centre-weighted envelope, so
  // the wave is organic but calm at both ends, like the mockup light trails.
  const makeCurve = (amp: number): { xs: number[]; ys: number[] } => {
    const points = 8;
    const phase = rand() * Math.PI * 2;
    const freq = 1.6 + rand() * 1.4;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i <= points; i++) {
      const t = i / points;
      const envelope = Math.sin(Math.PI * t) ** 1.5;
      const wave =
        Math.sin(phase + t * Math.PI * freq * 2) * 0.7 +
        Math.sin(phase * 1.7 + t * Math.PI * freq * 3.1) * 0.3;
      xs.push(x + t * w);
      ys.push(midY + wave * envelope * (h / 2) * amp * intensity);
    }
    return { xs, ys };
  };

  const strokeCurve = (
    curve: { xs: number[]; ys: number[] },
    width: number,
    alpha: number,
    blur: number,
    bright: boolean,
  ) => {
    const stroke = ctx.createLinearGradient(x, 0, x + w, 0);
    stroke.addColorStop(0, 'rgba(167, 131, 255, 0)');
    stroke.addColorStop(0.5, bright ? '#F1EAFF' : REWIND_COLORS.brightPurple);
    stroke.addColorStop(1, 'rgba(167, 131, 255, 0)');
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = alpha * Math.min(1, intensity + 0.25);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(167, 131, 255, 0.9)';
    ctx.shadowBlur = blur * intensity;
    ctx.beginPath();
    ctx.moveTo(curve.xs[0], curve.ys[0]);
    for (let i = 1; i < curve.xs.length - 1; i++) {
      const cx = (curve.xs[i] + curve.xs[i + 1]) / 2;
      const cy = (curve.ys[i] + curve.ys[i + 1]) / 2;
      ctx.quadraticCurveTo(curve.xs[i], curve.ys[i], cx, cy);
    }
    ctx.lineTo(curve.xs[curve.xs.length - 1], curve.ys[curve.ys.length - 1]);
    ctx.stroke();
  };

  ctx.save();
  // Main trail: wide glow pass, then a bright core on the same path.
  const main = makeCurve(0.55);
  strokeCurve(main, 9, 0.55, 38, false);
  strokeCurve(main, 3.2, 1, 18, true);
  // Two supporting trails.
  strokeCurve(makeCurve(0.38), 2.2, 0.55, 12, false);
  strokeCurve(makeCurve(0.75), 1.5, 0.35, 9, false);
  // A few glow particles along the wave.
  ctx.shadowBlur = 10 * intensity;
  ctx.fillStyle = REWIND_COLORS.brightPurple;
  const particles = Math.round(6 * intensity);
  for (let i = 0; i < particles; i++) {
    const t = 0.15 + rand() * 0.7;
    ctx.globalAlpha = 0.25 + rand() * 0.5;
    ctx.beginPath();
    ctx.arc(x + t * w, midY + (rand() - 0.5) * h * 0.5, 1.2 + rand() * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Small equalizer-bar accent (lossless row, insight card corners). */
export function drawEqualizerBars(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
): void {
  const rand = seededRandom(seed);
  const barW = 5;
  const gap = 5;
  const count = Math.max(1, Math.floor((w + gap) / (barW + gap)));
  ctx.save();
  ctx.fillStyle = REWIND_COLORS.primaryPurple;
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    const envelope = 0.35 + 0.65 * Math.sin(Math.PI * t) ** 0.8;
    const barH = Math.max(4, h * envelope * (0.45 + rand() * 0.55));
    ctx.globalAlpha = 0.35 + 0.5 * (barH / h);
    ctx.beginPath();
    ctx.roundRect(x + i * (barW + gap), y + (h - barH) / 2, barW, barH, barW / 2);
    ctx.fill();
  }
  ctx.restore();
}

export type RewindIcon =
  | 'calendar'
  | 'headphones'
  | 'person'
  | 'moon'
  | 'sun'
  | 'hourglass'
  | 'shield'
  | 'lock'
  | 'globe'
  | 'note';

/**
 * Lucide-style stroked icon centred in a box of `size` at (x, y) top-left.
 * Paths are drawn on a 24×24 grid and scaled.
 */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  icon: RewindIcon,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  const s = size / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (icon) {
    case 'calendar':
      ctx.roundRect(3, 5, 18, 16, 2.5);
      ctx.moveTo(3, 10);
      ctx.lineTo(21, 10);
      ctx.moveTo(8, 2.5);
      ctx.lineTo(8, 6.5);
      ctx.moveTo(16, 2.5);
      ctx.lineTo(16, 6.5);
      ctx.stroke();
      break;
    case 'headphones':
      ctx.moveTo(4, 16);
      ctx.arc(12, 14, 8, Math.PI, 0, false);
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(3, 14, 4, 7, 2);
      ctx.roundRect(17, 14, 4, 7, 2);
      ctx.stroke();
      break;
    case 'person':
      ctx.arc(12, 8, 4.2, 0, Math.PI * 2);
      ctx.moveTo(19, 21);
      ctx.arc(12, 21.5, 7, Math.PI * 1.85, Math.PI * 1.15, true);
      ctx.stroke();
      break;
    case 'moon': {
      // Crescent: outer arc plus a returning inner arc.
      ctx.arc(12, 12, 8.5, Math.PI * 0.32, Math.PI * 1.68, false);
      ctx.arc(15.5, 12, 7, Math.PI * 1.55, Math.PI * 0.45, true);
      ctx.closePath();
      ctx.fill();
      // Two sparkles beside it.
      for (const [sx, sy, sr] of [
        [19.5, 5.5, 1.7],
        [21.5, 10, 1.1],
      ]) {
        ctx.beginPath();
        ctx.moveTo(sx, sy - sr);
        ctx.quadraticCurveTo(sx, sy, sx + sr, sy);
        ctx.quadraticCurveTo(sx, sy, sx, sy + sr);
        ctx.quadraticCurveTo(sx, sy, sx - sr, sy);
        ctx.quadraticCurveTo(sx, sy, sx, sy - sr);
        ctx.fill();
      }
      break;
    }
    case 'sun':
      ctx.arc(12, 12, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.moveTo(12 + Math.cos(a) * 7, 12 + Math.sin(a) * 7);
        ctx.lineTo(12 + Math.cos(a) * 9.5, 12 + Math.sin(a) * 9.5);
      }
      ctx.stroke();
      break;
    case 'hourglass':
      ctx.moveTo(6, 3);
      ctx.lineTo(18, 3);
      ctx.moveTo(6, 21);
      ctx.lineTo(18, 21);
      // Waisted body: both sides sweep through the pinch at (12, 12).
      ctx.moveTo(7.5, 3.5);
      ctx.bezierCurveTo(7.5, 8.5, 10.8, 10.2, 12, 12);
      ctx.bezierCurveTo(13.2, 13.8, 16.5, 15.5, 16.5, 20.5);
      ctx.moveTo(16.5, 3.5);
      ctx.bezierCurveTo(16.5, 8.5, 13.2, 10.2, 12, 12);
      ctx.bezierCurveTo(10.8, 13.8, 7.5, 15.5, 7.5, 20.5);
      ctx.stroke();
      break;
    case 'shield':
      ctx.moveTo(12, 2.5);
      ctx.lineTo(19.5, 5.5);
      ctx.lineTo(19.5, 11.5);
      ctx.bezierCurveTo(19.5, 17, 16, 20, 12, 21.8);
      ctx.bezierCurveTo(8, 20, 4.5, 17, 4.5, 11.5);
      ctx.lineTo(4.5, 5.5);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(8.5, 11.8);
      ctx.lineTo(11, 14.3);
      ctx.lineTo(15.5, 9.5);
      ctx.stroke();
      break;
    case 'lock':
      ctx.roundRect(5, 11, 14, 10, 2.5);
      ctx.moveTo(8, 11);
      ctx.lineTo(8, 8);
      ctx.arc(12, 8, 4, Math.PI, 0, false);
      ctx.lineTo(16, 11);
      ctx.stroke();
      break;
    case 'globe':
      ctx.arc(12, 12, 9, 0, Math.PI * 2);
      ctx.moveTo(3, 12);
      ctx.lineTo(21, 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(12, 12, 4.2, 9, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'note':
      ctx.moveTo(9.5, 18);
      ctx.lineTo(9.5, 5);
      ctx.lineTo(19, 3.5);
      ctx.lineTo(19, 16);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(7, 18, 2.8, 2.2, -0.25, 0, Math.PI * 2);
      ctx.ellipse(16.5, 16, 2.8, 2.2, -0.25, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
  ctx.restore();
}

/** Icon inside a soft circular badge — the mini-stat treatment. */
export function drawIconBadge(
  ctx: CanvasRenderingContext2D,
  icon: RewindIcon,
  cx: number,
  cy: number,
  radius: number,
): void {
  ctx.save();
  ctx.fillStyle = 'rgba(167, 131, 255, 0.10)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(167, 131, 255, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  const iconSize = radius * 1.1;
  drawIcon(ctx, icon, cx - iconSize / 2, cy - iconSize / 2, iconSize, REWIND_COLORS.brightPurple);
}
