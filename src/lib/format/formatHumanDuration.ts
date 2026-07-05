import i18n from '@/lib/i18n';

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

/** Player stats totals: compact days, hours, minutes (omit zero parts). */
export function formatPlayerStatsListeningTotal(seconds: number): string {
  const totalMin = Math.max(0, Math.round(seconds / 60));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(i18n.t('statistics.playerListeningDayShort', { count: days }));
  }
  if (hours > 0) {
    parts.push(i18n.t('statistics.playerListeningHourShort', { count: hours }));
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(i18n.t('statistics.playerListeningMinuteShort', { count: minutes }));
  }
  return parts.join(' ');
}

/** Per-track listened time in player stats drill-down. */
export function formatPlayerStatsListenedSec(seconds: number): string {
  const sec = Math.max(0, seconds);
  if (sec >= 60) {
    const minutes = (sec / 60).toLocaleString(i18n.resolvedLanguage ?? i18n.language, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    return i18n.t('statistics.playerListenedMinDecimal', { minutes });
  }
  return i18n.t('statistics.playerListenedSecShort', { seconds: Math.round(sec) });
}
