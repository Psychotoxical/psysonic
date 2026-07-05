import { describe, expect, it } from 'vitest';
import { analyzeBoundary, computeWaveformSilence, planCrossfadeTransition } from '@/lib/waveform/waveformSilence';

/** Build a 500-bin peak curve: `lead` silent bins, a loud middle, `trail` silent bins. */
function curve(lead: number, mid: number, trail: number, loud = 200, quiet = 4): number[] {
  return [
    ...Array(lead).fill(quiet),
    ...Array(mid).fill(loud),
    ...Array(trail).fill(quiet),
  ];
}

/** Linear ramp of `n` values from `from`→`to` (inclusive), rounded to ints. */
function ramp(n: number, from: number, to: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.round(from + ((to - from) * i) / Math.max(1, n - 1)));
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

describe('analyzeBoundary', () => {
  it('reports ~0 rise/fade for a hard-cut, loud-throughout track', () => {
    const r = analyzeBoundary(Array(100).fill(200), 100); // 1 s/bin
    expect(r.introRiseSec).toBeCloseTo(0, 5);
    expect(r.outroFadeSec).toBeCloseTo(0, 5);
  });

  it('measures a long trailing fade-out', () => {
    // 80 loud bins + 20-bin decay to near-silence over 100 s (1 s/bin).
    const bins = [...Array(80).fill(200), ...ramp(20, 200, 20)];
    const r = analyzeBoundary(bins, 100);
    expect(r.outroFadeSec).toBeGreaterThan(2);
    expect(r.introRiseSec).toBeCloseTo(0, 5); // loud from the very start
  });

  it('measures a long quiet buildup intro', () => {
    const bins = [...ramp(20, 20, 200), ...Array(80).fill(200)];
    const r = analyzeBoundary(bins, 100);
    expect(r.introRiseSec).toBeGreaterThan(2);
    expect(r.outroFadeSec).toBeCloseTo(0, 5);
  });
});

describe('planCrossfadeTransition', () => {
  it('uses a standard ~2s blend for two hard-edged (loud) tracks', () => {
    // No fade-out, no buildup, but both edges known → standard blend (not a cut).
    const a = Array(100).fill(200);
    const b = Array(100).fill(200);
    const plan = planCrossfadeTransition(a, 100, b, 100);
    expect(plan.overlapSec).toBeCloseTo(2, 5);
    expect(plan.bStartSec).toBeCloseTo(0, 5);
    // A has no natural fade → engine supplies one (== the overlap).
    expect(plan.outgoingFadeSec).toBeCloseTo(2, 5);
  });

  it('uses a long, content-driven overlap when a fade-out meets a buildup', () => {
    const a = [...Array(80).fill(200), ...ramp(20, 200, 20)]; // fade-out tail
    const b = [...ramp(20, 20, 200), ...Array(80).fill(200)]; // quiet buildup head
    const plan = planCrossfadeTransition(a, 100, b, 100);
    // Spans the gentle regions — far longer than the hard-cut case, ≤ engine cap.
    expect(plan.overlapSec).toBeGreaterThan(3);
    expect(plan.overlapSec).toBeLessThanOrEqual(12);
  });

  it('extends the overlap to cover a long fade-out even against a hard start', () => {
    const a = [...Array(80).fill(200), ...ramp(20, 200, 20)]; // long fade-out
    const b = Array(100).fill(200); // hard, loud start
    const plan = planCrossfadeTransition(a, 100, b, 100);
    expect(plan.overlapSec).toBeGreaterThan(3);
  });

  it('lets A ride its own recorded fade-out (scenario A): no engine fade on A', () => {
    const a = [...Array(80).fill(200), ...ramp(20, 200, 20)]; // long fade-out tail
    const b = Array(100).fill(200); // hard, loud start (no buildup)
    const plan = planCrossfadeTransition(a, 100, b, 100);
    // A's own fade dominates → engine fade-out suppressed (0); B still fades in.
    expect(plan.outgoingFadeSec).toBe(0);
    expect(plan.overlapSec).toBeGreaterThan(3);
  });

  it('keeps an engine fade on A when A is a hard cut into a quiet buildup', () => {
    const a = Array(100).fill(200); // hard end, no fade
    const b = [...ramp(20, 20, 200), ...Array(80).fill(200)]; // long quiet buildup
    const plan = planCrossfadeTransition(a, 100, b, 100);
    // Overlap is driven by B's rise, A has no fade → engine must fade A.
    expect(plan.overlapSec).toBeGreaterThan(3);
    expect(plan.outgoingFadeSec).toBeCloseTo(plan.overlapSec, 5);
  });

  it('starts the incoming track past its leading silence', () => {
    const a = Array(100).fill(200);
    const b = [...Array(5).fill(4), ...Array(95).fill(200)]; // 5 s true silence, then loud
    const plan = planCrossfadeTransition(a, 100, b, 100);
    expect(plan.bStartSec).toBeGreaterThanOrEqual(5);
  });

  it('falls back to the minimum overlap when an envelope is missing', () => {
    const plan = planCrossfadeTransition(null, 100, Array(100).fill(200), 100);
    expect(plan.overlapSec).toBeCloseTo(0.5, 5);
    expect(plan.bStartSec).toBeCloseTo(0, 5);
  });
});
