import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetSeekDebounceForTest,
  armSeekDebounce,
  clearSeekDebounce,
  isSeekDebouncePending,
} from './seekDebounce';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  _resetSeekDebounceForTest();
  vi.useRealTimers();
});

describe('seekDebounce', () => {
  it('starts not pending', () => {
    expect(isSeekDebouncePending()).toBe(false);
  });

  it('armSeekDebounce flips pending true and fires the callback after the delay', () => {
    const cb = vi.fn();
    armSeekDebounce(100, cb);
    expect(isSeekDebouncePending()).toBe(true);
    vi.advanceTimersByTime(99);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(isSeekDebouncePending()).toBe(false);
  });

  it('arming again before fire replaces the callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    armSeekDebounce(100, first);
    armSeekDebounce(100, second);
    vi.advanceTimersByTime(100);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clearSeekDebounce cancels a pending fire', () => {
    const cb = vi.fn();
    armSeekDebounce(100, cb);
    clearSeekDebounce();
    expect(isSeekDebouncePending()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('clearSeekDebounce is a no-op when nothing is pending', () => {
    expect(() => clearSeekDebounce()).not.toThrow();
  });
});
