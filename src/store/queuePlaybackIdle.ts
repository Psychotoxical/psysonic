/** Timestamps for idle auto-pull guards (play queue sync). */

let playbackIdleSinceMs = 0;
let lastQueueMutationAt = 0;

export function markPlaybackIdle(): void {
  if (playbackIdleSinceMs === 0) playbackIdleSinceMs = Date.now();
}

export function markPlaybackActive(): void {
  playbackIdleSinceMs = 0;
}

export function getPlaybackIdleSinceMs(): number {
  return playbackIdleSinceMs;
}

export function isPlaybackIdleLongEnough(thresholdMs: number): boolean {
  return playbackIdleSinceMs > 0 && Date.now() - playbackIdleSinceMs >= thresholdMs;
}

export function touchQueueMutationClock(): void {
  lastQueueMutationAt = Date.now();
}

export function getLastQueueMutationAt(): number {
  return lastQueueMutationAt;
}

export function hasRecentQueueMutation(withinMs: number): boolean {
  return lastQueueMutationAt > 0 && Date.now() - lastQueueMutationAt < withinMs;
}

/** Test-only reset. */
export function _resetQueuePlaybackIdleForTest(): void {
  playbackIdleSinceMs = 0;
  lastQueueMutationAt = 0;
}
