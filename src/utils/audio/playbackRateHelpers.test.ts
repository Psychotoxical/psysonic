import { describe, expect, it } from 'vitest';
import {
  clampPlaybackSpeed,
  isPlaybackEffectActive,
  isPlaybackRateApplied,
  derivedVarispeedSemitones,
} from './playbackRateHelpers';

describe('playbackRateHelpers', () => {
  it('is inactive when disabled', () => {
    expect(isPlaybackEffectActive(false, 'speed_corrected', 1.5, 0)).toBe(false);
  });

  it('is inactive at 1.0x and 0 pitch when enabled', () => {
    expect(isPlaybackEffectActive(true, 'speed_corrected', 1.0, 0)).toBe(false);
  });

  it('is active when speed differs from 1', () => {
    expect(isPlaybackEffectActive(true, 'speed_corrected', 1.25, 0)).toBe(true);
  });

  it('preserve_pitch is active at 1.0x with pitch offset', () => {
    expect(isPlaybackEffectActive(true, 'preserve_pitch', 1.0, 2)).toBe(true);
  });

  it('speed_corrected ignores stored pitch at 1.0x', () => {
    expect(isPlaybackEffectActive(true, 'speed_corrected', 1.0, 2)).toBe(false);
  });

  it('clamps speed', () => {
    expect(clampPlaybackSpeed(3)).toBe(2);
    expect(clampPlaybackSpeed(0.1)).toBe(0.5);
  });

  it('derives semitones for varispeed', () => {
    expect(derivedVarispeedSemitones(2)).toBeCloseTo(12, 1);
  });

  it('is not applied during orbit', () => {
    expect(isPlaybackRateApplied(true, 'speed_corrected', 1.5, 0, true)).toBe(false);
    expect(isPlaybackRateApplied(true, 'speed_corrected', 1.5, 0, false)).toBe(true);
  });
});
