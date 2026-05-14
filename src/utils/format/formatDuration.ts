/**
 * `m:ss` track time from a seconds value. Non-positive / non-finite input
 * returns `fallback` (default `'0:00'`; pass e.g. `'–'` for placeholder rows).
 */
export function formatTrackTime(seconds: number, fallback = '0:00'): string {
  if (!seconds || !isFinite(seconds) || seconds < 0) return fallback;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * `h:mm:ss` when the duration reaches an hour, otherwise `m:ss`. Used for
 * album / queue totals. Non-positive / non-finite input returns `'0:00'`.
 */
export function formatLongDuration(seconds: number): string {
  if (!seconds || !isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
