import { loudnessCacheStateKeysForTrackId } from './loudnessGainCache';

/**
 * Bounded retry state for the per-track loudness backfill: each `refresh:miss`
 * for a track in loudness mode enqueues an `analysis_enqueue_seed_from_url`
 * job, but only if (a) no enqueue is already inflight for that id and
 * (b) the per-track attempt counter is below `MAX_BACKFILL_ATTEMPTS_PER_TRACK`.
 * A `refresh:hit` resets the counter so the next miss starts fresh.
 *
 * Both maps stay keyed by the raw track id passed by the caller — the
 * `loudnessCacheStateKeysForTrackId` expansion only matters when clearing
 * during a reseed (`resetLoudnessBackfillStateForTrackId`).
 */

export const MAX_BACKFILL_ATTEMPTS_PER_TRACK = 2;

const analysisBackfillInFlightByTrackId: Record<string, true> = {};
const analysisBackfillAttemptsByTrackId: Record<string, number> = {};

export function isBackfillInFlight(trackId: string): boolean {
  return Boolean(analysisBackfillInFlightByTrackId[trackId]);
}

export function getBackfillAttempts(trackId: string): number {
  return analysisBackfillAttemptsByTrackId[trackId] ?? 0;
}

/** Atomic: flag the track inflight AND bump the attempt counter to `nextAttempt`. */
export function markBackfillInFlight(trackId: string, nextAttempt: number): void {
  analysisBackfillInFlightByTrackId[trackId] = true;
  analysisBackfillAttemptsByTrackId[trackId] = nextAttempt;
}

/** Clear the inflight flag (called from the `.finally` of the enqueue promise). */
export function clearBackfillInFlight(trackId: string): void {
  delete analysisBackfillInFlightByTrackId[trackId];
}

/** Reset the attempt counter to 0 — called after a `refresh:hit`. */
export function resetBackfillAttempts(trackId: string): void {
  analysisBackfillAttemptsByTrackId[trackId] = 0;
}

/** Full reset for both maps across the bare + `stream:` id forms — used during a reseed. */
export function resetLoudnessBackfillStateForTrackId(trackId: string): void {
  for (const k of loudnessCacheStateKeysForTrackId(trackId)) {
    delete analysisBackfillInFlightByTrackId[k];
    analysisBackfillAttemptsByTrackId[k] = 0;
  }
}

/** Test-only: wipe both maps so each spec starts clean. */
export function _resetBackfillStateForTest(): void {
  for (const k of Object.keys(analysisBackfillInFlightByTrackId)) delete analysisBackfillInFlightByTrackId[k];
  for (const k of Object.keys(analysisBackfillAttemptsByTrackId)) delete analysisBackfillAttemptsByTrackId[k];
}
