import { describe, expect, it } from 'vitest';
import {
  clampPlaybackSpeed,
  engineStrategy,
  formatPitchLabel,
  formatSpeedLabel,
  isPlaybackEffectActive,
  isPlaybackRateApplied,
  derivedVarispeedSemitones,
  playbackPitchStep,
  playbackSpeedStep,
  varispeedSpeedFromSemitones,
} from '@/features/playback/utils/audio/playbackRateHelpers';

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

  it('formats speed with two decimals', () => {
    expect(formatSpeedLabel(1.0)).toBe('1.00×');
    expect(formatSpeedLabel(1.05)).toBe('1.05×');
    expect(formatSpeedLabel(1.1)).toBe('1.10×');
    expect(formatSpeedLabel(1.15)).toBe('1.15×');
  });

  it('maps semitones to a speed multiplier and back', () => {
    expect(varispeedSpeedFromSemitones(0)).toBeCloseTo(1, 6);
    expect(varispeedSpeedFromSemitones(12)).toBeCloseTo(2, 6);
    expect(varispeedSpeedFromSemitones(-12)).toBeCloseTo(0.5, 6);
    const speed = varispeedSpeedFromSemitones(3);
    expect(derivedVarispeedSemitones(speed)).toBeCloseTo(3, 6);
  });

  it('routes varispeed_semitones to the varispeed engine', () => {
    expect(engineStrategy('varispeed_semitones')).toBe('varispeed');
    expect(engineStrategy('varispeed')).toBe('varispeed');
    expect(engineStrategy('preserve_pitch')).toBe('preserve_pitch');
    expect(engineStrategy('speed_corrected')).toBe('speed_corrected');
  });

  it('varispeed_semitones is active when speed differs from 1', () => {
    expect(isPlaybackEffectActive(true, 'varispeed_semitones', 1.0, 0)).toBe(false);
    expect(isPlaybackEffectActive(true, 'varispeed_semitones', 1.25, 0)).toBe(true);
  });

  it('returns fine slider steps only when opted in', () => {
    expect(playbackSpeedStep(false)).toBe(0.05);
    expect(playbackSpeedStep(true)).toBe(0.01);
    expect(playbackPitchStep(false)).toBe(0.1);
    expect(playbackPitchStep(true)).toBe(0.01);
  });

  it('formats pitch with configurable precision', () => {
    expect(formatPitchLabel(3)).toBe('+3.0 st');
    expect(formatPitchLabel(-2.5)).toBe('-2.5 st');
    expect(formatPitchLabel(0)).toBe('0.0 st');
    expect(formatPitchLabel(1.23, 2)).toBe('+1.23 st');
    expect(formatPitchLabel(-1.23, 2)).toBe('-1.23 st');
  });
});
