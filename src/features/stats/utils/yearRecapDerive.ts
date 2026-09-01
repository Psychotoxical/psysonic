/**
 * Pure derivations for the year recap. Everything here is computed from data
 * the stats API already returns (recap aggregates, heatmap days, year summary)
 * so the story and the poster share one source of numbers.
 */

export type ListeningPersona = 'earlyBird' | 'daytime' | 'evening' | 'nightOwl';

/**
 * Longest run of consecutive calendar days with at least one play.
 * Accepts the heatmap's `YYYY-MM-DD` dates in any order.
 */
export function longestListeningStreak(dates: string[]): number {
  if (dates.length === 0) return 0;
  const days = [...new Set(dates)]
    .map(date => Date.parse(`${date}T12:00:00Z`))
    .filter(ms => Number.isFinite(ms))
    .sort((a, b) => a - b);
  if (days.length === 0) return 0;
  const dayMs = 24 * 60 * 60 * 1000;
  let longest = 1;
  let current = 1;
  for (let i = 1; i < days.length; i++) {
    if (Math.round((days[i] - days[i - 1]) / dayMs) === 1) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 1;
    }
  }
  return longest;
}

/**
 * Dominant listening window from the 24-slot hourly play profile.
 * Windows: earlyBird 5–10, daytime 11–16, evening 17–22, nightOwl 23–4.
 */
export function listeningPersona(hourlyPlayCounts: number[]): ListeningPersona | null {
  if (hourlyPlayCounts.length !== 24) return null;
  const sum = (hours: number[]) => hours.reduce((acc, h) => acc + (hourlyPlayCounts[h] ?? 0), 0);
  const windows: { persona: ListeningPersona; plays: number }[] = [
    { persona: 'earlyBird', plays: sum([5, 6, 7, 8, 9, 10]) },
    { persona: 'daytime', plays: sum([11, 12, 13, 14, 15, 16]) },
    { persona: 'evening', plays: sum([17, 18, 19, 20, 21, 22]) },
    { persona: 'nightOwl', plays: sum([23, 0, 1, 2, 3, 4]) },
  ];
  const total = windows.reduce((acc, w) => acc + w.plays, 0);
  if (total === 0) return null;
  // Stable on ties: the earlier window in the list wins.
  return windows.reduce((best, w) => (w.plays > best.plays ? w : best)).persona;
}

/**
 * The local-hour window behind each persona, for interpreted insight copy
 * ("most of your listening happens between {{from}} and {{to}}"). `to` is
 * exclusive so 17–22 reads as "between 17 and 23".
 */
export const PERSONA_WINDOWS: Record<ListeningPersona, { from: number; to: number }> = {
  earlyBird: { from: 5, to: 11 },
  daytime: { from: 11, to: 17 },
  evening: { from: 17, to: 23 },
  nightOwl: { from: 23, to: 5 },
};

/** Share of plays finished to completion, 0–100 (rounded). */
export function completionPercent(fullCount: number, partialCount: number): number | null {
  const total = fullCount + partialCount;
  if (total === 0) return null;
  return Math.round((fullCount / total) * 100);
}

/** Share of listening time spent on lossless containers, 0–100 (rounded). */
export function losslessPercent(losslessListenedSec: number, totalListenedSec: number): number | null {
  if (totalListenedSec <= 0) return null;
  return Math.round((losslessListenedSec / totalListenedSec) * 100);
}

/** `sec` as a compact `Nh` / `N h M min` style pair for big recap numbers. */
export function splitHoursMinutes(sec: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.floor(sec / 60));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
