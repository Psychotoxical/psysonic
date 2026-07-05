import { describe, expect, it } from 'vitest';
import { isPlaybackEffectActive } from '@/features/playback/utils/audio/playbackRateHelpers';
import {
  playbackPathChanged,
  shouldRestartPlaybackForRateChange,
  usesPreservePlaybackPath,
} from '@/features/playback/utils/audio/playbackRateRestart';

describe('playbackRateRestart', () => {
  const base = {
    enabled: true,
    strategy: 'speed_corrected' as const,
    speed: 1.5,
    pitchSemitones: 0,
  };

  it('detects preserve vs varispeed paths', () => {
    expect(usesPreservePlaybackPath('speed_corrected')).toBe(true);
    expect(usesPreservePlaybackPath('preserve_pitch')).toBe(true);
    expect(usesPreservePlaybackPath('varispeed')).toBe(false);
    expect(playbackPathChanged('speed_corrected', 'varispeed')).toBe(true);
    expect(playbackPathChanged('speed_corrected', 'preserve_pitch')).toBe(false);
  });

  it('restarts on strategy change', () => {
    expect(shouldRestartPlaybackForRateChange(
      base,
      { ...base, strategy: 'varispeed' },
    )).toBe(true);
  });

  it('restarts when effect becomes active', () => {
    expect(shouldRestartPlaybackForRateChange(
      { ...base, speed: 1.0 },
      { ...base, speed: 1.5 },
    )).toBe(true);
    expect(isPlaybackEffectActive(true, 'speed_corrected', 1.0, 0)).toBe(false);
    expect(isPlaybackEffectActive(true, 'speed_corrected', 1.5, 0)).toBe(true);
  });

  it('does not restart on speed tweak within varispeed', () => {
    expect(shouldRestartPlaybackForRateChange(
      { ...base, strategy: 'varispeed', speed: 1.5 },
      { ...base, strategy: 'varispeed', speed: 1.75 },
    )).toBe(false);
  });

  it('does not restart on pitch tweak within preserve_pitch', () => {
    expect(shouldRestartPlaybackForRateChange(
      { ...base, strategy: 'preserve_pitch', pitchSemitones: 0 },
      { ...base, strategy: 'preserve_pitch', pitchSemitones: 2 },
    )).toBe(false);
  });

  it('does not restart switching between the two varispeed lenses at the same speed', () => {
    expect(usesPreservePlaybackPath('varispeed_semitones')).toBe(false);
    expect(playbackPathChanged('varispeed', 'varispeed_semitones')).toBe(false);
    expect(shouldRestartPlaybackForRateChange(
      { ...base, strategy: 'varispeed', speed: 1.5 },
      { ...base, strategy: 'varispeed_semitones', speed: 1.5 },
    )).toBe(false);
  });
});
