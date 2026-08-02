import { describe, expect, it } from 'vitest';
import {
  applyAnalyserData,
  applyPayload,
  applySensitivity,
  clearFrame,
  copyFrame,
  createFrame,
  decodeBase64,
  foldLogBands,
  interpolateFrames,
  resizeFrame,
  type SpectrumPayload,
} from './spectrumFrame';

/** Base64 of `bytes`, so fixtures read as the values they represent. */
function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

function payload(over: Partial<SpectrumPayload> = {}): SpectrumPayload {
  return {
    bands: b64(new Array(64).fill(0)),
    peaks: b64(new Array(64).fill(0)),
    waveformLeft: b64(new Array(128).fill(128)),
    waveformRight: b64(new Array(128).fill(128)),
    rms: 0,
    peak: 0,
    bandCount: 64,
    waveCount: 128,
    sampleRate: 48_000,
    ...over,
  };
}

describe('decodeBase64', () => {
  it('decodes the standard vectors', () => {
    expect(Array.from(decodeBase64(btoa('foobar')))).toEqual([102, 111, 111, 98, 97, 114]);
  });

  it('returns empty for an empty string', () => {
    expect(decodeBase64('').length).toBe(0);
  });

  it('returns empty rather than throwing on malformed input', () => {
    expect(decodeBase64('!!!not base64!!!').length).toBe(0);
  });

  it('round-trips the full byte range', () => {
    const all = Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(decodeBase64(b64(all)))).toEqual(all);
  });
});

describe('applyPayload', () => {
  it('maps band bytes onto the 0..1 range', () => {
    const frame = createFrame();
    const bands = new Array(64).fill(0);
    bands[0] = 255;
    bands[1] = 128;
    expect(applyPayload(frame, payload({ bands: b64(bands), peaks: b64(bands) }))).toBe(true);
    expect(frame.bands[0]).toBe(1);
    expect(frame.bands[1]).toBeCloseTo(128 / 255, 5);
    expect(frame.bands[2]).toBe(0);
  });

  it('maps the waveform onto the signed range with 128 as zero', () => {
    const frame = createFrame();
    const wave = new Array(128).fill(128);
    wave[0] = 255;
    wave[1] = 1;
    applyPayload(frame, payload({ waveformLeft: b64(wave), waveformRight: b64(wave) }));
    expect(frame.waveform[0]).toBeCloseTo(1, 2);
    expect(frame.waveform[1]).toBeCloseTo(-1, 2);
    expect(frame.waveform[2]).toBe(0);
  });

  it('carries the scalar fields through', () => {
    const frame = createFrame();
    applyPayload(frame, payload({ rms: 0.4, peak: 0.9, sampleRate: 44_100 }));
    expect(frame.rms).toBe(0.4);
    expect(frame.peak).toBe(0.9);
    expect(frame.sampleRate).toBe(44_100);
  });

  it('rejects a payload whose band and peak arrays disagree', () => {
    const frame = createFrame();
    frame.bands[0] = 0.5;
    expect(applyPayload(frame, payload({ peaks: b64([1, 2, 3]) }))).toBe(false);
    // Frame must be left alone so the renderer keeps the last good state.
    expect(frame.bands[0]).toBe(0.5);
  });

  it('rejects an empty payload', () => {
    const frame = createFrame();
    expect(applyPayload(frame, payload({ bands: '', peaks: '' }))).toBe(false);
  });

  it('replaces non-finite scalars with zero', () => {
    const frame = createFrame();
    applyPayload(frame, payload({ rms: NaN, peak: Infinity }));
    expect(frame.rms).toBe(0);
    expect(frame.peak).toBe(0);
  });
});

describe('clearFrame', () => {
  it('zeroes everything', () => {
    const frame = createFrame();
    frame.bands.fill(1);
    frame.waveform.fill(1);
    frame.rms = 1;
    clearFrame(frame);
    expect(Array.from(frame.bands).every(v => v === 0)).toBe(true);
    expect(Array.from(frame.waveform).every(v => v === 0)).toBe(true);
    expect(frame.rms).toBe(0);
  });
});

