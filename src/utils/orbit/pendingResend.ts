/**
 * Guest-side mitigation for the outbox lost-update race.
 *
 * A track a guest appends to its outbox can be wiped by a concurrent host
 * sweep-clear (`updatePlaylist(outbox, [], n)`) before the host actually
 * recorded it — the suggestion is lost AND stays stuck on "waiting on host"
 * forever, because the guest only clears it once it reaches the host's play
 * queue. The read-modify-write on a Subsonic playlist can't be made atomic, so
 * instead we recover:
 *
 *   - A pending suggestion the host has NOT recorded (absent from
 *     `state.queue`, the suggestion history every received submission lands in)
 *     past a grace window is re-sent. The host dedupes by (user, trackId), so
 *     re-sending is idempotent — a slow-but-not-lost suggestion just no-ops.
 *   - Past the give-up window it is dropped so the UI stops hanging (host gone,
 *     guest muted, or over the cap).
 *
 * Recorded-but-not-yet-merged suggestions (manual-approval mode) are left
 * alone — the host has them, they're legitimately waiting.
 */

/** ~3 host ticks: long enough that a normal-latency suggestion isn't re-sent. */
export const ORBIT_SUGGESTION_RESEND_GRACE_MS = 7_500;
/** Stop re-sending / waiting once a suggestion is this old and still unrecorded. */
export const ORBIT_SUGGESTION_GIVE_UP_MS = 45_000;

interface PendingMeta {
  addedAt: number;
  resends: number;
}

// Module-level so it survives guest-hook remounts within a single session.
const meta = new Map<string, PendingMeta>();

/** Start tracking a suggestion the moment it's submitted. Idempotent. */
export function notePendingSuggestion(trackId: string, now: number = Date.now()): void {
  if (!meta.has(trackId)) meta.set(trackId, { addedAt: now, resends: 0 });
}

/** Stop tracking a suggestion (it landed, was given up, or the user left). */
export function forgetPendingSuggestion(trackId: string): void {
  meta.delete(trackId);
}

/** Clear all tracking — call on leaving / ending a session. */
export function resetPendingResendState(): void {
  meta.clear();
}

/** Test-only: number of suggestions currently tracked. */
export function pendingResendTrackedCount(): number {
  return meta.size;
}

export interface PendingResendPlan {
  /** Re-append these to the outbox — the host hasn't recorded them yet. */
  resend: string[];
  /** Drop these from the pending UI — they never reached the host. */
  giveUp: string[];
}

/**
 * Decide which still-pending suggestions to re-send and which to give up on.
 * `recordedByHost` = trackIds in the host's `state.queue` (received, so not
 * lost — leave them alone even if not yet merged into the play queue).
 *
 * Mutates the internal retry bookkeeping; returns the actions for this tick.
 */
export function planPendingResends(
  pending: readonly string[],
  recordedByHost: ReadonlySet<string>,
  now: number = Date.now(),
): PendingResendPlan {
  const resend: string[] = [];
  const giveUp: string[] = [];
  for (const trackId of pending) {
    let m = meta.get(trackId);
    if (!m) {
      // First time we see it here (e.g. submitted before notePending ran) —
      // start the clock, act next tick.
      m = { addedAt: now, resends: 0 };
      meta.set(trackId, m);
      continue;
    }
    if (recordedByHost.has(trackId)) continue; // host has it — not lost
    const age = now - m.addedAt;
    if (age > ORBIT_SUGGESTION_GIVE_UP_MS) {
      giveUp.push(trackId);
      continue;
    }
    // One re-send per grace window, paced by how many we've already done.
    if (age > ORBIT_SUGGESTION_RESEND_GRACE_MS * (m.resends + 1)) {
      m.resends += 1;
      resend.push(trackId);
    }
  }
  return { resend, giveUp };
}
