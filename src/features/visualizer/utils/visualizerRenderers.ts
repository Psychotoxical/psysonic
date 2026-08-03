/**
 * Canvas renderers for the visualizer.
 *
 * Four modes, all drawn on a 2D context sized in CSS pixels (the caller applies
 * the device-pixel transform once per resize, not per frame):
 *
 *  • `bars`      — the classic Winamp spectrum analyzer: log-spaced bands with
 *                  falling peak caps, over one shared vertical gradient.
 *  • `scope`     — a time-domain oscilloscope with CRT phosphor persistence.
 *  • `radial`    — the waveform wrapped around a ring, over a feedback trail
 *                  that expands and fades outward.
 *  • `stereo`    — one half-ring per channel, anchored to its own edge and
 *                  growing inward, so the stereo image itself is the picture.
 *
 * The wave-based modes colour by intensity (`spectrumColor`) because they have
 * no height to carry level. `bars` deliberately does not: bar heights already
 * encode it, so per-band hue there reads as noise rather than information.
 *
 * Every draw function is a pure function of (context, size, frame, options) so
 * it can be exercised against a recording stub in tests.
 */

import { applySensitivity, type SpectrumFrame } from './spectrumFrame';
import { rgbToCss, spectrumColor, type VisualizerPalette } from './visualizerColors';

export interface RenderOptions {
  palette: VisualizerPalette;
  /** Gamma applied to levels; 1 is neutral. */
  sensitivity: number;
  /** Draw the falling peak caps. */
  showPeaks: boolean;
  /** Suppress glow/shadow work and frame-to-frame persistence. */
  reducedMotion: boolean;
}

/** Minimum drawn height so idle bands read as a baseline, not an empty canvas. */
const BASELINE_PX = 2;
/** Fraction of the width left as the gap between bars. */
const BAR_GAP_RATIO = 0.26;
/** Peak cap thickness in CSS pixels. */
const CAP_HEIGHT = 2;

/**
 * Size the backing store to the device pixel ratio and return a context whose
 * coordinate space is CSS pixels. Returns null when the canvas has no layout
 * box yet (first paint, hidden tab) — callers skip the frame.
 */
