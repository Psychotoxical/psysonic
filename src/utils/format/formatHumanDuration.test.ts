import { describe, it, expect, vi } from 'vitest';

// Echo the i18n key + params so the rounding/branching can be asserted
// without depending on a locale's exact "N hours M minutes" template.
vi.mock('../../i18n', () => ({
  default: {
    t: (key: string, params: Record<string, unknown>) => `${key}|${JSON.stringify(params)}`,
  },
}));

import { formatHumanHoursMinutes } from './formatHumanDuration';

describe('formatHumanHoursMinutes', () => {
  it('rounds to the nearest minute instead of truncating', () => {
    // 3 min 30 s → rounds up to 4 min
    expect(formatHumanHoursMinutes(210)).toBe('common.durationMinutesOnly|{"minutes":4}');
    // 3 min 29 s → rounds down to 3 min
    expect(formatHumanHoursMinutes(209)).toBe('common.durationMinutesOnly|{"minutes":3}');
  });

  it('rolls a near-hour total up into the hours branch', () => {
    // 59 min 30 s → rounds to 60 min → "1 h 0 m", not "59 m"
    expect(formatHumanHoursMinutes(3570)).toBe('common.durationHoursMinutes|{"hours":"1","minutes":0}');
  });

  it('formats hours plus minutes', () => {
    expect(formatHumanHoursMinutes(3 * 3600 + 25 * 60)).toBe(
      'common.durationHoursMinutes|{"hours":"3","minutes":25}',
    );
  });

  it('clamps negative input to zero', () => {
    expect(formatHumanHoursMinutes(-5)).toBe('common.durationMinutesOnly|{"minutes":0}');
  });
});
