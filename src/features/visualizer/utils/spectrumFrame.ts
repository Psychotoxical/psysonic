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
  /** base64 bytes, `bandCount` long — 0..255 over a -60..0 dB range. */
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

/** Shared display contract with `spectrum_dsp.rs`. */
export const SPECTRUM_FLOOR_DB = -60;
export const SPECTRUM_MIN_HZ = 28;
export const SPECTRUM_MAX_HZ = 16_000;

const DEFAULT_RESPONSIVENESS = 0.65;
const TILT_DB_PER_OCTAVE = 3;
const TILT_REF_HZ = 200;
const TILT_MAX_DB = 18;
const FRAME_SILENCE_EPSILON = 0.0005;
/** Equivalent to the old 0.86-per-60-Hz-frame fade, but independent of FPS. */
const IDLE_DECAY_TAU_SECONDS = 0.11;

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
  frame.sampleRate = 0;
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
 * Pick one channel for mono display modes using whole-window energy. A stable
 * channel choice preserves right-only and anti-phase stereo without switching
 * polarity sample-by-sample or feeding a nonlinear signal into the FFT.
 */
function writePhaseSafeMono(
  target: Float32Array,
  left: Float32Array,
  right: Float32Array,
): void {
  let leftEnergy = 0;
  let rightEnergy = 0;
  const n = Math.min(target.length, left.length, right.length);
  for (let i = 0; i < n; i++) {
    leftEnergy += left[i]! * left[i]!;
    rightEnergy += right[i]! * right[i]!;
  }
  const source = rightEnergy > leftEnergy ? right : left;
  target.set(source.subarray(0, target.length));
}

/** Scratch retained by the radio feed so smoothing never allocates per frame. */
export interface SpectrumEnvelopeState {
  targetBands: Float32Array;
  peakHold: Float32Array;
}

export function createSpectrumEnvelopeState(
  bandCount = DEFAULT_BAND_COUNT,
): SpectrumEnvelopeState {
  return {
    targetBands: new Float32Array(bandCount),
    peakHold: new Float32Array(bandCount),
  };
}

function ensureEnvelopeSize(state: SpectrumEnvelopeState, bandCount: number): void {
  if (state.targetBands.length === bandCount) return;
  state.targetBands = new Float32Array(bandCount);
  state.peakHold = new Float32Array(bandCount);
}

function smoothingProfile(responsiveness: number): {
  attackTau: number;
  decayTau: number;
  peakHold: number;
  peakFall: number;
} {
  const r = Number.isFinite(responsiveness)
    ? Math.max(0, Math.min(1, responsiveness))
    : DEFAULT_RESPONSIVENESS;
  const lerp = (a: number, b: number): number => a + (b - a) * r;
  return {
    attackTau: lerp(0.014, 0.0015),
    decayTau: lerp(0.20, 0.03),
    peakHold: lerp(0.70, 0.20),
    peakFall: lerp(0.55, 1.80),
  };
}

function downsampleWaveform(target: Float32Array, bytes: Uint8Array): void {
  if (bytes.length === 0) {
    target.fill(0);
    return;
  }

  const bucket = bytes.length / target.length;
  for (let i = 0; i < target.length; i++) {
    const start = Math.floor(i * bucket);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucket));
    let extreme = 128;
    for (let j = start; j < Math.min(end, bytes.length); j++) {
      const sample = bytes[j] ?? 128;
      if (Math.abs(sample - 128) > Math.abs(extreme - 128)) extreme = sample;
    }
    target[i] = Math.max(-1, Math.min(1, (extreme - 128) / 127));
  }
}

/**
 * Decode a payload into `frame` in place. Returns false when the bands are
 * unusable (wrong size, corrupt base64), leaving the frame untouched so the
 * renderer keeps showing the last good state instead of flashing to zero.
 *
 * The waveforms are guarded on their own: usable bands with a corrupt waveform
 * still update the bars, and the previous trace is left in place rather than
 * being zero-filled.
 */
