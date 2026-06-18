import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armAutodjMixing,
  clearAutodjTransitionUi,
  setAutodjPreparing,
  useAutodjTransitionUi,
} from './autodjTransitionUi';

describe('autodjTransitionUi', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAutodjTransitionUi();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms mixing then returns to idle after overlap', () => {
    armAutodjMixing(2);
    expect(useAutodjTransitionUi.getState().phase).toBe('mixing');
    vi.advanceTimersByTime(2250);
    expect(useAutodjTransitionUi.getState().phase).toBe('idle');
  });

  it('mixing wins over preparing until overlap ends', () => {
    setAutodjPreparing(true);
    expect(useAutodjTransitionUi.getState().phase).toBe('preparing');
    armAutodjMixing(1);
    expect(useAutodjTransitionUi.getState().phase).toBe('mixing');
    setAutodjPreparing(false);
    expect(useAutodjTransitionUi.getState().phase).toBe('mixing');
    vi.advanceTimersByTime(1300);
    expect(useAutodjTransitionUi.getState().phase).toBe('idle');
  });
});
