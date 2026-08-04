import { describe, expect, it } from 'vitest';
import {
  applyAnalyserData,
  createFrame,
  createSpectrumEnvelopeState,
  decayFrameToSilence,
  foldLogBands,
} from './spectrumFrame';

function applyRadio(
  frame: ReturnType<typeof createFrame>,
  freq: Uint8Array,
  time: Uint8Array,
  options: {
    sampleRate?: number;
    dt?: number;
    responsiveness?: number;
    envelope?: ReturnType<typeof createSpectrumEnvelopeState>;
  } = {},
): ReturnType<typeof createSpectrumEnvelopeState> {
  const envelope = options.envelope ?? createSpectrumEnvelopeState(frame.bands.length);
  applyAnalyserData(
    frame,
    freq,
    time,
    options.sampleRate ?? 48_000,
    options.dt ?? 1 / 60,
    options.responsiveness ?? 0.65,
    envelope,
  );
  return envelope;
}

describe('foldLogBands', () => {
  it('produces one value per output band', () => {
    const out = new Float32Array(64);
    foldLogBands(out, new Uint8Array(1024).fill(255));
    expect(out.length).toBe(64);
    expect(Array.from(out).every(v => v === 1)).toBe(true);
  });

  it('zeroes the output when there are no bins', () => {
    const out = new Float32Array(64).fill(1);
    foldLogBands(out, new Uint8Array(0));
    expect(Array.from(out).every(v => v === 0)).toBe(true);
  });

  it('keeps the peak of each band rather than the mean', () => {
    const bins = new Uint8Array(1024);
    bins[500] = 255;
    const out = new Float32Array(64);
    foldLogBands(out, bins);
    expect(Math.max(...out)).toBe(1);
  });

  it('maps analyser bytes over the configured -60..0 dB range', () => {
    const bins = new Uint8Array(1024);
    bins[Math.round(100 / (48_000 / 2048))] = 128;
    const out = new Float32Array(128);
    foldLogBands(out, bins, 48_000);
    expect(Math.max(...out)).toBeCloseTo(128 / 255, 5);
  });

  it.each([
    [44_100, [71]],
    [48_000, [72]],
    [96_000, [71]],
    [192_000, [72, 73]],
  ] as const)(
    'matches the native 1 kHz band membership at %i Hz',
    (sampleRate, expectedBands) => {
      const bins = new Uint8Array(1024);
      const binHz = sampleRate / 2048;
      const bin = Math.round(1_000 / binHz);
      bins[bin] = 255;
      const out = new Float32Array(128);
      foldLogBands(out, bins, sampleRate);

      const lit = Array.from(out, (value, index) => value > 0 ? index : -1)
        .filter(index => index >= 0);
      expect(lit).toEqual(expectedBands);
    },
  );

  it('does not fold frequencies above the 16 kHz display ceiling', () => {
    const bins = new Uint8Array(1024);
    bins[Math.round(20_000 / (48_000 / 2048))] = 255;
    const out = new Float32Array(128);
    foldLogBands(out, bins, 48_000);
    expect(Math.max(...out)).toBe(0);
  });

  it('maps low bins to low bands and skips DC', () => {
    const bins = new Uint8Array(1024);
    bins[2] = 255;
    const out = new Float32Array(64);
    foldLogBands(out, bins);
    const loudest = out.indexOf(Math.max(...out) as never);
    expect(loudest).toBeLessThan(16);

    bins.fill(0);
    bins[0] = 255;
    foldLogBands(out, bins);
    expect(Math.max(...out)).toBe(0);
  });

  it('handles an empty output array', () => {
    expect(() => foldLogBands(new Float32Array(0), new Uint8Array(64))).not.toThrow();
  });
});

