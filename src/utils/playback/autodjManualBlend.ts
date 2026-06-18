import { useAuthStore } from '../../store/authStore';
import {
  analyzeBoundary,
  planCrossfadeTransition,
  STANDARD_BLEND_SEC,
  type CrossfadeTransitionPlan,
} from '../waveform/waveformSilence';
import { getTransitionMode } from './playbackTransition';

/** Same trust threshold as end-of-track scenario A in `waveformSilence.ts`. */
const OWN_FADE_TRUST_SEC = 1.0;

/** Minimum audible tail on A required to attempt a manual blend. */
const MIN_A_REMAINING_SEC = 0.15;

/**
 * True when a user-initiated skip should run the full AutoDJ crossfade rules
 * (overlap, B-head trim, scenario A) from the current playback position.
 */
export function shouldAutodjManualBlend(manual: boolean, wasPlaying: boolean): boolean {
  if (!manual || !wasPlaying) return false;
  const auth = useAuthStore.getState();
  return getTransitionMode(auth) === 'autodj'
    && auth.autodjSmoothSkip
    && !auth.gaplessEnabled;
}

/**
 * Apply the same transition planning as end-of-track AutoDJ, but clamp the
 * overlap to the audible tail remaining on A from `skipFromTimeSec` (mid-track
 * skip). Scenario A only applies when the skip lands inside A's outro fade zone.
 */
export function computeAutodjManualBlendPlan(
  aBins: number[] | null | undefined,
  aDurationSec: number,
  skipFromTimeSec: number,
  bBins: number[] | null | undefined,
  bDurationSec: number,
): CrossfadeTransitionPlan | null {
  const aDur = Number.isFinite(aDurationSec) && aDurationSec > 0 ? aDurationSec : 0;
  const bDur = Number.isFinite(bDurationSec) && bDurationSec > 0 ? bDurationSec : 0;
  if (aDur <= 0 || bDur <= 0) return null;

  const base = planCrossfadeTransition(aBins, aDur, bBins, bDur);
  if (!(base.overlapSec > 0)) return null;

  const aShape = analyzeBoundary(aBins, aDur);
  const bShape = analyzeBoundary(bBins, bDur);
  const aRemaining = aShape.contentEndSec - Math.max(0, skipFromTimeSec);
  if (aRemaining < MIN_A_REMAINING_SEC) return null;

  let overlap = Math.max(0.5, Math.min(12, base.overlapSec, aRemaining));
  const bPlayable = Math.max(0, bShape.contentEndSec - base.bStartSec);
  if (bPlayable > 0) overlap = Math.min(overlap, bPlayable * 0.9);

  const inOutroZone =
    skipFromTimeSec >= aShape.contentEndSec - Math.max(aShape.outroFadeSec, 0.5);
  const aRidesOwnFade = inOutroZone
    && aShape.outroFadeSec >= OWN_FADE_TRUST_SEC
    && aShape.outroFadeSec >= bShape.introRiseSec;
  if (!aRidesOwnFade && overlap < STANDARD_BLEND_SEC) {
    overlap = Math.min(STANDARD_BLEND_SEC, aRemaining, bPlayable > 0 ? bPlayable * 0.9 : STANDARD_BLEND_SEC);
  }

  const outgoingFadeSec = aRidesOwnFade ? 0 : overlap;
  return {
    bStartSec: base.bStartSec,
    overlapSec: overlap,
    outgoingFadeSec,
  };
}