describe('interpolateFrames', () => {
  it('returns the earlier frame at t=0 and the later at t=1', () => {
    const out = createFrame();
    const a = createFrame();
    const b = createFrame();
    a.bands[0] = 0.2;
    b.bands[0] = 0.8;

    interpolateFrames(out, a, b, 0);
    expect(out.bands[0]).toBeCloseTo(0.2, 5);
    interpolateFrames(out, a, b, 1);
    expect(out.bands[0]).toBeCloseTo(0.8, 5);
  });

  it('blends linearly in between', () => {
    const out = createFrame();
    const a = createFrame();
    const b = createFrame();
    a.bands[0] = 0;
    b.bands[0] = 1;
    interpolateFrames(out, a, b, 0.25);
    expect(out.bands[0]).toBeCloseTo(0.25, 5);
  });

  it('clamps t outside 0..1', () => {
    const out = createFrame();
    const a = createFrame();
    const b = createFrame();
    a.bands[0] = 0.1;
    b.bands[0] = 0.9;
    interpolateFrames(out, a, b, -5);
    expect(out.bands[0]).toBeCloseTo(0.1, 5);
    interpolateFrames(out, a, b, 5);
    expect(out.bands[0]).toBeCloseTo(0.9, 5);
  });

  it('takes the newer waveform outright instead of blending it', () => {
    const out = createFrame();
    const a = createFrame();
    const b = createFrame();
    a.waveform.fill(1);
    b.waveform.fill(-1);
    // Blending two unrelated time windows would cancel the trace to zero.
    interpolateFrames(out, a, b, 0.5);
    expect(out.waveform[0]).toBe(-1);
  });

  it('interpolates the scalar levels too', () => {
    const out = createFrame();
    const a = createFrame();
    const b = createFrame();
    a.rms = 0;
    b.rms = 1;
    interpolateFrames(out, a, b, 0.5);
    expect(out.rms).toBeCloseTo(0.5, 5);
  });
});

describe('applySensitivity', () => {
  it('is the identity at 1', () => {
    expect(applySensitivity(0.5, 1)).toBeCloseTo(0.5, 5);
  });

  it('pins the endpoints regardless of sensitivity', () => {
    for (const s of [0.6, 1, 2.4]) {
      expect(applySensitivity(0, s)).toBe(0);
      expect(applySensitivity(1, s)).toBe(1);
    }
  });

  it('lifts mid levels above 1 and compresses them below', () => {
    expect(applySensitivity(0.5, 2)).toBeGreaterThan(0.5);
    expect(applySensitivity(0.5, 0.6)).toBeLessThan(0.5);
  });

  it('is monotonic', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = applySensitivity(i / 20, 1.8);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('falls back to neutral for a nonsense sensitivity', () => {
    expect(applySensitivity(0.5, 0)).toBeCloseTo(0.5, 5);
    expect(applySensitivity(0.5, -3)).toBeCloseTo(0.5, 5);
  });
});

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
    // One hot bin surrounded by silence must still light its band fully.
    bins[900] = 255;
    const out = new Float32Array(64);
    foldLogBands(out, bins);
    expect(Math.max(...out)).toBe(1);
  });

  it('maps low bins to low bands', () => {
    const bins = new Uint8Array(1024);
    bins[2] = 255;
    const out = new Float32Array(64);
    foldLogBands(out, bins);
    const loudest = out.indexOf(Math.max(...out) as never);
    expect(loudest).toBeLessThan(16);
  });

  it('does not read DC', () => {
    const bins = new Uint8Array(1024);
    bins[0] = 255;
    const out = new Float32Array(64);
    foldLogBands(out, bins);
    expect(Math.max(...out)).toBe(0);
  });

  it('handles an empty output array', () => {
    expect(() => foldLogBands(new Float32Array(0), new Uint8Array(64))).not.toThrow();
  });
});