describe('applyAnalyserData', () => {
  it('derives rms and peak from the full time-domain window', () => {
    const frame = createFrame();
    applyRadio(frame, new Uint8Array(1024), new Uint8Array(2048).fill(255));
    expect(frame.peak).toBeCloseTo(1, 2);
    expect(frame.rms).toBeCloseTo(1, 2);
  });

  it('reports silence for a centred trace', () => {
    const frame = createFrame();
    applyRadio(frame, new Uint8Array(1024), new Uint8Array(2048).fill(128));
    expect(frame.rms).toBe(0);
    expect(frame.peak).toBe(0);
  });

  it('keeps and then decays peak caps', () => {
    const frame = createFrame();
    const envelope = applyRadio(
      frame,
      new Uint8Array(1024).fill(255),
      new Uint8Array(2048).fill(128),
    );
    const held = frame.peaks[10]!;
    expect(held).toBeGreaterThanOrEqual(frame.bands[10]!);
    for (let i = 0; i < 2; i++) {
      applyRadio(frame, new Uint8Array(1024), new Uint8Array(2048).fill(128), {
        dt: 0.5,
        envelope,
      });
    }
    expect(frame.peaks[10]!).toBeLessThan(held);
  });

  it('downsamples the full analyser window instead of truncating its tail', () => {
    const frame = createFrame();
    const time = new Uint8Array(2048).fill(128);
    time[2047] = 255;
    applyRadio(frame, new Uint8Array(1024), time);
    expect(frame.waveform[frame.waveform.length - 1]).toBeCloseTo(1, 5);
    expect(frame.peak).toBeCloseTo(1, 5);
  });

  it('mirrors the mono trace onto both channels', () => {
    const frame = createFrame();
    applyRadio(frame, new Uint8Array(1024), new Uint8Array(2048).fill(255));
    expect(frame.waveformLeft[0]).toBeCloseTo(frame.waveform[0]!, 5);
    expect(frame.waveformRight[0]).toBeCloseTo(frame.waveform[0]!, 5);
  });

  it('keeps envelope decay independent of the selected update step', () => {
    const once = createFrame();
    const stepped = createFrame();
    const onceEnvelope = createSpectrumEnvelopeState();
    const steppedEnvelope = createSpectrumEnvelopeState();
    const loud = new Uint8Array(1024).fill(255);
    const silent = new Uint8Array(1024);
    const time = new Uint8Array(2048).fill(128);

    applyRadio(once, loud, time, { dt: 0.5, envelope: onceEnvelope });
    applyRadio(stepped, loud, time, { dt: 0.5, envelope: steppedEnvelope });
    applyRadio(once, silent, time, { dt: 0.12, envelope: onceEnvelope });
    for (let i = 0; i < 12; i++) {
      applyRadio(stepped, silent, time, { dt: 0.01, envelope: steppedEnvelope });
    }
    expect(once.bands[64]).toBeCloseTo(stepped.bands[64]!, 4);
  });

  it('retunes responsiveness without resetting the envelope', () => {
    const smooth = createFrame();
    const snappy = createFrame();
    const smoothEnvelope = createSpectrumEnvelopeState();
    const snappyEnvelope = createSpectrumEnvelopeState();
    const loud = new Uint8Array(1024).fill(255);
    const silent = new Uint8Array(1024);
    const time = new Uint8Array(2048).fill(128);

    applyRadio(smooth, loud, time, { dt: 0.5, responsiveness: 0, envelope: smoothEnvelope });
    applyRadio(snappy, loud, time, { dt: 0.5, responsiveness: 1, envelope: snappyEnvelope });
    applyRadio(smooth, silent, time, { dt: 0.05, responsiveness: 0, envelope: smoothEnvelope });
    applyRadio(snappy, silent, time, { dt: 0.05, responsiveness: 1, envelope: snappyEnvelope });
    expect(snappy.bands[64]).toBeLessThan(smooth.bands[64]!);
  });
});

describe('decayFrameToSilence', () => {
  it('fades by elapsed time rather than requestAnimationFrame count', () => {
    const once = createFrame();
    const stepped = createFrame();
    once.bands.fill(1);
    stepped.bands.fill(1);
    decayFrameToSilence(once, 0.1);
    for (let i = 0; i < 10; i++) decayFrameToSilence(stepped, 0.01);
    expect(once.bands[0]).toBeCloseTo(stepped.bands[0]!, 5);
  });
});
