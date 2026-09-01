import { describe, expect, it } from 'vitest';
import {
  completionPercent,
  listeningPersona,
  longestListeningStreak,
  losslessPercent,
  splitHoursMinutes,
} from './yearRecapDerive';

describe('longestListeningStreak', () => {
  it('returns 0 for no days and 1 for isolated days', () => {
    expect(longestListeningStreak([])).toBe(0);
    expect(longestListeningStreak(['2026-01-01', '2026-01-03', '2026-01-05'])).toBe(1);
  });

  it('finds the longest consecutive run regardless of input order', () => {
    expect(
      longestListeningStreak([
        '2026-03-04', '2026-03-02', '2026-03-03', // 3-day run
        '2026-03-10', '2026-03-11',               // 2-day run
      ]),
    ).toBe(3);
  });

  it('spans month boundaries and ignores duplicates', () => {
    expect(
      longestListeningStreak(['2026-01-31', '2026-02-01', '2026-02-01', '2026-02-02']),
    ).toBe(3);
  });
});

describe('listeningPersona', () => {
  const hours = (fill: Record<number, number>) =>
    Array.from({ length: 24 }, (_, h) => fill[h] ?? 0);

  it('returns null for a malformed or empty profile', () => {
    expect(listeningPersona([])).toBeNull();
    expect(listeningPersona(hours({}))).toBeNull();
  });

  it('picks the dominant window including the wrap-around night window', () => {
    expect(listeningPersona(hours({ 7: 10, 14: 3 }))).toBe('earlyBird');
    expect(listeningPersona(hours({ 13: 5 }))).toBe('daytime');
    expect(listeningPersona(hours({ 19: 5, 20: 5, 9: 4 }))).toBe('evening');
    expect(listeningPersona(hours({ 23: 4, 1: 4, 15: 6 }))).toBe('nightOwl');
  });
});

describe('percent helpers', () => {
  it('completionPercent handles empty and rounds', () => {
    expect(completionPercent(0, 0)).toBeNull();
    expect(completionPercent(2, 1)).toBe(67);
  });

  it('losslessPercent handles zero total and rounds', () => {
    expect(losslessPercent(10, 0)).toBeNull();
    expect(losslessPercent(900, 1400)).toBe(64);
  });
});

describe('splitHoursMinutes', () => {
  it('splits seconds and clamps negatives', () => {
    expect(splitHoursMinutes(0)).toEqual({ hours: 0, minutes: 0 });
    expect(splitHoursMinutes(3_660)).toEqual({ hours: 1, minutes: 1 });
    expect(splitHoursMinutes(-5)).toEqual({ hours: 0, minutes: 0 });
  });
});
