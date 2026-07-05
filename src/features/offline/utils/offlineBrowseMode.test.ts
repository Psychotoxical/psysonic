import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { useDevOfflineBrowseStore } from '@/store/devOfflineBrowseStore';
import { resetActiveServerConnectionSnapshot } from '@/lib/network/activeServerReachability';
import { useOfflineBrowseActive } from '@/features/offline/utils/offlineBrowseMode';

describe('useOfflineBrowseActive', () => {
  beforeEach(() => {
    useDevOfflineBrowseStore.setState({ forceOffline: false });
    resetActiveServerConnectionSnapshot();
  });

  it('enables offline browse when DEV force-offline is set', () => {
    if (!import.meta.env.DEV) return;

    act(() => {
      useDevOfflineBrowseStore.getState().setForceOffline(true);
    });

    const { result } = renderHook(() => useOfflineBrowseActive());
    expect(result.current).toBe(true);
  });
});