describe('applyAnalyserData', () => {
  it('derives rms and peak from the time-domain data', () => {
    const frame = createFrame();
    const freq = new Uint8Array(1024);
    // Sized from the frame: a short buffer leaves the tail zeroed and drags
    // the RMS down, which is a property of the fixture, not the code.
    const time = new Uint8Array(frame.waveform.length).fill(255);
    applyAnalyserData(frame, freq, time);
    expect(frame.peak).toBeCloseTo(1, 2);
    expect(frame.rms).toBeCloseTo(1, 2);
  });

  it('reports silence for a centred trace', () => {
    const frame = createFrame();
    applyAnalyserData(frame, new Uint8Array(1024), new Uint8Array(128).fill(128));
    expect(frame.rms).toBe(0);
    expect(frame.peak).toBe(0);
  });

  it('keeps peak caps at or above the live bands', () => {
    const frame = createFrame();
    applyAnalyserData(frame, new Uint8Array(1024).fill(255), new Uint8Array(128).fill(128));
    for (let i = 0; i < frame.bands.length; i++) {
      expect(frame.peaks[i]).toBeGreaterThanOrEqual(frame.bands[i]!);
    }
  });

  it('decays the caps once the signal drops', () => {
    const frame = createFrame();
    applyAnalyserData(frame, new Uint8Array(1024).fill(255), new Uint8Array(128).fill(128));
    const held = frame.peaks[10]!;
    applyAnalyserData(frame, new Uint8Array(1024), new Uint8Array(128).fill(128));
    expect(frame.peaks[10]!).toBeLessThan(held);
  });
});

describe('stereo waveforms', () => {
  it('keeps the channels separate', () => {
    const frame = createFrame();
    const left = new Array(128).fill(128);
    const right = new Array(128).fill(128);
    left[0] = 255;
    right[0] = 1;
    applyPayload(frame, payload({ waveformLeft: b64(left), waveformRight: b64(right) }));
    expect(frame.waveformLeft[0]).toBeCloseTo(1, 2);
    expect(frame.waveformRight[0]).toBeCloseTo(-1, 2);
  });

  it('derives the mono trace as the mean of the pair', () => {
    const frame = createFrame();
    const left = new Array(128).fill(128);
    const right = new Array(128).fill(128);
    left[0] = 255;   // +1
    right[0] = 128;  //  0
    applyPayload(frame, payload({ waveformLeft: b64(left), waveformRight: b64(right) }));
    expect(frame.waveform[0]).toBeCloseTo(0.5, 2);
  });

  it('cancels the mono trace for out-of-phase channels', () => {
    const frame = createFrame();
    const left = new Array(128).fill(255);
    const right = new Array(128).fill(1);
    applyPayload(frame, payload({ waveformLeft: b64(left), waveformRight: b64(right) }));
    expect(frame.waveform[0]).toBeCloseTo(0, 2);
    // ...but the channel traces still carry full signal, which is the point of
    // sending them separately.
    expect(Math.abs(frame.waveformLeft[0]!)).toBeCloseTo(1, 2);
    expect(Math.abs(frame.waveformRight[0]!)).toBeCloseTo(1, 2);
  });

  it('clears both channels', () => {
    const frame = createFrame();
    frame.waveformLeft.fill(1);
    frame.waveformRight.fill(1);
    clearFrame(frame);
    expect(Array.from(frame.waveformLeft).every(v => v === 0)).toBe(true);
    expect(Array.from(frame.waveformRight).every(v => v === 0)).toBe(true);
  });

  it('carries both channels through a copy', () => {
    const src = createFrame();
    src.waveformLeft.fill(0.5);
    src.waveformRight.fill(-0.5);
    const out = createFrame();
    copyFrame(out, src);
    expect(out.waveformLeft[0]).toBeCloseTo(0.5, 5);
    expect(out.waveformRight[0]).toBeCloseTo(-0.5, 5);
  });

  it('takes the newer channel traces when interpolating', () => {
    const out = createFrame();
    const a = createFrame();
    const b = createFrame();
    a.waveformLeft.fill(1);
    b.waveformLeft.fill(-1);
    interpolateFrames(out, a, b, 0.5);
    expect(out.waveformLeft[0]).toBe(-1);
  });

  it('mirrors the mono trace onto both channels for the radio feed', () => {
    // A single AnalyserNode taps the summed output — there is no separation to
    // report, and silently showing an empty right channel would be a lie.
    const frame = createFrame();
    const time = new Uint8Array(128).fill(255);
    applyAnalyserData(frame, new Uint8Array(1024), time);
    expect(frame.waveformLeft[0]).toBeCloseTo(frame.waveform[0]!, 5);
    expect(frame.waveformRight[0]).toBeCloseTo(frame.waveform[0]!, 5);
  });
});

