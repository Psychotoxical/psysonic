export const PLAYER_STATS_RECENT_DAYS_LIMIT = 30;

export function localTodayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseLocalDate(dateIso: string): Date {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Human-readable day header for recent-days accordion. */
export function formatPlayerStatsDayLabel(
  dateIso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  locale?: string,
): string {
  const date = parseLocalDate(dateIso);
  const today = startOfLocalDay(new Date());
  const day = startOfLocalDay(date);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);

  if (diffDays === 0) return t('statistics.playerDayToday');
  if (diffDays === 1) return t('statistics.playerDayYesterday');

  const fmt = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
  });
  return fmt.format(date);
}