export function setupCanvas(
  canvas: HTMLCanvasElement,
  dprCap = 2,
): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return null;

  // Cap the DPR: a 3× backing store on a wide fullscreen visualizer is a lot of
  // fill rate for an effect nobody inspects pixel-by-pixel.
  const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
  const targetW = Math.round(width * dpr);
  const targetH = Math.round(height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

/** Mean of the lowest bands — drives the background bloom. */
export function bassEnergy(frame: SpectrumFrame): number {
  const n = Math.max(1, Math.floor(frame.bands.length / 8));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += frame.bands[i] ?? 0;
  return sum / n;
}

function setGlow(ctx: CanvasRenderingContext2D, color: string, blur: number, on: boolean): void {
  ctx.shadowColor = on ? color : 'transparent';
  ctx.shadowBlur = on ? blur : 0;
}

/** Peak bloom opacity at full low-end energy. */
const BLOOM_ALPHA = 0.24;
/** The bars already fill most of the frame, so a full-strength bloom behind
 *  them washes the whole panel out instead of reading as a glow. */
const BARS_BLOOM_STRENGTH = 0.25;

/**
 * Radial bloom behind the visualization, scaled by the low-end energy. This is
 * what makes the whole surface breathe with the track rather than just the
 * bars moving.
 */
export function drawBloom(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  energy: number,
  options: RenderOptions,
  strength = 1,
): void {
  if (options.reducedMotion || energy <= 0.02 || strength <= 0) return;
  const cx = width / 2;
  const cy = height;
  const radius = Math.max(width, height) * (0.35 + energy * 0.45);
  if (radius <= 0) return;

  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, rgbToCss(options.palette.glow, BLOOM_ALPHA * energy * strength));
  gradient.addColorStop(1, rgbToCss(options.palette.glow, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

/** Classic spectrum-analyzer bars with peak caps. */
export function drawBars(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: SpectrumFrame,
  options: RenderOptions,
): void {
  const count = frame.bands.length;
  if (count === 0 || width <= 0 || height <= 0) return;

  drawBloom(ctx, width, height, bassEnergy(frame), options, BARS_BLOOM_STRENGTH);

  const slot = width / count;
  const barWidth = Math.max(1, slot * (1 - BAR_GAP_RATIO));
  const offset = (slot - barWidth) / 2;

  setGlow(ctx, rgbToCss(options.palette.base, 0.8), Math.min(14, height * 0.05), !options.reducedMotion);

  // One shared vertical gradient across every bar, rather than colouring each
  // bar by its own level. Per-band colour makes a spectrum read as noise: the
  // bars are already differentiated by height, so varying hue on top of that
  // fights the shape instead of reinforcing it. The other modes keep intensity
  // colouring, where there is no height to carry the information.
  const gradient = ctx.createLinearGradient(0, height, 0, 0);
  gradient.addColorStop(0, rgbToCss(options.palette.base));
  gradient.addColorStop(0.55, rgbToCss(options.palette.mid));
  gradient.addColorStop(1, rgbToCss(options.palette.tip));
  ctx.fillStyle = gradient;

  for (let i = 0; i < count; i++) {
    const level = applySensitivity(frame.bands[i] ?? 0, options.sensitivity);
    const barHeight = Math.max(BASELINE_PX, level * height);
    ctx.fillRect(offset + i * slot, height - barHeight, barWidth, barHeight);
  }

  setGlow(ctx, 'transparent', 0, false);
  if (!options.showPeaks) return;

  ctx.fillStyle = rgbToCss(options.palette.cap, 0.92);
  for (let i = 0; i < count; i++) {
    const peak = applySensitivity(frame.peaks[i] ?? 0, options.sensitivity);
    if (peak <= 0.004) continue;
    // Keep the cap fully on-canvas at full scale.
    const y = Math.min(height - CAP_HEIGHT, height - peak * height);
    ctx.fillRect(offset + i * slot, y, barWidth, CAP_HEIGHT);
  }
}

/**
 * Time-domain oscilloscope.
 *
 * Draws over a phosphor-persistence buffer: the previous frame is dimmed in
 * place (not zoomed, unlike the radial tunnel) and the new trace drawn on top,
 * so a fast sweep leaves the decaying afterglow of a CRT tube rather than a
 * single hard line.
 *
 */
export function drawScope(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: SpectrumFrame,
  options: RenderOptions,
  state?: RendererState,
): void {
  const count = frame.waveform.length;
  if (count === 0 || width <= 0 || height <= 0) return;

  // Background layer, drawn straight to the canvas and never into the
  // persistence buffer. Anything composited into a buffer that decays to
  // `SCOPE_PERSISTENCE` each frame reaches a steady state of 1/(1−p) times its
  // intended brightness — at 0.82 that is ~5.5×, which blew out the bloom and
  // turned the centre line solid. Only the trace should persist.
  drawBloom(ctx, width, height, bassEnergy(frame), options);
  drawScopeAxis(ctx, width, height / 2, options);

  // One centred trace. Splitting the channels into stacked half-screens reads
  // as two separate instruments rather than one scope — the `stereo` mode is
  // where the channels get their own geometry.
  const trace = (target: CanvasRenderingContext2D): void => {
    drawTrace(target, width, height, frame.waveform, height / 2, height * 0.43, options, 0.5);
  };

  // Reduced motion means no afterglow — persistence is the effect the
  // preference exists to suppress.
  if (options.reducedMotion || !state) {
    trace(ctx);
    return;
  }

  const bufferCtx = ensureBuffer(state, width, height);
  if (!bufferCtx) {
    trace(ctx);
    return;
  }

  // Dim in place. `copy` + alpha replaces the buffer with a faded version of
  // itself, so the glow decays instead of accumulating to white.
  bufferCtx.save();
  bufferCtx.globalCompositeOperation = 'copy';
  bufferCtx.globalAlpha = SCOPE_PERSISTENCE;
  bufferCtx.drawImage(state.buffer!, 0, 0, width, height);
  bufferCtx.restore();

  bufferCtx.save();
  bufferCtx.globalAlpha = 1;
  trace(bufferCtx);
  bufferCtx.restore();

  // Buffer is transparent except where the trace is, so it composites cleanly
  // over the background layer above.
  ctx.drawImage(state.buffer!, 0, 0, width, height);
}

/** Scope-screen centre line. Part of the background, not the persisted trace. */
function drawScopeAxis(
  ctx: CanvasRenderingContext2D,
  width: number,
  axis: number,
  options: RenderOptions,
): void {
  ctx.strokeStyle = rgbToCss(options.palette.base, 0.18);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, axis);
  ctx.lineTo(width, axis);
  ctx.stroke();
}

/** How much of the previous scope frame survives — the phosphor decay rate. */
const SCOPE_PERSISTENCE = 0.82;

/** One oscilloscope polyline centred on `axis` with the given half-amplitude. */
function drawTrace(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  samples: Float32Array,
  axis: number,
  amplitude: number,
  options: RenderOptions,
  hue: number,
): void {
  const count = samples.length;
  if (count === 0) return;

  let rms = 0;
  for (let i = 0; i < count; i++) rms += samples[i]! * samples[i]!;
  rms = Math.sqrt(rms / count);

  // Line weight tracks loudness — quiet passages read as a thin thread, loud
  // ones as a heavy stroke, which is most of what makes a scope feel alive.
  ctx.lineWidth = Math.max(1.25, Math.min(4, 1.25 + rms * 5));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = rgbToCss(spectrumColor(options.palette, Math.min(1, rms * 2.2), hue));
  setGlow(ctx, rgbToCss(options.palette.tip, 0.85), Math.min(16, height * 0.06), !options.reducedMotion);

  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const x = (i / (count - 1 || 1)) * width;
    const raw = samples[i] ?? 0;
    // Same gamma as the bars, applied to magnitude so the sign survives.
    const shaped = Math.sign(raw) * applySensitivity(Math.abs(raw), options.sensitivity);
    const y = axis - shaped * amplitude;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  setGlow(ctx, 'transparent', 0, false);
}

// ─── Radial scope ────────────────────────────────────────────────────────────

/** How much the trail expands per frame — the outward "tunnel" speed. */
const TRAIL_ZOOM = 1.022;
/** How much of the previous frame survives. Lower = shorter tail. */
const TRAIL_FADE = 0.9;
/** The trail buffer renders at a lower DPR than the canvas: it is a blurred
 *  ghost, so full resolution is fill rate spent on something nobody can see. */
const TRAIL_DPR_CAP = 1.25;

/**
 * Persistent scratch for renderers that need frame-to-frame history.
 * Owned by the component and reset when the mode or surface changes.
 */
export interface RendererState {
  /** Offscreen scratch: the feedback trail for `radial`, the scrolling history
   *  for `waterfall`. Only one mode is live at a time and the state is reset on
   *  every mode change, so a single buffer serves both. */
  buffer: HTMLCanvasElement | null;
  bufferWidth: number;
  bufferHeight: number;
}

export function createRendererState(): RendererState {
  return { buffer: null, bufferWidth: 0, bufferHeight: 0 };
}

/** Drop the offscreen buffer (mode switch, unmount, resize). */
export function resetRendererState(state: RendererState): void {
  state.buffer = null;
  state.bufferWidth = 0;
  state.bufferHeight = 0;
}

/** Segments the radial ring is stroked in — enough for smooth colour travel
 *  without paying a draw call per sample. */
const RING_SEGMENTS = 32;

function ensureBuffer(
  state: RendererState,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, TRAIL_DPR_CAP);
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));

  if (!state.buffer || state.bufferWidth !== w || state.bufferHeight !== h) {
    // A resize invalidates the old content — starting clean beats stretching a
    // smeared ghost to the new aspect ratio.
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    state.buffer = canvas;
    state.bufferWidth = w;
    state.bufferHeight = h;
  }

  const ctx = state.buffer.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(w / width, 0, 0, h / height, 0, 0);
  return ctx;
}

