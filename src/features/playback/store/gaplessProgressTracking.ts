/**
 * Last engine progress position for gapless rewind detection.
 * Kept separate from gaplessQueueAdvance to avoid seekAction → gaplessQueueAdvance
 * → playerStore → seekAction cycles.
 */

let lastEngineProgressSec = 0;

export function _resetGaplessProgressTrackingForTest(): void {
  lastEngineProgressSec = 0;
}

/** Clear stale position after a gapless or manual track switch. */
export function resetGaplessProgressTracking(): void {
  lastEngineProgressSec = 0;
}

export function getLastEngineProgressSec(): number {
  return lastEngineProgressSec;
}

export function noteEngineProgressForGapless(currentTime: number): void {
  lastEngineProgressSec = currentTime;
}
