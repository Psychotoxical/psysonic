import type { ClockFormat } from '@/store/authStoreTypes';

/**
 * Localized wall-clock `HH:MM` for a timestamp (sleep-timer / queue-ETA labels).
 * `clockFormat` overrides the locale's `hour12` default. `'auto'` (or omitted)
 * defers to `locale` — pass `i18n.language` so the App's UI language picks the
 * 12h/24h convention; the JS engine's default locale is unreliable inside
 * WebKitGTK and often resolves to `en-US` regardless of OS `LC_TIME`.
 */
export function formatClockTime(timestampMs: number, clockFormat?: ClockFormat, locale?: string): string {
  const hour12 = clockFormat === '24h' ? false : clockFormat === '12h' ? true : undefined;
  return new Date(timestampMs).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  });
}
