import { setRating, star, unstar } from '../api/subsonicStarRating';
import { usePlayerStore } from './playerStore';
import { patchCachedTrack } from '../utils/library/queueTrackResolver';

/**
 * F4 — pending-sync for **song** star + rating (spec §6.5 / R7-18).
 *
 * The player-store override maps (`starredOverrides` / `userRatingOverrides`)
 * are *session-only outbound sync state*, not a permanent second source of
 * truth:
 *
 * 1. Set the override optimistically (instant UI).
 * 2. Retry the Subsonic API (`star` / `unstar` / `setRating`) with exponential
 *    backoff; flush immediately on `online` / window focus.
 * 3. On success: clear the override and patch the in-memory `Track`
 *    (`currentTrack` + `queue`) so the UI stays correct without the override.
 *    The F3 index patch-on-use runs inside the API layer, unchanged.
 * 4. On app restart before success: the pending change is lost — acceptable,
 *    overrides are not persisted.
 *
 * **No rollback on the first network error** (this replaces the per-component
 * star rollback). v1 routes **songs only**; album/artist stay on their existing
 * paths.
 */

type Task =
  | { kind: 'star'; id: string; starred: boolean }
  | { kind: 'rating'; id: string; rating: number };

const pending = new Map<string, Task>(); // key `${kind}:${id}` — latest wins
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const attempts = new Map<string, number>();
const MAX_BACKOFF_MS = 30_000;
let listenersArmed = false;

const keyOf = (t: Task) => `${t.kind}:${t.id}`;

function armListeners(): void {
  if (listenersArmed || typeof window === 'undefined') return;
  listenersArmed = true;
  const flushAll = () => {
    for (const k of pending.keys()) schedule(k, 0);
  };
  window.addEventListener('online', flushAll);
  window.addEventListener('focus', flushAll);
}

function schedule(k: string, delayMs: number): void {
  const existing = timers.get(k);
  if (existing) clearTimeout(existing);
  timers.set(
    k,
    setTimeout(() => {
      void run(k);
    }, delayMs),
  );
}

async function run(k: string): Promise<void> {
  timers.delete(k);
  const task = pending.get(k);
  if (!task) return;
  try {
    if (task.kind === 'star') {
      if (task.starred) await star(task.id, 'song');
      else await unstar(task.id, 'song');
      onStarSuccess(task.id, task.starred);
    } else {
      await setRating(task.id, task.rating);
      onRatingSuccess(task.id);
    }
    // Only retire the entry if a newer toggle hasn't superseded it mid-flight.
    if (pending.get(k) === task) {
      pending.delete(k);
      attempts.delete(k);
    }
  } catch {
    if (pending.get(k) !== task) return; // superseded — the newer task self-schedules
    const n = (attempts.get(k) ?? 0) + 1;
    attempts.set(k, n);
    schedule(k, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (n - 1)));
  }
}

function onStarSuccess(id: string, starred: boolean): void {
  const starredVal = starred ? new Date().toISOString() : undefined;
  usePlayerStore.setState(s => {
    if (!(id in s.starredOverrides)) return {};
    const next = { ...s.starredOverrides };
    delete next[id];
    return {
      starredOverrides: next,
      currentTrack:
        s.currentTrack?.id === id ? { ...s.currentTrack, starred: starredVal } : s.currentTrack,
    };
  });
  // Thin-state: the queue's copy lives in the resolver cache. Patch it in place
  // to the synced value rather than dropping it — a dropped entry would blank the
  // visible queue row to a "…" placeholder until the next window re-resolve.
  patchCachedTrack(id, { starred: starredVal });
}

function onRatingSuccess(id: string): void {
  const rating = usePlayerStore.getState().userRatingOverrides[id];
  usePlayerStore.setState(s => {
    if (!(id in s.userRatingOverrides)) return {};
    const next = { ...s.userRatingOverrides };
    delete next[id];
    return { userRatingOverrides: next };
  });
  // Patch the cached queue track in place (see onStarSuccess) so the row keeps
  // its title and shows the synced rating without flashing a placeholder.
  if (rating !== undefined) patchCachedTrack(id, { userRating: rating });
}

/** Optimistically (un)star a song and sync it to the server with retry. */
export function queueSongStar(id: string, starred: boolean): void {
  usePlayerStore.getState().setStarredOverride(id, starred);
  const t: Task = { kind: 'star', id, starred };
  const k = keyOf(t);
  pending.set(k, t);
  attempts.delete(k);
  armListeners();
  schedule(k, 0);
}

/** Optimistically rate a song and sync it to the server with retry. */
export function queueSongRating(id: string, rating: number): void {
  usePlayerStore.getState().setUserRatingOverride(id, rating);
  const t: Task = { kind: 'rating', id, rating };
  const k = keyOf(t);
  pending.set(k, t);
  attempts.delete(k);
  armListeners();
  schedule(k, 0);
}

/** Test-only: clear all pending state + timers. */
export function _resetPendingStarSyncForTest(): void {
  pending.clear();
  attempts.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
