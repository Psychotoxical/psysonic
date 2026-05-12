/**
 * Tracks the target time of the most recent user seek. The progress
 * handler reads this to suppress stale Rust progress ticks until the
 * engine has actually caught up to the new position — without the guard,
 * the slider snaps back briefly because Rust keeps emitting the old
 * position until the seek finishes propagating.
 *
 * Lifetime: set when a seek IPC is issued, cleared once progress reaches
 * within ~2 s of the target or when the guard timeout (5 s) elapses.
 */

export const SEEK_TARGET_GUARD_TIMEOUT_MS = 5000;

let seekTarget: number | null = null;
let seekTargetSetAt = 0;

export function setSeekTarget(seconds: number): void {
  seekTarget = seconds;
  seekTargetSetAt = Date.now();
}

export function clearSeekTarget(): void {
  seekTarget = null;
  seekTargetSetAt = 0;
}

export function getSeekTarget(): number | null {
  return seekTarget;
}

export function getSeekTargetSetAt(): number {
  return seekTargetSetAt;
}

/** Test-only: reset both mutables so each spec starts fresh. */
export function _resetSeekTargetStateForTest(): void {
  seekTarget = null;
  seekTargetSetAt = 0;
}
