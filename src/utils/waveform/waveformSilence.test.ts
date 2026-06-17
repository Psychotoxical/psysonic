import { describe, expect, it } from 'vitest';
import { computeWaveformSilence } from './waveformSilence';

/** Build a 500-bin peak curve: `lead` silent bins, a loud middle, `trail` silent bins. */
function curve(lead: number, mid: number, trail: number, loud = 200, quiet = 4): number[] {
  return [
    ...Array(lead).fill(quiet),
    ...Array(mid).fill(loud),
    ...Array(trail).fill(quiet),
  ];
}

describe('computeWaveformSilence', () => {
  it('returns no trim for null bins or invalid duration', () => {
    expect(computeWaveformSilence(null, 200)).toEqual({
      leadSilenceSec: 0, trailSilenceSec: 0, contentStartSec: 0, contentEndSec: 200,
    });
    expect(computeWaveformSilence([0, 200, 0], 0).contentEndSec).toBe(0);
    expect(computeWaveformSilence([0, 200, 0], NaN).contentEndSec).toBe(0);
  });

  it('does not trim a loud-throughout track', () => {
    const bins = Array(500).fill(180);
    const r = computeWaveformSilence(bins, 240);
    expect(r.leadSilenceSec).toBe(0);
    expect(r.trailSilenceSec).toBe(0);
    expect(r.contentStartSec).toBe(0);
    expect(r.contentEndSec).toBe(240);
  });

  it('trims leading and trailing silence and maps bins to seconds', () => {
    // 500 bins over 250 s → 0.5 s/bin. 20 lead silent bins = 10 s,
    // capped to 5 s; 10 trail silent bins = 5 s (exactly at cap).
    const bins = curve(20, 470, 10);
    const r = computeWaveformSilence(bins, 250);
    expect(r.leadSilenceSec).toBeCloseTo(5, 5);   // 10 s raw, capped to 5
    expect(r.trailSilenceSec).toBeCloseTo(5, 5);
    expect(r.contentStartSec).toBeCloseTo(5, 5);
    expect(r.contentEndSec).toBeCloseTo(245, 5);
  });

  it('maps small silences below the cap precisely', () => {
    // 100 bins over 100 s → 1 s/bin. 3 lead silent, 2 trail silent.
    const bins = curve(3, 95, 2);
    const r = computeWaveformSilence(bins, 100);
    expect(r.leadSilenceSec).toBeCloseTo(3, 5);
    expect(r.trailSilenceSec).toBeCloseTo(2, 5);
    expect(r.contentStartSec).toBeCloseTo(3, 5);
    expect(r.contentEndSec).toBeCloseTo(98, 5);
  });

  it('respects a custom cap', () => {
    const bins = curve(50, 400, 50); // 100 bins over 100 s → 50 s each side raw
    const r = computeWaveformSilence(bins, 100, { maxTrimSec: 8 });
    expect(r.leadSilenceSec).toBe(8);
    expect(r.trailSilenceSec).toBe(8);
  });

  it('never trims a fully-silent curve to nothing', () => {
    const bins = Array(500).fill(3);
    const r = computeWaveformSilence(bins, 120);
    expect(r.leadSilenceSec).toBe(0);
    expect(r.trailSilenceSec).toBe(0);
    expect(r.contentEndSec).toBe(120);
  });

  it('uses only the peak half of a dual-curve (1000-byte) payload', () => {
    // Peak half: 5 lead silent + loud. Mean half differs (all loud) — must be ignored.
    const peak = curve(5, 495, 0);
    const mean = Array(500).fill(150);
    const bins = [...peak, ...mean];
    const r = computeWaveformSilence(bins, 500); // 500 bins → 1 s/bin
    expect(r.leadSilenceSec).toBeCloseTo(5, 5);
    expect(r.trailSilenceSec).toBe(0);
  });

  it('honours a custom cut threshold', () => {
    // Intro bins at 30 are "loud" by default (cut 12) but silent at cut 40.
    const bins = [...Array(4).fill(30), ...Array(96).fill(200)];
    expect(computeWaveformSilence(bins, 100).leadSilenceSec).toBe(0);
    expect(computeWaveformSilence(bins, 100, { cut: 40 }).leadSilenceSec).toBeCloseTo(4, 5);
  });
});
