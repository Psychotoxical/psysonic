/**
 * Frame plumbing for the visualizer: decode the compact `audio:spectrum`
 * payload, and interpolate between frames so the animation runs at display
 * refresh rate rather than at the emit rate.
 *
 * Rust emits at a fixed rate (default 60 Hz, user-configurable down to 10) and
 * the canvas draws on `requestAnimationFrame`. Those two clocks never line up,
 * so drawing the newest frame verbatim produces visible stepping at low emit
 * rates. Instead every frame is held alongside its predecessor and the renderer
 * reads a linear blend positioned by wall-clock time — the same trick the
 * waveform seekbar's animated renderers use.
 *
 * Pure module: no React, no Tauri, no canvas. Everything here is directly
 * unit-testable.
 */

/** Wire payload of the `audio:spectrum` event. Mirrors `SpectrumPayload` in
 *  `src-tauri/crates/psysonic-audio/src/spectrum.rs`. */
export interface SpectrumPayload {
  /** base64 bytes, `bandCount` long — 0..255 over a −72..0 dB range. */
  bands: string;
  /** base64 bytes, `bandCount` long — falling peak caps. */
  peaks: string;
  /** base64 bytes, `waveCount` long — signed traces centred on 128. The mono
   *  trace is derived from the pair rather than sent a third time. */
  waveformLeft: string;
  waveformRight: string;
  rms: number;
  peak: number;
  bandCount: number;
  waveCount: number;
  sampleRate: number;
}

/** Decoded frame in unit ranges: bands/peaks 0..1, waveforms −1..1. */
export interface SpectrumFrame {
  bands: Float32Array;
  peaks: Float32Array;
  /** Mono trace, derived from the channel pair. */
  waveform: Float32Array;
  waveformLeft: Float32Array;
  waveformRight: Float32Array;
  rms: number;
  peak: number;
  sampleRate: number;
}

/** Initial allocation only — frames resize to whatever the engine sends on the
 *  first payload (see `resizeFrame`). Kept in step with the Rust constants so
 *  the common case avoids one reallocation. */
export const DEFAULT_BAND_COUNT = 128;
export const DEFAULT_WAVE_COUNT = 256;

/** Sanity ceiling on payload-driven sizes, so a malformed frame can't make the
 *  renderer allocate unbounded arrays. */
const MAX_FRAME_POINTS = 4096;

/** Decode base64 to bytes. Returns an empty array for malformed input rather
 *  than throwing — a corrupt frame should drop, never break the render loop. */