export function applyPayload(frame: SpectrumFrame, payload: SpectrumPayload): boolean {
  const bands = decodeBase64(payload.bands);
  const peaks = decodeBase64(payload.peaks);
  if (bands.length === 0 || bands.length !== peaks.length) return false;

  writeUnit(frame.bands, bands);
  writeUnit(frame.peaks, peaks);

  // A silent window still carries a full mid-scale buffer from the emitter, so
  // an empty decode here only ever means a corrupt payload. Keep the previous
  // trace instead: `writeSigned` would zero-fill it, flashing scope, radial and
  // stereo to a flat line while the bands beside them stay valid.
  const waveformLeft = decodeBase64(payload.waveformLeft);
  const waveformRight = decodeBase64(payload.waveformRight);
  if (waveformLeft.length > 0 && waveformRight.length > 0) {
    writeSigned(frame.waveformLeft, waveformLeft);
    writeSigned(frame.waveformRight, waveformRight);
    // Scope and radial modes use one trace. Select the louder whole-window
    // channel (left on ties) so legitimate side information cannot cancel out.
    writePhaseSafeMono(frame.waveform, frame.waveformLeft, frame.waveformRight);
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
  sampleRate: number,
  dtSeconds: number,
  responsiveness: number,
  envelope: SpectrumEnvelopeState,
): void {
  ensureEnvelopeSize(envelope, frame.bands.length);
  // AnalyserNode gives linearly-spaced bins over an explicitly configured
  // -60..0 dB range. Fold and tilt them exactly like the native analyser.
  foldLogBands(envelope.targetBands, freqBytes, sampleRate);

  const dt = Number.isFinite(dtSeconds) ? Math.max(0.001, Math.min(0.5, dtSeconds)) : 1 / 60;
  const profile = smoothingProfile(responsiveness);
  const attack = 1 - Math.exp(-dt / profile.attackTau);
  const decay = 1 - Math.exp(-dt / profile.decayTau);
  for (let i = 0; i < frame.bands.length; i++) {
    const target = envelope.targetBands[i] ?? 0;
    const current = frame.bands[i] ?? 0;
    const coefficient = target > current ? attack : decay;
    const next = current + (target - current) * coefficient;
    frame.bands[i] = Math.abs(next) < FRAME_SILENCE_EPSILON ? 0 : next;

    if (next >= (frame.peaks[i] ?? 0)) {
      frame.peaks[i] = next;
      envelope.peakHold[i] = profile.peakHold;
    } else if ((envelope.peakHold[i] ?? 0) > 0) {
      envelope.peakHold[i] = Math.max(0, (envelope.peakHold[i] ?? 0) - dt);
    } else {
      frame.peaks[i] = Math.max(next, (frame.peaks[i] ?? 0) - profile.peakFall * dt, 0);
    }
  }

  // A single AnalyserNode taps the summed output, so radio has no channel
  // separation to offer — both traces show the same signal.
  downsampleWaveform(frame.waveform, timeBytes);
  frame.waveformLeft.set(frame.waveform.subarray(0, frame.waveformLeft.length));
  frame.waveformRight.set(frame.waveform.subarray(0, frame.waveformRight.length));

  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < timeBytes.length; i++) {
    const v = Math.max(-1, Math.min(1, ((timeBytes[i] ?? 128) - 128) / 127));
    sumSq += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  frame.rms = timeBytes.length > 0 ? Math.sqrt(sumSq / timeBytes.length) : 0;
  frame.peak = peak;
  frame.sampleRate = sampleRate;
}

/**
 * Collapse linear FFT bins onto log-spaced bands, taking the peak of each
 * band's bins (matching `bands_from_magnitudes` on the Rust side).
 */
export function foldLogBands(
  out: Float32Array,
  bins: Uint8Array,
  sampleRate = 48_000,
): void {
  const n = out.length;
  if (n === 0) return;
  if (bins.length < 2) {
    out.fill(0);
    return;
  }

  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48_000;
  const fftSize = bins.length * 2;
  const binHz = rate / fftSize;
  const hiHz = Math.max(
    SPECTRUM_MIN_HZ * 4,
    Math.min(SPECTRUM_MAX_HZ, rate / 2 * 0.94),
  );
  const ratio = Math.log(hiHz / SPECTRUM_MIN_HZ) / n;

  for (let b = 0; b < n; b++) {
    const lowHz = SPECTRUM_MIN_HZ * Math.exp(ratio * b);
    const highHz = SPECTRUM_MIN_HZ * Math.exp(ratio * (b + 1));
    const first = Math.ceil(lowHz / binHz);
    const last = Math.ceil(highHz / binHz) - 1;
    const maxBin = bins.length - 1;
    let lo: number;
    let hi: number;
    if (first <= last && first <= maxBin) {
      lo = Math.max(first, 1);
      hi = Math.min(last, maxBin);
    } else {
      const nearest = Math.max(1, Math.min(maxBin, Math.round(Math.sqrt(lowHz * highHz) / binHz)));
      lo = nearest;
      hi = nearest;
    }
    let peakByte = 0;
    for (let i = lo; i <= hi; i++) peakByte = Math.max(peakByte, bins[i]!);

    const centreHz = Math.sqrt(lowHz * highHz);
    const tiltDb = Math.max(
      0,
      Math.min(TILT_MAX_DB, TILT_DB_PER_OCTAVE * Math.log2(centreHz / TILT_REF_HZ)),
    );
    // getByteFrequencyData maps minDecibels..maxDecibels linearly to 0..255.
    out[b] = peakByte === 0
      ? 0
      : Math.max(0, Math.min(1, peakByte / 255 + tiltDb / -SPECTRUM_FLOOR_DB));
  }
}

/**
 * Fade a stale display frame using elapsed time rather than display-frame count.
 * Returns true while any visible energy remains and another draw is useful.
 */
export function decayFrameToSilence(frame: SpectrumFrame, dtSeconds: number): boolean {
  const dt = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) : 0;
  const factor = Math.exp(-dt / IDLE_DECAY_TAU_SECONDS);
  let hasEnergy = false;

  const decay = (values: Float32Array): void => {
    for (let i = 0; i < values.length; i++) {
      const next = (values[i] ?? 0) * factor;
      if (Math.abs(next) <= FRAME_SILENCE_EPSILON) {
        values[i] = 0;
      } else {
        values[i] = next;
        hasEnergy = true;
      }
    }
  };

  decay(frame.bands);
  decay(frame.peaks);
  decay(frame.waveform);
  decay(frame.waveformLeft);
  decay(frame.waveformRight);
  frame.rms *= factor;
  frame.peak *= factor;
  if (frame.rms <= FRAME_SILENCE_EPSILON) frame.rms = 0;
  else hasEnergy = true;
  if (frame.peak <= FRAME_SILENCE_EPSILON) frame.peak = 0;
  else hasEnergy = true;
  return hasEnergy;
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
