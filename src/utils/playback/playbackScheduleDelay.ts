/** Browser `setTimeout` upper bound (~24.8 days). Larger values fire immediately. */
export const MAX_PLAYBACK_SCHEDULE_DELAY_MS = 2_147_483_647;

/** Largest custom delay (minutes) that fits in `MAX_PLAYBACK_SCHEDULE_DELAY_MS`. */
export const MAX_PLAYBACK_SCHEDULE_MINUTES = Math.floor(MAX_PLAYBACK_SCHEDULE_DELAY_MS / 60_000);

const MIN_PLAYBACK_SCHEDULE_DELAY_MS = 500;

/** Parse the modal's custom minutes field; rejects absurd values that break timers or Date preview. */
export function parsePlaybackDelayCustomMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number.parseFloat(trimmed.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > MAX_PLAYBACK_SCHEDULE_MINUTES) return null;
  return n;
}

/** Convert fractional minutes to whole seconds (minimum 1 s). */
export function scheduleSecondsFromCustomMinutes(minutes: number): number {
  return Math.max(1, Math.round(minutes * 60));
}

/** Clamp seconds to the same delay the store arms on `setTimeout`. */
export function scheduleDelayMsFromSeconds(seconds: number): number {
  const rawMs = Math.round(Number(seconds) * 1000);
  if (!Number.isFinite(rawMs) || rawMs <= 0) {
    return MIN_PLAYBACK_SCHEDULE_DELAY_MS;
  }
  return Math.min(
    MAX_PLAYBACK_SCHEDULE_DELAY_MS,
    Math.max(MIN_PLAYBACK_SCHEDULE_DELAY_MS, rawMs),
  );
}

export function scheduleDeadlineMs(startedAtMs: number, seconds: number): number {
  return startedAtMs + scheduleDelayMsFromSeconds(seconds);
}

export function isValidPlaybackSchedulePreviewTimestamp(atMs: number): boolean {
  return Number.isFinite(atMs) && atMs > 0 && atMs <= 8.64e15;
}
