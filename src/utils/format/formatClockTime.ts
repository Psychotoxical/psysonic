import type { ClockFormat } from '../../store/authStoreTypes';

/**
 * Localized wall-clock `HH:MM` for a timestamp (sleep-timer / queue-ETA labels).
 * `clockFormat` overrides the system locale's `hour12` default — pass `'auto'`
 * or omit to keep locale-driven behaviour.
 */
export function formatClockTime(timestampMs: number, clockFormat?: ClockFormat): string {
  const hour12 = clockFormat === '24h' ? false : clockFormat === '12h' ? true : undefined;
  return new Date(timestampMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  });
}
