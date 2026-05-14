import { EQ_BANDS } from '../store/eqStore';

// ─── Frequency response canvas ────────────────────────────────────────────────

const SAMPLE_RATE = 44100;
const EQ_Q = 1.41;

export function biquadPeakResponse(freq: number, centerHz: number, gainDb: number, sampleRate: number): number {
  if (Math.abs(gainDb) < 0.01) return 0;
  const w0 = (2 * Math.PI * centerHz) / sampleRate;
  const A = Math.pow(10, gainDb / 40);
  const alpha = Math.sin(w0) / (2 * EQ_Q);
  const b0 = 1 + alpha * A;
  const b1 = -2 * Math.cos(w0);
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha / A;
  const w = (2 * Math.PI * freq) / sampleRate;
  const cosW = Math.cos(w), sinW = Math.sin(w);
  const cos2W = Math.cos(2 * w), sin2W = Math.sin(2 * w);
  const numRe = b0 + b1 * cosW + b2 * cos2W;
  const numIm = - b1 * sinW - b2 * sin2W;
  const denRe = a0 + a1 * cosW + a2 * cos2W;
  const denIm = - a1 * sinW - a2 * sin2W;
  const numMag2 = numRe * numRe + numIm * numIm;
  const denMag2 = denRe * denRe + denIm * denIm;
  return 10 * Math.log10(numMag2 / denMag2);
}

export function drawCurve(canvas: HTMLCanvasElement, gains: number[], accentColor: string, bgColor: string, textColor: string) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;

  const fMin = 20, fMax = 20000;
  const dbMin = -13, dbMax = 13;
  const padL = 36, padR = 8, padT = 8, padB = 1;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // Canvas hidden or not laid out yet (e.g. inside a collapsed <details> on macOS WebKit).
  // Bail before allocating an invalid back-buffer; ResizeObserver redraws when the canvas
  // gets real dimensions.
  if (innerW <= 0 || innerH <= 0) return;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const freqToX = (f: number) =>
    padL + (Math.log10(f / fMin) / Math.log10(fMax / fMin)) * innerW;
  const dbToY = (db: number) =>
    padT + ((dbMax - db) / (dbMax - dbMin)) * innerH;

  // Background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, W, H);

  // Grid: dB lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  [-12, -6, 0, 6, 12].forEach(db => {
    const y = dbToY(db);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(db === 0 ? '0' : (db > 0 ? `+${db}` : `${db}`), padL - 4, y + 3);
  });

  // Grid: frequency lines
  [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].forEach(f => {
    const x = freqToX(f);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, H - padB);
    ctx.stroke();
  });

  // Zero line (brighter)
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, dbToY(0));
  ctx.lineTo(W - padR, dbToY(0));
  ctx.stroke();

  // Frequency response curve
  const points: [number, number][] = [];
  const steps = innerW * 2;
  for (let i = 0; i <= steps; i++) {
    const f = fMin * Math.pow(fMax / fMin, i / steps);
    let totalDb = 0;
    for (let band = 0; band < 10; band++) {
      totalDb += biquadPeakResponse(f, EQ_BANDS[band].freq, gains[band], SAMPLE_RATE);
    }
    totalDb = Math.max(dbMin, Math.min(dbMax, totalDb));
    points.push([freqToX(f), dbToY(totalDb)]);
  }

  // Fill under curve
  const grad = ctx.createLinearGradient(0, padT, 0, H);
  grad.addColorStop(0, accentColor.replace(')', ', 0.25)').replace('rgb', 'rgba'));
  grad.addColorStop(1, accentColor.replace(')', ', 0.0)').replace('rgb', 'rgba'));

  ctx.beginPath();
  ctx.moveTo(points[0][0], dbToY(0));
  points.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(points[points.length - 1][0], dbToY(0));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Curve line
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  points.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.8;
  ctx.stroke();
}
