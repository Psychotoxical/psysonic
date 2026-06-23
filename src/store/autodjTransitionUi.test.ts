import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransitionMode } from '../utils/playback/playbackTransition';
import {
  armAutodjMixing,
  clearAutodjTransitionUi,
  useAutodjTransitionUi,
} from './autodjTransitionUi';

describe('autodjTransitionUi', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setTransitionMode('autodj');
    clearAutodjTransitionUi();
  });

  afterEach(() => {
    vi.useRealTimers();
    setTransitionMode('none');
  });

  it('arms mixing then returns to idle after overlap', () => {
    armAutodjMixing(2);
    expect(useAutodjTransitionUi.getState().phase).toBe('mixing');
    vi.advanceTimersByTime(2250);
    expect(useAutodjTransitionUi.getState().phase).toBe('idle');
  });

  it('does not arm outside AutoDJ mode', () => {
    setTransitionMode('crossfade');
    armAutodjMixing(2);
    expect(useAutodjTransitionUi.getState().phase).toBe('idle');
  });
});
