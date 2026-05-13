/**
 * Render a relative time string like "3 hours ago" / "in 2 weeks" with
 * the supplied locale. Navidrome returns `"0001-01-01T00:00:00Z"` for
 * never-accessed users — that round-trips to year 1, which `Date.parse`
 * turns into a wildly-negative epoch. We guard with a "is this after the
 * year 2001-ish" sanity check and fall back to the `neverLabel` so the
 * UI doesn't claim "2024 years ago".
 */
export function formatLastSeen(iso: string | null | undefined, locale: string, neverLabel: string): string {
  if (!iso) return neverLabel;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t < 1_000_000_000_000) return neverLabel;
  const diffSec = (t - Date.now()) / 1000;
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diffSec), 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 604800) return rtf.format(Math.round(diffSec / 86400), 'day');
  if (abs < 2592000) return rtf.format(Math.round(diffSec / 604800), 'week');
  if (abs < 31536000) return rtf.format(Math.round(diffSec / 2592000), 'month');
  return rtf.format(Math.round(diffSec / 31536000), 'year');
}
