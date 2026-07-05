import { useAuthStore } from '@/store/authStore';
import { autodjMaxOverlapCapSec } from '@/lib/audio/autodjOverlapCap';
import {
  analyzeBoundary,
  planCrossfadeTransition,
  STANDARD_BLEND_SEC,
  type CrossfadeTransitionPlan,
} from '@/lib/waveform/waveformSilence';
import { getTransitionMode } from '@/features/playback/utils/playback/playbackTransition';

/** Same trust threshold as end-of-track scenario A in `waveformSilence.ts`. */
const OWN_FADE_TRUST_SEC = 1.0;

/** Minimum audible tail on A required to attempt a manual blend. */
const MIN_A_REMAINING_SEC = 0.15;

/**
 * Manual skip is a deliberate "next track now" — cap how long loud A lingers over a
 * quiet B intro. End-of-track AutoDJ keeps content-driven spans; scenario A unchanged.
 */
const MANUAL_SKIP_MAX_BLEND_SEC = STANDARD_BLEND_SEC;

/**
 * True when switching to a different track while audio is already playing should
 * use the AutoDJ interrupt blend (same rules as manual skip). Excludes JS
 * auto-advance handoffs — those consume `armCrossfadeDynamicOverlap` instead.
 */
export function shouldAutodjInterruptBlend(
  wasPlaying: boolean,
  hasJsAutoHandoff = false,
): boolean {
  if (!wasPlaying || hasJsAutoHandoff) return false;
  const auth = useAuthStore.getState();
  return getTransitionMode(auth) === 'autodj'
    && auth.autodjSmoothSkip
    && !auth.gaplessEnabled;
}

/** @deprecated Use {@link shouldAutodjInterruptBlend} — manual flag is no longer required. */
export function shouldAutodjManualBlend(manual: boolean, wasPlaying: boolean): boolean {
  void manual;
  return shouldAutodjInterruptBlend(wasPlaying);
}

/**
 * Apply the same transition planning as end-of-track AutoDJ, but clamp the
 * overlap to the audible tail remaining on A from `skipFromTimeSec` (mid-track
 * skip). Non–scenario-A skips are capped to ~2 s so loud A does not linger over
 * a quiet B intro. Scenario A only applies when the skip lands inside A's outro fade zone.
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

  const base = planCrossfadeTransition(aBins, aDur, bBins, bDur, {
    maxOverlapSec: autodjMaxOverlapCapSec(useAuthStore.getState()),
  });
  if (!(base.overlapSec > 0)) return null;

  const maxCapSec = autodjMaxOverlapCapSec(useAuthStore.getState());

  const aShape = analyzeBoundary(aBins, aDur);
  const bShape = analyzeBoundary(bBins, bDur);
  const aRemaining = aShape.contentEndSec - Math.max(0, skipFromTimeSec);
  if (aRemaining < MIN_A_REMAINING_SEC) return null;

  let overlap = Math.max(0.5, Math.min(maxCapSec, base.overlapSec, aRemaining));
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
  if (!aRidesOwnFade && overlap > MANUAL_SKIP_MAX_BLEND_SEC) {
    overlap = MANUAL_SKIP_MAX_BLEND_SEC;
  }

  const outgoingFadeSec = aRidesOwnFade ? 0 : overlap;
  return {
    bStartSec: base.bStartSec,
    overlapSec: overlap,
    outgoingFadeSec,
  };
}