/**
 * Winamp/MilkDrop-style circular oscilloscope: the waveform wrapped around a
 * ring that pulses with the low end, over a feedback trail that expands and
 * fades outward so each frame leaves a ghost drifting off the edge.
 *
 * The trail is real feedback, not a stack of stored frames — the buffer is
 * redrawn onto itself slightly enlarged and slightly dimmed every frame, which
 * is how the original effect worked and costs one blit regardless of tail
 * length.
 */
export function drawRadialScope(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: SpectrumFrame,
  options: RenderOptions,
  state: RendererState,
): void {
  const count = frame.waveform.length;
  if (count === 0 || width <= 0 || height <= 0) return;

  // Reduced motion means no feedback trail — that persistence is precisely the
  // effect the preference asks us to drop. Draw a single clean ring instead.
  if (options.reducedMotion) {
    drawScopeRing(ctx, width, height, frame, options);
    return;
  }

  const trailCtx = ensureBuffer(state, width, height);
  if (!trailCtx) {
    drawScopeRing(ctx, width, height, frame, options);
    return;
  }

  // Expand and dim what is already there.
  const cx = width / 2;
  const cy = height / 2;
  trailCtx.save();
  trailCtx.globalCompositeOperation = 'copy';
  trailCtx.globalAlpha = TRAIL_FADE;
  trailCtx.translate(cx, cy);
  trailCtx.scale(TRAIL_ZOOM, TRAIL_ZOOM);
  trailCtx.translate(-cx, -cy);
  trailCtx.drawImage(state.buffer!, 0, 0, width, height);
  trailCtx.restore();

  // Draw this frame's ring on top of the decayed trail.
  trailCtx.save();
  trailCtx.globalAlpha = 1;
  drawScopeRing(trailCtx, width, height, frame, options);
  trailCtx.restore();

  ctx.drawImage(state.buffer!, 0, 0, width, height);
}

