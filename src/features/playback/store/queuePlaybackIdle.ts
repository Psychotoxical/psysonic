/** Timestamps and flags for idle auto-pull guards (play queue sync). */

let playbackIdleSinceMs = 0;
let lastQueueMutationAt = 0;
/** When true, idle auto-pull is disabled until manual pull re-enables it. */
let idleQueuePullSuspended = false;
/**
 * True when the last queue push to the server failed (offline / unreachable /
 * URI-too-long). Blocks idle auto-pull so a stale server snapshot cannot rewind
 * local playback, but is transient and self-clearing: any later successful push
 * (or a manual pull) clears it. Distinct from `idleQueuePullSuspended` — it does
 * NOT drive the handoff LED, so a single transient failure does not nag the user.
 */
let queuePushFailed = false;
/** Set when repeat-off playback reaches the queue tail — blocks idle pull until play resumes. */
let queueNaturallyEnded = false;
/** Bumped on each local queue mutation; stale in-flight idle pulls must not apply. */
let idlePullGeneration = 0;

const idlePullSuspensionListeners = new Set<() => void>();

function emitIdlePullSuspensionChange(): void {
  for (const listener of idlePullSuspensionListeners) {
    listener();
  }
}

export function subscribeIdleQueuePullSuspended(listener: () => void): () => void {
  idlePullSuspensionListeners.add(listener);
  return () => idlePullSuspensionListeners.delete(listener);
}

export function getIdleQueuePullSuspendedSnapshot(): boolean {
  return idleQueuePullSuspended;
}

export function markPlaybackIdle(): void {
  if (playbackIdleSinceMs === 0) playbackIdleSinceMs = Date.now();
}

export function markPlaybackActive(): void {
  playbackIdleSinceMs = 0;
  clearQueueNaturallyEnded();
}

export function markQueueNaturallyEnded(): void {
  queueNaturallyEnded = true;
}

export function clearQueueNaturallyEnded(): void {
  queueNaturallyEnded = false;
}

export function isQueueNaturallyEnded(): boolean {
  return queueNaturallyEnded;
}

export function getPlaybackIdleSinceMs(): number {
  return playbackIdleSinceMs;
}

export function isPlaybackIdleLongEnough(thresholdMs: number): boolean {
  return playbackIdleSinceMs > 0 && Date.now() - playbackIdleSinceMs >= thresholdMs;
}

export function suspendIdleQueuePull(): void {
  if (idleQueuePullSuspended) return;
  idleQueuePullSuspended = true;
  emitIdlePullSuspensionChange();
}

export function resumeIdleQueuePull(): void {
  if (!idleQueuePullSuspended) return;
  idleQueuePullSuspended = false;
  emitIdlePullSuspensionChange();
}

export function isIdleQueuePullSuspended(): boolean {
  return idleQueuePullSuspended;
}

/** Mark the last server push as failed (blocks idle pull until a push succeeds). */
export function markQueuePushFailed(): void {
  queuePushFailed = true;
}

/** Clear the failed-push guard — called on a successful push or a manual pull. */
export function clearQueuePushFailed(): void {
  queuePushFailed = false;
}

export function isQueuePushFailed(): boolean {
  return queuePushFailed;
}

export function getIdlePullGeneration(): number {
  return idlePullGeneration;
}

export function touchQueueMutationClock(): void {
  lastQueueMutationAt = Date.now();
  clearQueueNaturallyEnded();
  suspendIdleQueuePull();
  idlePullGeneration += 1;
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
  idleQueuePullSuspended = false;
  queuePushFailed = false;
  queueNaturallyEnded = false;
  idlePullGeneration = 0;
}
