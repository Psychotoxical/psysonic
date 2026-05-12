/**
 * Deferred pause/resume timer lifecycle. Vitest fake timers drive the
 * setTimeout/clearTimeout pair; the new schedule helpers fire the callback
 * exactly once, auto-clearing their internal handle so a follow-up
 * `clearAll…` is idempotent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetScheduleTimersForTest,
  clearAllPlaybackScheduleTimers,
  clearScheduledPauseTimers,
  clearScheduledResumeTimers,
  schedulePauseTimer,
  scheduleResumeTimer,
} from './scheduleTimers';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  _resetScheduleTimersForTest();
  vi.useRealTimers();
});

describe('schedulePauseTimer', () => {
  it('fires the callback exactly once after the delay', () => {
    const cb = vi.fn();
    schedulePauseTimer(1000, cb);
    vi.advanceTimersByTime(999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('replaces an outstanding timer when called again (only the latest fires)', () => {
    const first = vi.fn();
    const second = vi.fn();
    schedulePauseTimer(500, first);
    schedulePauseTimer(500, second);
    vi.advanceTimersByTime(500);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clearScheduledPauseTimers cancels a pending fire', () => {
    const cb = vi.fn();
    schedulePauseTimer(500, cb);
    clearScheduledPauseTimers();
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('clearScheduledPauseTimers is a no-op when nothing is pending', () => {
    expect(() => clearScheduledPauseTimers()).not.toThrow();
  });
});

describe('scheduleResumeTimer', () => {
  it('fires after the delay and clears its handle', () => {
    const cb = vi.fn();
    scheduleResumeTimer(750, cb);
    vi.advanceTimersByTime(750);
    expect(cb).toHaveBeenCalledTimes(1);
    // Subsequent clear is a no-op (timer already cleared itself on fire).
    expect(() => clearScheduledResumeTimers()).not.toThrow();
  });

  it('runs independently from the pause timer', () => {
    const pause = vi.fn();
    const resume = vi.fn();
    schedulePauseTimer(500, pause);
    scheduleResumeTimer(800, resume);
    vi.advanceTimersByTime(500);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});

describe('clearAllPlaybackScheduleTimers', () => {
  it('cancels both pending timers in one call', () => {
    const pause = vi.fn();
    const resume = vi.fn();
    schedulePauseTimer(500, pause);
    scheduleResumeTimer(500, resume);
    clearAllPlaybackScheduleTimers();
    vi.advanceTimersByTime(1000);
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });
});
