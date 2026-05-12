import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetTogglePlayLockForTest,
  tryAcquireTogglePlayLock,
} from './togglePlayLock';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  _resetTogglePlayLockForTest();
  vi.useRealTimers();
});

describe('tryAcquireTogglePlayLock', () => {
  it('returns true on first acquire', () => {
    expect(tryAcquireTogglePlayLock()).toBe(true);
  });

  it('returns false when already held', () => {
    tryAcquireTogglePlayLock();
    expect(tryAcquireTogglePlayLock()).toBe(false);
  });

  it('auto-releases after the default 300 ms window', () => {
    tryAcquireTogglePlayLock();
    vi.advanceTimersByTime(299);
    expect(tryAcquireTogglePlayLock()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(tryAcquireTogglePlayLock()).toBe(true);
  });

  it('honours a custom lock duration', () => {
    tryAcquireTogglePlayLock(1000);
    vi.advanceTimersByTime(500);
    expect(tryAcquireTogglePlayLock()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(tryAcquireTogglePlayLock()).toBe(true);
  });

  it('_resetTogglePlayLockForTest force-releases', () => {
    tryAcquireTogglePlayLock();
    _resetTogglePlayLockForTest();
    expect(tryAcquireTogglePlayLock()).toBe(true);
  });
});
