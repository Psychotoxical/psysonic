/**
 * `formatClockTime` is a thin wrapper around `Date.toLocaleTimeString` whose
 * only knob is `hour12`, mapped from the user's `ClockFormat` setting. The
 * exact `HH:MM` output is locale-dependent and not asserted here — these
 * tests pin only the `hour12` mapping, which is what the setting controls.
 */
import { describe, expect, it } from 'vitest';
import { formatClockTime } from '@/lib/format/formatClockTime';

const SAMPLE_TS = Date.UTC(2026, 0, 1, 19, 17, 0); // 19:17 UTC, deterministic

describe('formatClockTime — clockFormat mapping', () => {
  it('forces 24-hour output when clockFormat === "24h" (no AM/PM marker)', () => {
    const out = formatClockTime(SAMPLE_TS, '24h');
    expect(out).not.toMatch(/AM|PM/i);
  });

  it('forces 12-hour output when clockFormat === "12h" (renders an AM/PM marker)', () => {
    const out = formatClockTime(SAMPLE_TS, '12h');
    expect(out).toMatch(/AM|PM/i);
  });

  it('falls through to the locale default when clockFormat === "auto"', () => {
    // We do not assert AM/PM either way here — `'auto'` deliberately defers to
    // the JS engine's locale. The contract is just "do not force `hour12`".
    expect(() => formatClockTime(SAMPLE_TS, 'auto')).not.toThrow();
  });

  it('falls through to the locale default when clockFormat is omitted', () => {
    expect(() => formatClockTime(SAMPLE_TS)).not.toThrow();
  });
});
