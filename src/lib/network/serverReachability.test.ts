import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getActiveServerReachable,
  getConnectionStatus,
  resetActiveServerConnectionSnapshot,
} from './activeServerReachability';
import {
  getServerReachabilitySnapshot,
  publishServerConnectionStatus,
  resetServerReachabilitySnapshot,
  useServerReachabilitySnapshot,
} from './serverReachability';

beforeEach(() => {
  resetServerReachabilitySnapshot();
  resetActiveServerConnectionSnapshot();
});

describe('publishServerConnectionStatus', () => {
  it('updates profile and active-server status immediately', () => {
    publishServerConnectionStatus('a', 'online', true);
    expect(getServerReachabilitySnapshot().get('a')).toBe('available');
    expect(getActiveServerReachable()).toBe(true);
    expect(getConnectionStatus()).toBe('connected');

    publishServerConnectionStatus('a', 'offline', true);
    expect(getServerReachabilitySnapshot().get('a')).toBe('unavailable');
    expect(getActiveServerReachable()).toBe(false);
    expect(getConnectionStatus()).toBe('disconnected');
  });

  it('does not overwrite active-server status for another profile', () => {
    publishServerConnectionStatus('b', 'online');
    expect(getServerReachabilitySnapshot().get('b')).toBe('available');
    expect(getActiveServerReachable()).toBeNull();
    expect(getConnectionStatus()).toBe('checking');
  });

  it('subscribes to the full snapshot only while explicitly enabled', () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useServerReachabilitySnapshot(enabled),
      { initialProps: { enabled: false } },
    );
    const disabledSnapshot = result.current;

    act(() => publishServerConnectionStatus('a', 'online'));
    expect(result.current).toBe(disabledSnapshot);
    expect(result.current.size).toBe(0);

    rerender({ enabled: true });
    expect(result.current.get('a')).toBe('available');

    act(() => publishServerConnectionStatus('a', 'offline'));
    expect(result.current.get('a')).toBe('unavailable');
  });
});
