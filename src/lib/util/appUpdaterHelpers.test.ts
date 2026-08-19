import { describe, expect, it } from 'vitest';
import { isWithinModerationWindow, WINGET_MODERATION_DELAY_MS } from '@/lib/util/appUpdaterHelpers';

describe('isWithinModerationWindow', () => {
  const published = '2026-06-27T00:00:00Z';
  const publishedMs = Date.parse(published);

  it('returns true while the release is younger than the window', () => {
    const now = publishedMs + WINGET_MODERATION_DELAY_MS / 2; // halfway into the window
    expect(isWithinModerationWindow(published, now)).toBe(true);
  });

  it('returns false once the release is older than the window', () => {
    const now = publishedMs + WINGET_MODERATION_DELAY_MS + 1;
    expect(isWithinModerationWindow(published, now)).toBe(false);
  });

  it('returns false exactly at the window boundary', () => {
    const now = publishedMs + WINGET_MODERATION_DELAY_MS;
    expect(isWithinModerationWindow(published, now)).toBe(false);
  });

  it('respects a custom window override', () => {
    const now = publishedMs + 2 * 60 * 60 * 1000; // 2h after release
    expect(isWithinModerationWindow(published, now, 1 * 60 * 60 * 1000)).toBe(false);
    expect(isWithinModerationWindow(published, now, 3 * 60 * 60 * 1000)).toBe(true);
  });

  // Every other assertion is relative to the constant, so a slip such as
  // `6 * 60 * 1000` (six minutes) would disable the guard with a green suite.
  it('keeps the window within a plausible order of magnitude', () => {
    expect(WINGET_MODERATION_DELAY_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(WINGET_MODERATION_DELAY_MS).toBeLessThanOrEqual(48 * 60 * 60 * 1000);
  });

  it('fails open on a missing date', () => {
    expect(isWithinModerationWindow(undefined, publishedMs)).toBe(false);
  });

  it('fails open on an unparseable date', () => {
    expect(isWithinModerationWindow('not-a-date', publishedMs)).toBe(false);
  });
});
