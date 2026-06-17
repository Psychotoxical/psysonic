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
import type { CrossfadeTransitionPlan } from '../utils/waveform/waveformSilence';

export type { CrossfadeTransitionPlan } from '../utils/waveform/waveformSilence';

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

/** Arm the overlap (seconds) JS just positioned for the incoming `trackId`. */
export function armCrossfadeDynamicOverlap(trackId: string, overlapSec: number): void {
  if (!trackId) return;
  armedOverlapTrackId = trackId;
  armedOverlapSec = Math.max(0, overlapSec);
}

/** Consume + clear the armed overlap for `trackId` (null when none/mismatched). */
export function consumeCrossfadeDynamicOverlap(trackId: string): number | null {
  if (!trackId || armedOverlapTrackId !== trackId) return null;
  const v = armedOverlapSec;
  armedOverlapTrackId = null;
  armedOverlapSec = 0;
  return v > 0 ? v : null;
}

/** Test/reset hook. */
export function _resetCrossfadeTrimCacheForTest(): void {
  planByTrackId.clear();
  plannedTrackIds.clear();
  armedOverlapTrackId = null;
  armedOverlapSec = 0;
}
