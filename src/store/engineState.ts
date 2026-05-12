/**
 * Two pieces of state that coordinate the Rust audio engine from JS:
 *
 *  - **isAudioPaused** — true when the engine has a loaded-but-paused
 *    track. `resume()` reads this to decide between `audio_resume` (warm
 *    path, just unpause the existing Sink) and a cold restart via
 *    `audio_play + audio_seek`. Set true on every pause, false on every
 *    successful play / seek.
 *
 *  - **playGeneration** — monotonically increasing counter bumped at the
 *    start of every play attempt. Long-running `.then`/`.finally`
 *    callbacks capture their generation at start and compare against the
 *    current value before applying state changes; a mismatch means the
 *    user moved on and the callback should bail out without touching the
 *    store. Prevents stale callbacks from snapping playback back to a
 *    track the user already left.
 */

let isAudioPaused = false;
let playGeneration = 0;

export function getIsAudioPaused(): boolean {
  return isAudioPaused;
}

export function setIsAudioPaused(value: boolean): void {
  isAudioPaused = value;
}

export function getPlayGeneration(): number {
  return playGeneration;
}

/** Bump + return the new generation in one call (mirrors `++playGeneration`). */
export function bumpPlayGeneration(): number {
  return ++playGeneration;
}

/** Test-only: reset both fields so each spec starts from a clean slate. */
export function _resetEngineStateForTest(): void {
  isAudioPaused = false;
  playGeneration = 0;
}
