import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDevOfflineBrowseStore } from '@/store/devOfflineBrowseStore';
import {
  getActiveServerReachable,
  isActiveServerReachable,
  onActiveServerBecameReachable,
  resetActiveServerConnectionSnapshot,
  setActiveServerReachable,
} from '@/lib/network/activeServerReachability';

describe('activeServerReachability', () => {
  beforeEach(() => {
    useDevOfflineBrowseStore.setState({ forceOffline: false });
    resetActiveServerConnectionSnapshot();
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

  it('isActiveServerReachable is false when DEV force-offline is enabled', () => {
    if (!import.meta.env.DEV) return;
    setActiveServerReachable(true);
    useDevOfflineBrowseStore.setState({ forceOffline: true });
    expect(isActiveServerReachable()).toBe(false);
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
