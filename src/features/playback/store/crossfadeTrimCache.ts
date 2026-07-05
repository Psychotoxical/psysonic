/**
 * Silence-aware crossfade — tiny module cache bridging the pre-buffer stage and
 * `playTrack`. During the crossfade pre-buffer window (`crossfadePreload`) we
 * fetch the *next* track's cached waveform and, together with the current
 * track's envelope, derive a per-transition plan: where the incoming track
 * should begin (leading silence skipped) and the adaptive overlap length.
 * `playTrackAction` then reads it to pass `audio_play(start_secs, crossfade_secs_override)`,
 * and `audioEventHandlers` reads the overlap to re-anchor the early A-tail advance.
 *
 * Kept out of the persisted Zustand store on purpose: this is ephemeral,
 * per-transition playback data, not user state.
 */
import type { CrossfadeTransitionPlan } from '@/lib/waveform/waveformSilence';

export type { CrossfadeTransitionPlan } from '@/lib/waveform/waveformSilence';

/** trackId → planned transition for when this track starts under crossfade. */
const planByTrackId = new Map<string, CrossfadeTransitionPlan>();
/** trackIds we've already attempted a plan for (avoids per-tick refetch). */
const plannedTrackIds = new Set<string>();

// Bound both sets so a long session can't grow them without limit.
const MAX_ENTRIES = 32;

function trim(map: { delete: (k: string) => void; size: number; keys: () => IterableIterator<string> }): void {
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Record the computed transition plan for `trackId`. */
export function setCrossfadeTransition(trackId: string, plan: CrossfadeTransitionPlan): void {
  if (!trackId) return;
  planByTrackId.set(trackId, {
    bStartSec: Math.max(0, plan.bStartSec),
    overlapSec: Math.max(0, plan.overlapSec),
    outgoingFadeSec: Math.max(0, plan.outgoingFadeSec),
  });
  trim(planByTrackId);
}

/** Read the cached transition plan for `trackId` (null when none/unknown). */
export function getCrossfadeTransition(trackId: string): CrossfadeTransitionPlan | null {
  if (!trackId) return null;
  return planByTrackId.get(trackId) ?? null;
}

/** True once we've already attempted to plan a transition into `trackId`. */
export function hasPlannedCrossfade(trackId: string): boolean {
  return plannedTrackIds.has(trackId);
}

/** Mark `trackId` as planned so the pre-buffer loop doesn't refetch every tick. */
export function markPlannedCrossfade(trackId: string): void {
  if (!trackId) return;
  plannedTrackIds.add(trackId);
  trim(plannedTrackIds);
}

// ── One-shot dynamic-overlap hand-off (A-tail advance → playTrack) ──────────────
// When the JS early-advance fires it "arms" the content-driven overlap for the
// incoming track. `playTrack` consumes it to pass `crossfade_secs_override`, so the
// per-transition fade length is applied *only* when JS controlled the advance
// timing. Engine-driven advances (plain loud→loud endings) leave it unset and keep
// the normal crossfade length — avoids muting the outgoing track's tail.
let armedOverlapTrackId: string | null = null;
let armedOverlapSec = 0;
let armedOutgoingFadeSec = 0;

/** The fade lengths JS armed for one incoming transition. */
export interface ArmedCrossfadeOverlap {
  /** Track B's fade-in length (the overlap). */
  overlapSec: number;
  /** Track A's engine fade-out length (0 = A rides its own recorded fade). */
  outgoingFadeSec: number;
}

/**
 * Arm the content-driven fade lengths JS just positioned for the incoming
 * `trackId`: B's fade-in (`overlapSec`) and A's engine fade-out
 * (`outgoingFadeSec`; 0 ⇒ let A ride its own recorded fade — scenario A).
 */
export function armCrossfadeDynamicOverlap(
  trackId: string,
  overlapSec: number,
  outgoingFadeSec: number,
): void {
  if (!trackId) return;
  armedOverlapTrackId = trackId;
  armedOverlapSec = Math.max(0, overlapSec);
  armedOutgoingFadeSec = Math.max(0, outgoingFadeSec);
}

/** Consume + clear the armed fades for `trackId` (null when none/mismatched). */
export function consumeCrossfadeDynamicOverlap(trackId: string): ArmedCrossfadeOverlap | null {
  if (!trackId || armedOverlapTrackId !== trackId) return null;
  const overlapSec = armedOverlapSec;
  const outgoingFadeSec = armedOutgoingFadeSec;
  armedOverlapTrackId = null;
  armedOverlapSec = 0;
  armedOutgoingFadeSec = 0;
  return overlapSec > 0 ? { overlapSec, outgoingFadeSec } : null;
}

/** True when JS A-tail advance armed a handoff for `trackId` (peek only). */
export function peekArmedCrossfadeDynamicOverlap(trackId: string): boolean {
  return !!trackId && armedOverlapTrackId === trackId && armedOverlapSec > 0;
}

/** Test/reset hook. */
export function _resetCrossfadeTrimCacheForTest(): void {
  planByTrackId.clear();
  plannedTrackIds.clear();
  armedOverlapTrackId = null;
  armedOverlapSec = 0;
  armedOutgoingFadeSec = 0;
}
