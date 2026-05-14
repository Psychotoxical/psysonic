import i18n from '../../i18n';

/**
 * Totals / statistics: localized "N hours M minutes" (not track mm:ss).
 *
 * Rounds to the nearest minute before splitting into hours/minutes — a 3:21:40
 * total reads as "3 h 22 m", and a 59:30 total rolls up to "1 h 0 m" rather
 * than truncating to "59 m". Negative input is clamped to zero.
 */
export function formatHumanHoursMinutes(seconds: number): string {
  const totalMin = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) {
    return i18n.t('common.durationHoursMinutes', { hours: h.toLocaleString(), minutes: m });
  }
  return i18n.t('common.durationMinutesOnly', { minutes: totalMin });
}
