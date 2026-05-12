import { describe, expect, it } from 'vitest';
import { coerceWaveformBins, waveformBlobLenOk } from './waveformParse';

describe('waveformBlobLenOk', () => {
  it('accepts the legacy single-curve length (500)', () => {
    expect(waveformBlobLenOk(500)).toBe(true);
  });

  it('accepts the v4 dual-curve length (1000)', () => {
    expect(waveformBlobLenOk(1000)).toBe(true);
  });

  it('rejects every other length', () => {
    expect(waveformBlobLenOk(0)).toBe(false);
    expect(waveformBlobLenOk(499)).toBe(false);
    expect(waveformBlobLenOk(501)).toBe(false);
    expect(waveformBlobLenOk(999)).toBe(false);
    expect(waveformBlobLenOk(1001)).toBe(false);
  });
});

describe('coerceWaveformBins', () => {
  it('passes a 500-length number[] through with byte-mask', () => {
    const input = new Array(500).fill(0).map((_, i) => i);
    const out = coerceWaveformBins(input);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(500);
    expect(out![0]).toBe(0);
    expect(out![255]).toBe(255);
    // index 256 wraps to 0 because of the & 255 mask
    expect(out![256]).toBe(0);
  });

  it('passes a 1000-length Uint8Array through unchanged', () => {
    const u8 = new Uint8Array(1000);
    u8[42] = 200;
    const out = coerceWaveformBins(u8);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(1000);
    expect(out![42]).toBe(200);
  });

  it('coerces a generic ArrayLike (Tauri serializes Vec<u8> as object)', () => {
    const arrayLike = { 0: 10, 1: 20, length: 500 } as ArrayLike<number>;
    // Fill remaining slots with zeros to match expected shape
    const proxy: ArrayLike<number> = {
      length: 500,
      ...Object.fromEntries(new Array(500).fill(0).map((_, i) => [i, i === 0 ? 10 : i === 1 ? 20 : 0])),
    } as ArrayLike<number>;
    const out = coerceWaveformBins(proxy);
    expect(out).not.toBeNull();
    expect(out![0]).toBe(10);
    expect(out![1]).toBe(20);
    expect(out![2]).toBe(0);
  });

  it('returns null for null / undefined', () => {
    expect(coerceWaveformBins(null)).toBeNull();
    expect(coerceWaveformBins(undefined)).toBeNull();
  });

  it('returns null for empty arrays', () => {
    expect(coerceWaveformBins([])).toBeNull();
    expect(coerceWaveformBins(new Uint8Array(0))).toBeNull();
    expect(coerceWaveformBins({ length: 0 })).toBeNull();
  });

  it('returns null when length is not 500 or 1000', () => {
    expect(coerceWaveformBins(new Array(750).fill(0))).toBeNull();
    expect(coerceWaveformBins(new Uint8Array(123))).toBeNull();
  });

  it('returns null for unsupported shapes (string, plain object without length)', () => {
    expect(coerceWaveformBins('hello')).toBeNull();
    expect(coerceWaveformBins({ a: 1 })).toBeNull();
    expect(coerceWaveformBins(42)).toBeNull();
  });
});
