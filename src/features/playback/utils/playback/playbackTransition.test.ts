import { describe, expect, it, beforeEach } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import {
  getTransitionMode,
  transitionFlagsFor,
  setTransitionMode,
  type TransitionMode,
} from '@/features/playback/utils/playback/playbackTransition';

const MODES: TransitionMode[] = ['none', 'gapless', 'crossfade', 'autodj'];

describe('getTransitionMode', () => {
  it('maps each flag combination to its mode', () => {
    expect(getTransitionMode({ gaplessEnabled: false, crossfadeEnabled: false, crossfadeTrimSilence: false })).toBe('none');
    expect(getTransitionMode({ gaplessEnabled: true, crossfadeEnabled: false, crossfadeTrimSilence: false })).toBe('gapless');
    expect(getTransitionMode({ gaplessEnabled: false, crossfadeEnabled: true, crossfadeTrimSilence: false })).toBe('crossfade');
    expect(getTransitionMode({ gaplessEnabled: false, crossfadeEnabled: true, crossfadeTrimSilence: true })).toBe('autodj');
  });

  it('treats trim-silence as AutoDJ only while crossfade is on', () => {
    // Stale trim flag with crossfade off is still "none", not AutoDJ.
    expect(getTransitionMode({ gaplessEnabled: false, crossfadeEnabled: false, crossfadeTrimSilence: true })).toBe('none');
  });

  it('is total — gapless wins if both gapless and crossfade are set', () => {
    expect(getTransitionMode({ gaplessEnabled: true, crossfadeEnabled: true, crossfadeTrimSilence: true })).toBe('gapless');
  });
});

describe('transitionFlagsFor', () => {
  it('round-trips through getTransitionMode for every mode', () => {
    for (const mode of MODES) {
      expect(getTransitionMode(transitionFlagsFor(mode))).toBe(mode);
    }
  });

  it('never sets more than one independent behaviour at once', () => {
    for (const mode of MODES) {
      const f = transitionFlagsFor(mode);
      // crossfade and gapless are the two independent toggles; trim only rides on crossfade
      expect(f.gaplessEnabled && f.crossfadeEnabled).toBe(false);
      if (f.crossfadeTrimSilence) expect(f.crossfadeEnabled).toBe(true);
    }
  });
});

describe('setTransitionMode', () => {
  beforeEach(() => {
    setTransitionMode('none');
  });

  it('applies the flags atomically and enforces exclusivity', () => {
    setTransitionMode('crossfade');
    let s = useAuthStore.getState();
    expect(s.crossfadeEnabled).toBe(true);
    expect(s.crossfadeTrimSilence).toBe(false);
    expect(s.gaplessEnabled).toBe(false);

    setTransitionMode('autodj');
    s = useAuthStore.getState();
    expect(s.crossfadeEnabled).toBe(true);
    expect(s.crossfadeTrimSilence).toBe(true);
    expect(s.gaplessEnabled).toBe(false);

    setTransitionMode('gapless');
    s = useAuthStore.getState();
    expect(s.gaplessEnabled).toBe(true);
    expect(s.crossfadeEnabled).toBe(false);
    expect(s.crossfadeTrimSilence).toBe(false);

    setTransitionMode('none');
    s = useAuthStore.getState();
    expect(s.gaplessEnabled).toBe(false);
    expect(s.crossfadeEnabled).toBe(false);
    expect(s.crossfadeTrimSilence).toBe(false);
  });

  it('preserves crossfadeSecs when switching between crossfade and autodj', () => {
    useAuthStore.getState().setCrossfadeSecs(7);
    setTransitionMode('crossfade');
    setTransitionMode('autodj');
    setTransitionMode('crossfade');
    expect(useAuthStore.getState().crossfadeSecs).toBe(7);
  });
});
