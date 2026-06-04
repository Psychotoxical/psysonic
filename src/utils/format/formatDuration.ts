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

/** Invisible same-width pad for fixed-length playbar clocks (no leading zeros). */
export const PLAYBAR_CLOCK_PAD = '\u2007';

/** Minute digit count for a fixed-width playbar clock derived from track duration. */
export function playbarMinuteFieldWidth(durationSeconds: number): number {
  if (!durationSeconds || !isFinite(durationSeconds) || durationSeconds <= 0) return 1;
  return Math.max(1, String(Math.floor(durationSeconds / 60)).length);
}

/**
 * Fixed-width `m:ss` for the player seekbar — minutes padded with figure spaces
 * so digit columns do not shift while the clock ticks (WebKit waveform resize).
 */
export function formatPlaybarClock(
  seconds: number,
  minuteFieldWidth: number,
  fallback = '0:00',
): string {
  if (!seconds || !isFinite(seconds) || seconds < 0) {
    if (fallback === '0:00') {
      return `${PLAYBAR_CLOCK_PAD.repeat(Math.max(0, minuteFieldWidth - 1))}0:00`;
    }
    return fallback;
  }
  const clamped = Math.max(0, seconds);
  const m = Math.floor(clamped / 60);
  const s = Math.floor(clamped % 60);
  return `${String(m).padStart(minuteFieldWidth, PLAYBAR_CLOCK_PAD)}:${s.toString().padStart(2, '0')}`;
}

/** Right-hand playbar toggle: `-m:ss` (remaining) or figure-space + `m:ss` (duration). */
export function formatPlaybarToggleClock(
  seconds: number,
  minuteFieldWidth: number,
  remaining: boolean,
): string {
  const body = formatPlaybarClock(seconds, minuteFieldWidth);
  return remaining ? `-${body}` : `${PLAYBAR_CLOCK_PAD}${body}`;
}
