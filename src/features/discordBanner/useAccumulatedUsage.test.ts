import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAccumulatedUsage } from './useAccumulatedUsage';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

describe('useAccumulatedUsage', () => {
  beforeEach(() => {
    resetAuthStore();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetAuthStore();
  });

  it('accumulates elapsed time into the auth store on each tick', () => {
    renderHook(() => useAccumulatedUsage());
    expect(useAuthStore.getState().discordBannerAccumulatedUsageMs).toBe(0);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(useAuthStore.getState().discordBannerAccumulatedUsageMs).toBe(30_000);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(useAuthStore.getState().discordBannerAccumulatedUsageMs).toBe(60_000);
  });

  it('stops accumulating after unmount', () => {
    const { unmount } = renderHook(() => useAccumulatedUsage());
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    const afterFirstTick = useAuthStore.getState().discordBannerAccumulatedUsageMs;

    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(useAuthStore.getState().discordBannerAccumulatedUsageMs).toBe(afterFirstTick);
  });
});