describe('resizeFrame', () => {
  it('grows every array to the engine\'s counts', () => {
    const frame = createFrame(64, 128);
    resizeFrame(frame, 128, 256);
    expect(frame.bands).toHaveLength(128);
    expect(frame.peaks).toHaveLength(128);
    expect(frame.waveform).toHaveLength(256);
    expect(frame.waveformLeft).toHaveLength(256);
    expect(frame.waveformRight).toHaveLength(256);
  });

  it('shrinks as well as grows', () => {
    const frame = createFrame(128, 256);
    resizeFrame(frame, 32, 64);
    expect(frame.bands).toHaveLength(32);
    expect(frame.waveform).toHaveLength(64);
  });

  it('is a no-op when the counts already match', () => {
    const frame = createFrame(64, 128);
    const bands = frame.bands;
    resizeFrame(frame, 64, 128);
    expect(frame.bands).toBe(bands);
  });

  it('clamps absurd counts rather than allocating unbounded arrays', () => {
    const frame = createFrame(64, 128);
    resizeFrame(frame, 10_000_000, 10_000_000);
    expect(frame.bands.length).toBeLessThanOrEqual(4096);
    expect(frame.waveform.length).toBeLessThanOrEqual(4096);
  });

  it('ignores non-numeric counts', () => {
    const frame = createFrame(64, 128);
    resizeFrame(frame, NaN, NaN);
    expect(frame.bands).toHaveLength(64);
    expect(frame.waveform).toHaveLength(128);
  });
});

describe('payload counts drive the frame size', () => {
  it('keeps every band the engine sends instead of truncating', () => {
    // Raising BAND_COUNT in Rust used to cut the spectrum off mid-range: the
    // frontend allocated 64 and `Math.min` silently dropped the rest, so the
    // top half of the spectrum never reached the screen.
    const frame = createFrame(64, 128);
    const bands = new Array(128).fill(0);
    bands[127] = 255; // the very top band
    const wave = new Array(256).fill(128);

    resizeFrame(frame, 128, 256);
    applyPayload(frame, {
      ...payload(),
      bands: b64(bands),
      peaks: b64(bands),
      waveformLeft: b64(wave),
      waveformRight: b64(wave),
      bandCount: 128,
      waveCount: 256,
    });

    expect(frame.bands).toHaveLength(128);
    expect(frame.bands[127]).toBe(1);
  });

  it('keeps the whole waveform window, not just its first half', () => {
    const frame = createFrame(64, 128);
    const wave = new Array(256).fill(128);
    wave[255] = 255; // newest end of the window
    const bands = new Array(128).fill(0);

    resizeFrame(frame, 128, 256);
    applyPayload(frame, {
      ...payload(),
      bands: b64(bands),
      peaks: b64(bands),
      waveformLeft: b64(wave),
      waveformRight: b64(wave),
      bandCount: 128,
      waveCount: 256,
    });

    // Truncation dropped the newer half of the window, which also added the
    // dropped span's worth of latency to the scope.
    expect(frame.waveformLeft[255]).toBeCloseTo(1, 2);
  });
});
