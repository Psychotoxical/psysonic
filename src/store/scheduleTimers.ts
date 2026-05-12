/**
 * Deferred pause / resume timers — back the `schedulePauseIn` /
 * `scheduleResumeIn` store actions. Encapsulated so the timer handles
 * never leak: every public API either schedules + auto-clears on fire,
 * or clears an outstanding timer outright. Cleared on stop, new track,
 * manual pause/resume.
 */

let scheduledPauseTimer: number | null = null;
let scheduledResumeTimer: number | null = null;

export function schedulePauseTimer(delayMs: number, onFire: () => void): void {
  clearScheduledPauseTimers();
  scheduledPauseTimer = window.setTimeout(() => {
    scheduledPauseTimer = null;
    onFire();
  }, delayMs) as unknown as number;
}

export function scheduleResumeTimer(delayMs: number, onFire: () => void): void {
  clearScheduledResumeTimers();
  scheduledResumeTimer = window.setTimeout(() => {
    scheduledResumeTimer = null;
    onFire();
  }, delayMs) as unknown as number;
}

export function clearScheduledPauseTimers(): void {
  if (scheduledPauseTimer != null) {
    window.clearTimeout(scheduledPauseTimer);
    scheduledPauseTimer = null;
  }
}

export function clearScheduledResumeTimers(): void {
  if (scheduledResumeTimer != null) {
    window.clearTimeout(scheduledResumeTimer);
    scheduledResumeTimer = null;
  }
}

export function clearAllPlaybackScheduleTimers(): void {
  clearScheduledPauseTimers();
  clearScheduledResumeTimers();
}

/** Test-only: clear both handles without invoking the timer callbacks. */
export function _resetScheduleTimersForTest(): void {
  clearAllPlaybackScheduleTimers();
}
