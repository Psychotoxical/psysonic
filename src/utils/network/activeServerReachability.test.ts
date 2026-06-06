import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getActiveServerReachable,
  isActiveServerReachable,
  onActiveServerBecameReachable,
  setActiveServerReachable,
} from './activeServerReachability';

describe('activeServerReachability', () => {
  beforeEach(() => {
    setActiveServerReachable(null);
  });

  it('isActiveServerReachable requires an explicit successful probe', () => {
    expect(isActiveServerReachable()).toBe(false);
    setActiveServerReachable(true);
    expect(isActiveServerReachable()).toBe(true);
    setActiveServerReachable(false);
    expect(isActiveServerReachable()).toBe(false);
  });

  it('exposes the last probe result', () => {
    setActiveServerReachable(true);
    expect(getActiveServerReachable()).toBe(true);
  });

  it('onActiveServerBecameReachable fires only on false/null → true', () => {
    const listener = vi.fn();
    onActiveServerBecameReachable(listener);
    setActiveServerReachable(false);
    setActiveServerReachable(true);
    expect(listener).toHaveBeenCalledTimes(1);
    setActiveServerReachable(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
