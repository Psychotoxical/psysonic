import {
  analysisTrackRefKey,
  type AnalysisTrackRef,
} from '@/features/playback/store/analysisTrackRef';

/**
 * Bounded retry state for the per-track loudness backfill: each `refresh:miss`
 * for a track in loudness mode enqueues an `analysis_enqueue_seed_from_url`
 * job, but only if (a) no enqueue is already inflight for that id and
 * (b) the per-track attempt counter is below `MAX_BACKFILL_ATTEMPTS_PER_TRACK`.
 * A `refresh:hit` resets the counter so the next miss starts fresh.
 *
 * Both maps use the owner-qualified analysis identity, including normalized
 * bare / `stream:` forms.
 */

export const MAX_BACKFILL_ATTEMPTS_PER_TRACK = 2;

const analysisBackfillInFlightByTrackId: Record<string, true> = {};
const analysisBackfillAttemptsByTrackId: Record<string, number> = {};

export function isBackfillInFlight(ref: AnalysisTrackRef): boolean {
  if (!ref.trackId || !ref.serverIndexKey) return false;
  return Boolean(analysisBackfillInFlightByTrackId[analysisTrackRefKey(ref)]);
}

export function getBackfillAttempts(ref: AnalysisTrackRef): number {
  if (!ref.trackId || !ref.serverIndexKey) return 0;
  return analysisBackfillAttemptsByTrackId[analysisTrackRefKey(ref)] ?? 0;
}

/** Atomic: flag the track inflight AND bump the attempt counter to `nextAttempt`. */
export function markBackfillInFlight(ref: AnalysisTrackRef, nextAttempt: number): void {
  if (!ref.trackId || !ref.serverIndexKey) return;
  const key = analysisTrackRefKey(ref);
  analysisBackfillInFlightByTrackId[key] = true;
  analysisBackfillAttemptsByTrackId[key] = nextAttempt;
}

/** Clear the inflight flag (called from the `.finally` of the enqueue promise). */
export function clearBackfillInFlight(ref: AnalysisTrackRef): void {
  if (!ref.trackId || !ref.serverIndexKey) return;
  delete analysisBackfillInFlightByTrackId[analysisTrackRefKey(ref)];
}

/** Reset the attempt counter to 0 — called after a `refresh:hit`. */
export function resetBackfillAttempts(ref: AnalysisTrackRef): void {
  if (!ref.trackId || !ref.serverIndexKey) return;
  analysisBackfillAttemptsByTrackId[analysisTrackRefKey(ref)] = 0;
}

/** Restore the previous count when Rust declines an enqueue without starting work. */
export function restoreBackfillAttempts(ref: AnalysisTrackRef, attempts: number): void {
  if (!ref.trackId || !ref.serverIndexKey) return;
  analysisBackfillAttemptsByTrackId[analysisTrackRefKey(ref)] = attempts;
}

export function resetLoudnessBackfillState(ref: AnalysisTrackRef): void {
  if (!ref.trackId || !ref.serverIndexKey) return;
  const key = analysisTrackRefKey(ref);
  delete analysisBackfillInFlightByTrackId[key];
  analysisBackfillAttemptsByTrackId[key] = 0;
}

/** Test-only: wipe both maps so each spec starts clean. */
export function _resetBackfillStateForTest(): void {
  for (const k of Object.keys(analysisBackfillInFlightByTrackId)) delete analysisBackfillInFlightByTrackId[k];
  for (const k of Object.keys(analysisBackfillAttemptsByTrackId)) delete analysisBackfillAttemptsByTrackId[k];
}
