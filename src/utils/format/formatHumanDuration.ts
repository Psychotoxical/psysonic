import i18n from '../../i18n';

/** Totals / statistics: localized "N hours M minutes" (not track mm:ss). */
export function formatHumanHoursMinutes(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) {
    return i18n.t('common.durationHoursMinutes', { hours: h.toLocaleString(), minutes: m });
  }
  return i18n.t('common.durationMinutesOnly', { minutes: m });
}
