import { describe, it, expect } from 'vitest';
import {
  formatTrackTime,
  formatLongDuration,
  formatPlaybarClock,
  formatPlaybarToggleClock,
  playbarMinuteFieldWidth,
  PLAYBAR_CLOCK_PAD,
} from './formatDuration';

describe('formatTrackTime', () => {
  it('formats m:ss with zero-padded seconds', () => {
    expect(formatTrackTime(5)).toBe('0:05');
    expect(formatTrackTime(65)).toBe('1:05');
    expect(formatTrackTime(599)).toBe('9:59');
  });

  it('does not roll minutes into hours (used for short track times)', () => {
    expect(formatTrackTime(3600)).toBe('60:00');
    expect(formatTrackTime(3661)).toBe('61:01');
  });

  it('floors fractional seconds', () => {
    expect(formatTrackTime(90.9)).toBe('1:30');
  });

  it('returns the fallback for zero / non-finite / negative input', () => {
    expect(formatTrackTime(0)).toBe('0:00');
    expect(formatTrackTime(NaN)).toBe('0:00');
    expect(formatTrackTime(Infinity)).toBe('0:00');
    expect(formatTrackTime(-5)).toBe('0:00');
    expect(formatTrackTime(undefined as unknown as number)).toBe('0:00');
  });

  it('honours a custom fallback', () => {
    expect(formatTrackTime(0, '–')).toBe('–');
    expect(formatTrackTime(NaN, '–')).toBe('–');
    expect(formatTrackTime(42, '–')).toBe('0:42');
  });
});

describe('formatLongDuration', () => {
  it('formats m:ss below one hour', () => {
    expect(formatLongDuration(5)).toBe('0:05');
    expect(formatLongDuration(125)).toBe('2:05');
    expect(formatLongDuration(3599)).toBe('59:59');
  });

  it('formats h:mm:ss at or above one hour', () => {
    expect(formatLongDuration(3600)).toBe('1:00:00');
    expect(formatLongDuration(3661)).toBe('1:01:01');
    expect(formatLongDuration(7325)).toBe('2:02:05');
  });

  it('returns 0:00 for zero / non-finite / negative input', () => {
    expect(formatLongDuration(0)).toBe('0:00');
    expect(formatLongDuration(NaN)).toBe('0:00');
    expect(formatLongDuration(-1)).toBe('0:00');
  });
});

describe('playbarMinuteFieldWidth', () => {
  it('matches the minute digit count of the track duration', () => {
    expect(playbarMinuteFieldWidth(65)).toBe(1);
    expect(playbarMinuteFieldWidth(599)).toBe(1);
    expect(playbarMinuteFieldWidth(600)).toBe(2);
    expect(playbarMinuteFieldWidth(3600)).toBe(2);
    expect(playbarMinuteFieldWidth(6000)).toBe(3);
  });

  it('returns 1 for invalid duration', () => {
    expect(playbarMinuteFieldWidth(0)).toBe(1);
    expect(playbarMinuteFieldWidth(NaN)).toBe(1);
  });
});

describe('formatPlaybarClock', () => {
  it('pads minutes with figure spaces to a fixed field width', () => {
    expect(formatPlaybarClock(65, 1)).toBe('1:05');
    expect(formatPlaybarClock(599, 2)).toBe(`${PLAYBAR_CLOCK_PAD}9:59`);
    expect(formatPlaybarClock(600, 2)).toBe('10:00');
  });

  it('keeps remaining/elapsed strings the same length while ticking', () => {
    expect(formatPlaybarClock(599, 2).length).toBe(formatPlaybarClock(600, 2).length);
    expect(formatPlaybarClock(59, 2).length).toBe(formatPlaybarClock(60, 2).length);
  });

  it('returns a padded zero clock for invalid input', () => {
    expect(formatPlaybarClock(0, 2)).toBe(`${PLAYBAR_CLOCK_PAD}0:00`);
    expect(formatPlaybarClock(NaN, 3)).toBe(`${PLAYBAR_CLOCK_PAD.repeat(2)}0:00`);
  });
});

describe('formatPlaybarToggleClock', () => {
  it('prefixes remaining with minus and duration with a figure space', () => {
    expect(formatPlaybarToggleClock(65, 1, true)).toBe('-1:05');
    expect(formatPlaybarToggleClock(65, 1, false)).toBe(`${PLAYBAR_CLOCK_PAD}1:05`);
    expect(formatPlaybarToggleClock(65, 1, true).length).toBe(formatPlaybarToggleClock(65, 1, false).length);
  });
});