/** One ring of the radial scope, without any trail handling. */
function drawScopeRing(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: SpectrumFrame,
  options: RenderOptions,
): void {
  const count = frame.waveform.length;
  if (count === 0) return;

  const cx = width / 2;
  const cy = height / 2;
  const energy = bassEnergy(frame);
  // The ring breathes with the low end; the reach is what the waveform adds.
  const base = Math.min(width, height) * (0.17 + energy * 0.06);
  const reach = Math.min(width, height) * 0.15;

  ctx.lineWidth = Math.max(1.4, Math.min(4, 1.4 + frame.rms * 4));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  setGlow(ctx, rgbToCss(options.palette.tip, 0.9), 12, !options.reducedMotion);

  // Point on the ring for sample `i`, wrapping so the ring closes without a
  // visible seam where the analysis window begins.
  const pointAt = (i: number): { x: number; y: number; intensity: number } => {
    const sample = frame.waveform[i % count] ?? 0;
    const shaped = Math.sign(sample) * applySensitivity(Math.abs(sample), options.sensitivity);
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    const r = Math.max(1, base + shaped * reach);
    return {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      intensity: Math.abs(shaped),
    };
  };

  // Stroked as coloured arcs rather than one path with a vertical gradient: a
  // top-to-bottom ramp is flat by construction (the same colours in the same
  // places every frame, whatever the audio does). Colouring each arc by the
  // waveform's local amplitude makes loud excursions glow hot and travel around
  // the ring with the music.
  const step = Math.max(1, Math.round(count / RING_SEGMENTS));
  for (let start = 0; start < count; start += step) {
    const end = Math.min(start + step, count);
    let peak = 0;
    ctx.beginPath();
    for (let i = start; i <= end; i++) {
      const p = pointAt(i);
      peak = Math.max(peak, p.intensity);
      if (i === start) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = rgbToCss(spectrumColor(options.palette, peak, start / count));
    ctx.stroke();
  }
  setGlow(ctx, 'transparent', 0, false);
}

// ─── Stereo rings ────────────────────────────────────────────────────────────

/** How much of the previous stereo frame survives — the drifting "float". */
const STEREO_PERSISTENCE = 0.86;
/** Resting radius of each arc — a true circle, bounded by both axes so it never
 *  renders as a stretched ellipse. Everything else is expressed as a multiple of
 *  it, which is what keeps the vertical extent tied to the height alone. */
const STEREO_RADIUS_W = 0.30;
const STEREO_RADIUS_H = 0.30;
/** Extra inward reach at full level, as a multiple of the resting radius. */
const STEREO_REACH = 0.9;
/** Waveform ripple depth, as a multiple of the resting radius. */
const STEREO_RIPPLE = 0.35;
/** Arc segments per ring — enough for smooth colour travel without a draw call
 *  per sample. */
const STEREO_SEGMENTS = 28;

/** RMS of a channel's window, 0..1. */
function traceRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

/**
 * True stereo view: one arc per channel, centred on its own edge at mid-height,
 * with the audio growing *towards the middle*.
 *
 * Growth is weighted by `cos(angle)`, so it is strongest at the innermost point
 * and falls to nothing at the top and bottom — which pins each arc's endpoints
 * to its edge and leaves the vertical size fixed by `STEREO_BASE_H` alone. That
 * is what keeps the shape from stretching: the panel's width can only ever move
 * the arc further in, never taller or flatter.
 *
 * A mono mix produces two exact mirror images, so any asymmetry you see is
 * genuine channel difference — the stereo image itself is the picture.
 * Persistence fades in place (as the scope does) rather than zooming.
 */
export function drawStereoRings(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: SpectrumFrame,
  options: RenderOptions,
  state: RendererState,
): void {
  if (frame.waveformLeft.length === 0 || width <= 0 || height <= 0) return;

  const paint = (target: CanvasRenderingContext2D): void => {
    drawChannelRing(target, width, height, frame.waveformLeft, 'left', options);
    drawChannelRing(target, width, height, frame.waveformRight, 'right', options);
  };

  if (options.reducedMotion) {
    paint(ctx);
    return;
  }

  const bufferCtx = ensureBuffer(state, width, height);
  if (!bufferCtx) {
    paint(ctx);
    return;
  }

  bufferCtx.save();
  bufferCtx.globalCompositeOperation = 'copy';
  bufferCtx.globalAlpha = STEREO_PERSISTENCE;
  bufferCtx.drawImage(state.buffer!, 0, 0, width, height);
  bufferCtx.restore();

  bufferCtx.save();
  bufferCtx.globalAlpha = 1;
  paint(bufferCtx);
  bufferCtx.restore();

  ctx.drawImage(state.buffer!, 0, 0, width, height);
}

/** One channel's ring, in its own half, drifting towards the centre with level. */
function drawChannelRing(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  samples: Float32Array,
  side: 'left' | 'right',
  options: RenderOptions,
): void {
  const count = samples.length;
  if (count === 0) return;

  // Centred on the edge itself: only the inner half is ever on screen, so the
  // arc reads as growing out of the side of the panel.
  const inward = side === 'left' ? 1 : -1;
  const cx = side === 'left' ? 0 : width;
  const cy = height / 2;

  const rms = traceRms(samples);
  // The resting shape is a semicircle; growth is a multiple of its radius, so
  // the whole figure scales together instead of elongating on a wide panel.
  const base = Math.min(width * STEREO_RADIUS_W, height * STEREO_RADIUS_H);
  const ripple = base * STEREO_RIPPLE;
  const reach = rms * base * STEREO_REACH;

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.4, Math.min(4.5, 1.4 + rms * 5));
  setGlow(
    ctx,
    rgbToCss(options.palette.tip, 0.85),
    Math.min(18, height * 0.07),
    !options.reducedMotion,
  );

  const pointAt = (i: number): { x: number; y: number; intensity: number } => {
    // Clamped read, so the sweep can include the closing endpoint at +90°.
    const sample = samples[Math.min(i, count - 1)] ?? 0;
    const shaped = Math.sign(sample) * applySensitivity(Math.abs(sample), options.sensitivity);
    // −90°..+90°: the visible half only, sweeping from the top of the edge,
    // round through the innermost point, back down to the bottom of the edge.
    const angle = (i / count) * Math.PI - Math.PI / 2;
    // Squared cosine: 1 pointing inward, 0 at the endpoints, and falling off
    // faster than a plain cosine either side. That concentrates the growth
    // towards the middle instead of letting it swell the arc vertically too,
    // while still pinning the endpoints to the edge.
    const c = Math.cos(angle);
    const inwardness = c * c;
    const r = Math.max(1, base + (reach + shaped * ripple) * inwardness);
    return {
      x: cx + inward * c * r,
      y: cy + Math.sin(angle) * r,
      intensity: Math.abs(shaped),
    };
  };

  const step = Math.max(1, Math.round(count / STEREO_SEGMENTS));
  for (let start = 0; start < count; start += step) {
    const end = Math.min(start + step, count);
    if (end <= start) break;
    let peak = 0;
    ctx.beginPath();
    for (let i = start; i <= end; i++) {
      const p = pointAt(i);
      peak = Math.max(peak, p.intensity);
      if (i === start) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    // Hue drifts along the arc, brightness follows the local amplitude.
    ctx.strokeStyle = rgbToCss(spectrumColor(options.palette, peak, start / count));
    ctx.stroke();
  }
  setGlow(ctx, 'transparent', 0, false);
}


export type VisualizerMode = 'bars' | 'scope' | 'radial' | 'stereo';

export const VISUALIZER_MODES: VisualizerMode[] = ['bars', 'scope', 'radial', 'stereo'];

/** True for modes that keep frame-to-frame history and must not be cleared. */
export function modeKeepsHistory(mode: VisualizerMode): boolean {
  return mode === 'radial' || mode === 'stereo' || mode === 'scope';
}

/** Clear and draw one frame in the requested mode. */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: SpectrumFrame,
  mode: VisualizerMode,
  options: RenderOptions,
  state?: RendererState,
): void {
  ctx.clearRect(0, 0, width, height);
  if (mode === 'stereo') {
    drawStereoRings(ctx, width, height, frame, options, state ?? createRendererState());
  } else if (mode === 'radial') {
    drawRadialScope(ctx, width, height, frame, options, state ?? createRendererState());
  } else if (mode === 'scope') {
    drawScope(ctx, width, height, frame, options, state);
  } else {
    drawBars(ctx, width, height, frame, options);
  }
}
