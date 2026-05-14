/** Localized wall-clock `HH:MM` for a timestamp (sleep-timer / queue-ETA labels). */
export function formatClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
