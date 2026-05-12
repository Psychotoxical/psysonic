import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SEEK_TARGET_GUARD_TIMEOUT_MS,
  _resetSeekTargetStateForTest,
  clearSeekTarget,
  getSeekTarget,
  getSeekTargetSetAt,
  setSeekTarget,
} from './seekTargetState';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
});

afterEach(() => {
  _resetSeekTargetStateForTest();
  vi.useRealTimers();
});

describe('SEEK_TARGET_GUARD_TIMEOUT_MS', () => {
  it('is the value the progress handler expects', () => {
    expect(SEEK_TARGET_GUARD_TIMEOUT_MS).toBe(5000);
  });
});

describe('seekTargetState', () => {
  it('returns null + 0 before any seek', () => {
    expect(getSeekTarget()).toBeNull();
    expect(getSeekTargetSetAt()).toBe(0);
  });

  it('stores target + timestamp on set', () => {
    setSeekTarget(42);
    expect(getSeekTarget()).toBe(42);
    expect(getSeekTargetSetAt()).toBe(Date.now());
  });

  it('updates timestamp when called again', () => {
    setSeekTarget(10);
    const first = getSeekTargetSetAt();
    vi.advanceTimersByTime(1000);
    setSeekTarget(20);
    expect(getSeekTarget()).toBe(20);
    expect(getSeekTargetSetAt()).toBeGreaterThan(first);
  });

  it('clearSeekTarget resets both fields', () => {
    setSeekTarget(42);
    clearSeekTarget();
    expect(getSeekTarget()).toBeNull();
    expect(getSeekTargetSetAt()).toBe(0);
  });

  it('clearSeekTarget is a no-op when nothing is set', () => {
    expect(() => clearSeekTarget()).not.toThrow();
    expect(getSeekTarget()).toBeNull();
  });
});
