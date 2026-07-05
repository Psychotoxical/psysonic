import { describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { setTransitionMode } from '@/features/playback/utils/playback/playbackTransition';
import { computeAutodjManualBlendPlan, shouldAutodjInterruptBlend } from '@/features/playback/utils/playback/autodjManualBlend';

/** Loud plateau with a short trailing silence (500 bins, 100 s). */
function loudTrackBins(trailQuietBins = 8): number[] {
  const bins = Array<number>(500).fill(200);
  for (let i = 0; i < trailQuietBins; i++) bins[499 - i] = 8;
  return bins;
}

/** Loud track with quiet head then plateau. */
function loudIntroBins(leadQuietBins = 6): number[] {
  const bins = Array<number>(500).fill(200);
  for (let i = 0; i < leadQuietBins; i++) bins[i] = 8;
  return bins;
}

describe('shouldAutodjInterruptBlend', () => {
  it('is true while playing even when manual flag would be false', () => {
    setTransitionMode('autodj');
    useAuthStore.setState({ autodjSmoothSkip: true, gaplessEnabled: false });
    expect(shouldAutodjInterruptBlend(true, false)).toBe(true);
  });

  it('is false when JS auto-advance armed the handoff', () => {
    setTransitionMode('autodj');
    useAuthStore.setState({ autodjSmoothSkip: true, gaplessEnabled: false });
    expect(shouldAutodjInterruptBlend(true, true)).toBe(false);
  });
});

describe('computeAutodjManualBlendPlan', () => {
  it('clamps overlap to remaining audible tail when skipping mid-track', () => {
    const aBins = loudTrackBins();
    const bBins = loudIntroBins();
    const plan = computeAutodjManualBlendPlan(aBins, 100, 95, bBins, 100);
    expect(plan).not.toBeNull();
    expect(plan!.overlapSec).toBeLessThanOrEqual(100 - 95 + 0.01);
    expect(plan!.overlapSec).toBeGreaterThanOrEqual(0.5);
    expect(plan!.bStartSec).toBeGreaterThan(0);
  });

  it('uses standard blend for hard loud→loud when enough tail remains', () => {
    const aBins = loudTrackBins(4);
    const bBins = loudIntroBins(4);
    const plan = computeAutodjManualBlendPlan(aBins, 100, 50, bBins, 100);
    expect(plan).not.toBeNull();
    expect(plan!.overlapSec).toBe(2);
    expect(plan!.outgoingFadeSec).toBe(2);
  });

  it('caps skip blend to 2s when B has a long quiet intro', () => {
    const aBins = loudTrackBins();
    const bBins = loudIntroBins(80);
    const plan = computeAutodjManualBlendPlan(aBins, 100, 40, bBins, 100);
    expect(plan).not.toBeNull();
    expect(plan!.overlapSec).toBe(2);
    expect(plan!.outgoingFadeSec).toBe(2);
  });

  it('returns null when almost no audible tail remains on A', () => {
    const aBins = loudTrackBins();
    const bBins = loudIntroBins();
    expect(computeAutodjManualBlendPlan(aBins, 100, 99.95, bBins, 100)).toBeNull();
  });
});
