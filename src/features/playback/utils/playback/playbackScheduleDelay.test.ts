import { describe, expect, it } from 'vitest';
import {
  MAX_PLAYBACK_SCHEDULE_DELAY_MS,
  MAX_PLAYBACK_SCHEDULE_MINUTES,
  isValidPlaybackSchedulePreviewTimestamp,
  parsePlaybackDelayCustomMinutes,
  scheduleDeadlineMs,
  scheduleDelayMsFromSeconds,
  scheduleSecondsFromCustomMinutes,
} from '@/features/playback/utils/playback/playbackScheduleDelay';

describe('parsePlaybackDelayCustomMinutes', () => {
  it('accepts fractional minutes', () => {
    expect(parsePlaybackDelayCustomMinutes('0.1')).toBe(0.1);
    expect(parsePlaybackDelayCustomMinutes('0,01')).toBe(0.01);
  });

  it('rejects empty, zero, and non-numeric input', () => {
    expect(parsePlaybackDelayCustomMinutes('')).toBeNull();
    expect(parsePlaybackDelayCustomMinutes('0')).toBeNull();
    expect(parsePlaybackDelayCustomMinutes('abc')).toBeNull();
  });

  it('rejects values above the setTimeout-safe minute cap', () => {
    expect(parsePlaybackDelayCustomMinutes('99999999999')).toBeNull();
    expect(parsePlaybackDelayCustomMinutes(String(MAX_PLAYBACK_SCHEDULE_MINUTES + 1))).toBeNull();
  });
});

describe('scheduleSecondsFromCustomMinutes', () => {
  it('rounds fractional minutes to whole seconds', () => {
    expect(scheduleSecondsFromCustomMinutes(0.1)).toBe(6);
    expect(scheduleSecondsFromCustomMinutes(0.01)).toBe(1);
  });

  it('never returns zero', () => {
    expect(scheduleSecondsFromCustomMinutes(0.001)).toBe(1);
  });
});

describe('scheduleDelayMsFromSeconds', () => {
  it('enforces the minimum delay and caps at the browser limit', () => {
    expect(scheduleDelayMsFromSeconds(0)).toBe(500);
    expect(scheduleDelayMsFromSeconds(6)).toBe(6000);
    expect(scheduleDelayMsFromSeconds(MAX_PLAYBACK_SCHEDULE_DELAY_MS / 1000)).toBe(
      MAX_PLAYBACK_SCHEDULE_DELAY_MS,
    );
  });
});

describe('scheduleDeadlineMs', () => {
  it('uses the same clamped delay as the armed timer', () => {
    const startedAt = 1_700_000_000_000;
    expect(scheduleDeadlineMs(startedAt, 6)).toBe(startedAt + 6000);
    expect(scheduleDeadlineMs(startedAt, scheduleSecondsFromCustomMinutes(0.01))).toBe(startedAt + 1000);
  });
});

describe('isValidPlaybackSchedulePreviewTimestamp', () => {
  it('accepts ordinary future timestamps and rejects invalid ones', () => {
    expect(isValidPlaybackSchedulePreviewTimestamp(Date.now() + 60_000)).toBe(true);
    expect(isValidPlaybackSchedulePreviewTimestamp(Number.NaN)).toBe(false);
    expect(isValidPlaybackSchedulePreviewTimestamp(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
