import type { Track } from './playerStore';

/**
 * After a bulk enqueue (queue replace, append-many, lucky-mix) the runtime
 * warms the loudness cache for the current track + the next N entries so
 * the engine's `audio_chain_preload` sees a real cached gain instead of
 * the startup trim. These helpers compute that window — both as a
 * "does this id sit inside it?" predicate and as the explicit id list
 * the prefetch loop iterates over.
 *
 * Pure functions of the state slice — no store imports, no side effects.
 * The caller passes the queue + index + current track so the test surface
 * stays trivial and there's no top-level coupling back to playerStore.
 */
export const LOUDNESS_BACKFILL_WINDOW_AHEAD = 5;

export function isTrackInsideLoudnessBackfillWindow(
  trackId: string,
  queue: Track[],
  queueIndex: number,
  currentTrack: Track | null,
): boolean {
  if (!trackId) return false;
  if (currentTrack?.id === trackId) return true;
  if (queue.length === 0) return false;
  const start = Math.max(0, queueIndex + 1);
  const end = Math.min(queue.length, start + LOUDNESS_BACKFILL_WINDOW_AHEAD);
  for (let i = start; i < end; i++) {
    if (queue[i]?.id === trackId) return true;
  }
  return false;
}

export function collectLoudnessBackfillWindowTrackIds(
  queue: Track[],
  queueIndex: number,
  currentTrack: Track | null,
): string[] {
  const ids = new Set<string>();
  if (currentTrack?.id) ids.add(currentTrack.id);
  const start = Math.max(0, queueIndex + 1);
  const end = Math.min(queue.length, start + LOUDNESS_BACKFILL_WINDOW_AHEAD);
  for (let i = start; i < end; i++) {
    const tid = queue[i]?.id;
    if (tid) ids.add(tid);
  }
  return Array.from(ids);
}