export function decodeBase64(input: string): Uint8Array {
  if (!input) return new Uint8Array(0);
  try {
    const binary = atob(input);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

/** Allocate a zeroed frame. Frames are reused in place so the render loop never
 *  allocates. */
export function createFrame(
  bandCount = DEFAULT_BAND_COUNT,
  waveCount = DEFAULT_WAVE_COUNT,
): SpectrumFrame {
  return {
    bands: new Float32Array(bandCount),
    peaks: new Float32Array(bandCount),
    waveform: new Float32Array(waveCount),
    waveformLeft: new Float32Array(waveCount),
    waveformRight: new Float32Array(waveCount),
    rms: 0,
    peak: 0,
    sampleRate: 0,
  };
}

/**
 * Resize a frame's arrays to match the engine's counts, in place.
 *
 * The band and waveform counts are Rust-side constants, so the frontend must
 * follow the payload rather than assume them. It previously assumed, and
 * `writeUnit`'s `Math.min` then silently dropped everything past the frontend's
 * own length — raising `BAND_COUNT` in Rust would have cut the spectrum off
 * mid-range instead of adding detail.
 *
 * Contents are discarded: a resize only happens on the first frame or after a
 * genuine engine-side change, where one dropped frame is invisible.
 */
export function resizeFrame(frame: SpectrumFrame, bandCount: number, waveCount: number): void {
  const bands = Math.min(Math.max(1, Math.floor(bandCount)), MAX_FRAME_POINTS);
  const waves = Math.min(Math.max(1, Math.floor(waveCount)), MAX_FRAME_POINTS);

  if (Number.isFinite(bandCount) && frame.bands.length !== bands) {
    frame.bands = new Float32Array(bands);
    frame.peaks = new Float32Array(bands);
  }
  if (Number.isFinite(waveCount) && frame.waveform.length !== waves) {
    frame.waveform = new Float32Array(waves);
    frame.waveformLeft = new Float32Array(waves);
    frame.waveformRight = new Float32Array(waves);
  }
}

/** Reset a frame to silence in place. */
export function clearFrame(frame: SpectrumFrame): void {
  frame.bands.fill(0);
  frame.peaks.fill(0);
  frame.waveform.fill(0);
  frame.waveformLeft.fill(0);
  frame.waveformRight.fill(0);
  frame.rms = 0;
  frame.peak = 0;
}

function writeUnit(target: Float32Array, bytes: Uint8Array): void {
  const n = Math.min(target.length, bytes.length);
  for (let i = 0; i < n; i++) target[i] = bytes[i]! / 255;
  for (let i = n; i < target.length; i++) target[i] = 0;
}

function writeSigned(target: Float32Array, bytes: Uint8Array): void {
  const n = Math.min(target.length, bytes.length);
  for (let i = 0; i < n; i++) target[i] = (bytes[i]! - 128) / 127;
  for (let i = n; i < target.length; i++) target[i] = 0;
}

/**
 * Decode a payload into `frame` in place. Returns false when the payload is
 * unusable (wrong size, corrupt base64), leaving the frame untouched so the
 * renderer keeps showing the last good state instead of flashing to zero.
 */
export function applyPayload(frame: SpectrumFrame, payload: SpectrumPayload): boolean {
  const bands = decodeBase64(payload.bands);
  const peaks = decodeBase64(payload.peaks);
  if (bands.length === 0 || bands.length !== peaks.length) return false;

  writeUnit(frame.bands, bands);
  writeUnit(frame.peaks, peaks);
  writeSigned(frame.waveformLeft, decodeBase64(payload.waveformLeft));
  writeSigned(frame.waveformRight, decodeBase64(payload.waveformRight));
  // Mono is derived rather than transmitted — exact, and one array less on the
  // wire every frame.
  for (let i = 0; i < frame.waveform.length; i++) {
    frame.waveform[i] = ((frame.waveformLeft[i] ?? 0) + (frame.waveformRight[i] ?? 0)) / 2;
  }
  frame.rms = Number.isFinite(payload.rms) ? payload.rms : 0;
  frame.peak = Number.isFinite(payload.peak) ? payload.peak : 0;
  frame.sampleRate = payload.sampleRate ?? 0;
  return true;
}

/** Fill `frame` from a Web Audio `AnalyserNode` (the internet-radio path). */
export function applyAnalyserData(
  frame: SpectrumFrame,
  freqBytes: Uint8Array,
  timeBytes: Uint8Array,
): void {
  // AnalyserNode gives linearly-spaced bins; fold them onto the same number of
  // log-spaced bands the Rust path uses so both feeds render identically.
  foldLogBands(frame.bands, freqBytes);
  for (let i = 0; i < frame.peaks.length; i++) {
    frame.peaks[i] = Math.max(frame.bands[i]!, frame.peaks[i]! - 0.015);
  }
  // A single AnalyserNode taps the summed output, so radio has no channel
  // separation to offer — both traces show the same signal.
  writeSigned(frame.waveform, timeBytes);
  frame.waveformLeft.set(frame.waveform.subarray(0, frame.waveformLeft.length));
  frame.waveformRight.set(frame.waveform.subarray(0, frame.waveformRight.length));

  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < frame.waveform.length; i++) {
    const v = frame.waveform[i]!;
    sumSq += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  frame.rms = frame.waveform.length > 0 ? Math.sqrt(sumSq / frame.waveform.length) : 0;
  frame.peak = peak;
}

/**
 * Collapse linear FFT bins onto log-spaced bands, taking the peak of each
 * band's bins (matching `bands_from_magnitudes` on the Rust side).
 */
export function foldLogBands(out: Float32Array, bins: Uint8Array): void {
  const n = out.length;
  if (n === 0) return;
  if (bins.length === 0) {
    out.fill(0);
    return;
  }
  // Same 28 Hz..16 kHz span as the Rust layout, expressed as a fraction of the
  // bin array so it holds for any analyser size or sample rate.
  const minRatio = 0.0012;
  const ratio = Math.log(1 / minRatio) / n;
  let prevHi = 0;
  for (let b = 0; b < n; b++) {
    let lo = Math.floor(minRatio * Math.exp(ratio * b) * bins.length);
    let hi = Math.ceil(minRatio * Math.exp(ratio * (b + 1)) * bins.length);
    lo = Math.max(1, Math.min(lo, bins.length - 1));
    hi = Math.max(lo, Math.min(hi, bins.length - 1));
    if (lo <= prevHi && prevHi + 1 < bins.length) {
      lo = prevHi + 1;
      hi = Math.max(lo, hi);
    }
    prevHi = hi;
    let peak = 0;
    for (let i = lo; i <= hi; i++) peak = Math.max(peak, bins[i]!);
    out[b] = peak / 255;
  }
}

/** Copy `src` into `out` in place. */
export function copyFrame(out: SpectrumFrame, src: SpectrumFrame): void {
  out.bands.set(src.bands.subarray(0, out.bands.length));
  out.peaks.set(src.peaks.subarray(0, out.peaks.length));
  out.waveform.set(src.waveform.subarray(0, out.waveform.length));
  out.waveformLeft.set(src.waveformLeft.subarray(0, out.waveformLeft.length));
  out.waveformRight.set(src.waveformRight.subarray(0, out.waveformRight.length));
  out.rms = src.rms;
  out.peak = src.peak;
  out.sampleRate = src.sampleRate;
}

/**
 * Blend `prev` and `next` into `out` at position `t` (0..1), clamped.
 * Levels interpolate linearly; the waveform takes the newer frame outright
 * because blending two unrelated time-domain windows just cancels the trace.
 */
export function interpolateFrames(
  out: SpectrumFrame,
  prev: SpectrumFrame,
  next: SpectrumFrame,
  t: number,
): void {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  for (let i = 0; i < out.bands.length; i++) {
    const a = prev.bands[i] ?? 0;
    const b = next.bands[i] ?? 0;
    out.bands[i] = a + (b - a) * k;
    const pa = prev.peaks[i] ?? 0;
    const pb = next.peaks[i] ?? 0;
    out.peaks[i] = pa + (pb - pa) * k;
  }
  out.waveform.set(next.waveform.subarray(0, out.waveform.length));
  out.waveformLeft.set(next.waveformLeft.subarray(0, out.waveformLeft.length));
  out.waveformRight.set(next.waveformRight.subarray(0, out.waveformRight.length));
  out.rms = prev.rms + (next.rms - prev.rms) * k;
  out.peak = prev.peak + (next.peak - prev.peak) * k;
  out.sampleRate = next.sampleRate;
}

/**
 * Apply the user's sensitivity to a level.
 *
 * Sensitivity is a gamma, not a multiplier: gain would clip loud material into
 * a flat ceiling, whereas a gamma lifts quiet passages while leaving 1.0 fixed,
 * so a well-mastered track and a quiet live recording both stay readable.
 * `sensitivity` 1 is neutral; >1 lifts, <1 compresses.
 */
export function applySensitivity(level: number, sensitivity: number): number {
  if (level <= 0) return 0;
  if (level >= 1) return 1;
  const s = sensitivity > 0 ? sensitivity : 1;
  return Math.pow(level, 1 / s);
}
