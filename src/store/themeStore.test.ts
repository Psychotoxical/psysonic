import { afterEach, describe, expect, it, vi } from 'vitest';

import { getScheduledTheme, useThemeStore } from './themeStore';

type SchedState = Parameters<typeof getScheduledTheme>[0];

function state(over: Partial<SchedState> = {}): SchedState {
  return {
    enableThemeScheduler: true,
    schedulerMode: 'time',
    theme: 'mocha',
    themeDay: 'latte',
    themeNight: 'mocha',
    timeDayStart: '07:00',
    timeNightStart: '19:00',
    ...over,
  };
}

/** Pin the wall clock to a fixed `HH:MM` for the time-mode cases. */
function atTime(hh: number, mm = 0): void {
  vi.useFakeTimers();
  const d = new Date(2026, 5, 23, hh, mm, 0);
  vi.setSystemTime(d);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('getScheduledTheme', () => {
  it('returns the plain theme when the scheduler is off', () => {
    expect(getScheduledTheme(state({ enableThemeScheduler: false }))).toBe('mocha');
  });

  describe('time mode', () => {
    it('picks the day theme during the day window', () => {
      atTime(12);
      expect(getScheduledTheme(state())).toBe('latte');
    });

    it('picks the night theme during the night window', () => {
      atTime(22);
      expect(getScheduledTheme(state())).toBe('mocha');
    });

    it('treats the day-start edge as day and the night-start edge as night', () => {
      atTime(7, 0);
      expect(getScheduledTheme(state())).toBe('latte');
      atTime(19, 0);
      expect(getScheduledTheme(state())).toBe('mocha');
    });

    it('handles a window that wraps past midnight (day 22:00 → 06:00)', () => {
      const s = state({ timeDayStart: '22:00', timeNightStart: '06:00' });
      atTime(23);
      expect(getScheduledTheme(s)).toBe('latte'); // inside the wrapped day window
      atTime(12);
      expect(getScheduledTheme(s)).toBe('mocha'); // outside → night
    });
  });

  describe('system mode', () => {
    it('follows the OS theme, ignoring the clock', () => {
      atTime(3); // would be night in time mode — must not matter here
      const s = state({ schedulerMode: 'system' });
      expect(getScheduledTheme(s, true)).toBe('mocha'); // dark → night theme
      expect(getScheduledTheme(s, false)).toBe('latte'); // light → day theme
    });

    it('defaults to the day theme when the system preference is unknown', () => {
      expect(getScheduledTheme(state({ schedulerMode: 'system' }))).toBe('latte');
    });

    it('still returns the plain theme when the scheduler is off', () => {
      expect(getScheduledTheme(state({ enableThemeScheduler: false, schedulerMode: 'system' }), true)).toBe('mocha');
    });
  });
});

describe('buttonSize', () => {
  afterEach(() => {
    useThemeStore.getState().setButtonSize('large');
  });

  it('defaults to large', () => {
    expect(useThemeStore.getState().buttonSize).toBe('large');
  });

  it('setButtonSize switches to small and back to large', () => {
    useThemeStore.getState().setButtonSize('small');
    expect(useThemeStore.getState().buttonSize).toBe('small');
    useThemeStore.getState().setButtonSize('large');
    expect(useThemeStore.getState().buttonSize).toBe('large');
  });
});
