import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '@/lib/format/relativeTime';

describe('formatRelativeTime', () => {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('picks the largest sensible unit for past dates (en)', () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * MINUTE), 'en')).toBe('5 minutes ago');
    expect(formatRelativeTime(new Date(Date.now() - 3 * HOUR), 'en')).toBe('3 hours ago');
    expect(formatRelativeTime(new Date(Date.now() - 3 * DAY), 'en')).toBe('3 days ago');
    expect(formatRelativeTime(new Date(Date.now() - 14 * DAY), 'en')).toBe('2 weeks ago');
  });

  it('handles future dates and respects the locale', () => {
    expect(formatRelativeTime(new Date(Date.now() + 2 * DAY), 'en')).toBe('in 2 days');
    expect(formatRelativeTime(new Date(Date.now() - 3 * DAY), 'de')).toBe('vor 3 Tagen');
  });
});
