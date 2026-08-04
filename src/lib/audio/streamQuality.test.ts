import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STREAM_MAX_BITRATE_KBPS,
  STREAM_MAX_BITRATE_OPTIONS,
  sanitizeStreamMaxBitRateKbps,
} from '@/lib/audio/streamQuality';

describe('sanitizeStreamMaxBitRateKbps', () => {
  it('accepts every supported option verbatim', () => {
    for (const opt of STREAM_MAX_BITRATE_OPTIONS) {
      expect(sanitizeStreamMaxBitRateKbps(opt)).toBe(opt);
    }
  });

  it('falls back to Original (0) for unsupported / malformed values', () => {
    for (const bad of [1, 999, -320, 320.5, '192', null, undefined, NaN, {}]) {
      expect(sanitizeStreamMaxBitRateKbps(bad)).toBe(DEFAULT_STREAM_MAX_BITRATE_KBPS);
    }
  });

  it('defaults to Original (0)', () => {
    expect(DEFAULT_STREAM_MAX_BITRATE_KBPS).toBe(0);
  });
});
