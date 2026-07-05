import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDiscordBanner } from './useDiscordBanner';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

const THRESHOLD_MS = 20 * 60 * 60 * 1000; // matches useDiscordBanner

describe('useDiscordBanner', () => {
  beforeEach(resetAuthStore);
  afterEach(resetAuthStore);

  it('stays hidden until accumulated usage reaches the threshold', () => {
    useAuthStore.setState({ discordBannerAccumulatedUsageMs: THRESHOLD_MS - 1 });
    const { result } = renderHook(() => useDiscordBanner());
    expect(result.current.visible).toBe(false);
  });

  it('becomes visible at the threshold when never dismissed', () => {
    useAuthStore.setState({ discordBannerAccumulatedUsageMs: THRESHOLD_MS });
    const { result } = renderHook(() => useDiscordBanner());
    expect(result.current.visible).toBe(true);
  });

  it('stays hidden when permanently dismissed even far past the threshold', () => {
    useAuthStore.setState({
      discordBannerAccumulatedUsageMs: THRESHOLD_MS * 2,
      discordBannerDismissed: true,
    });
    const { result } = renderHook(() => useDiscordBanner());
    expect(result.current.visible).toBe(false);
  });

  it('hides for the session on a non-permanent dismiss without persisting', () => {
    useAuthStore.setState({ discordBannerAccumulatedUsageMs: THRESHOLD_MS });
    const { result } = renderHook(() => useDiscordBanner());
    expect(result.current.visible).toBe(true);

    act(() => result.current.dismiss(false));

    expect(result.current.visible).toBe(false);
    expect(useAuthStore.getState().discordBannerDismissed).toBe(false);
  });

  it('persists a permanent dismiss to the auth store', () => {
    useAuthStore.setState({ discordBannerAccumulatedUsageMs: THRESHOLD_MS });
    const { result } = renderHook(() => useDiscordBanner());

    act(() => result.current.dismiss(true));

    expect(result.current.visible).toBe(false);
    expect(useAuthStore.getState().discordBannerDismissed).toBe(true);
  });
});
