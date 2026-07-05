import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { usePlayerStatsLiveRefresh } from '@/features/stats/hooks/usePlayerStatsLiveRefresh';
import { emitPlaySessionRecorded } from '@/features/playback/store/playSessionRecorded';

describe('usePlayerStatsLiveRefresh', () => {
  it('refreshes when a play session is recorded and the tab is visible', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    const onRefresh = vi.fn();
    renderHook(() => usePlayerStatsLiveRefresh(onRefresh));
    emitPlaySessionRecorded({ serverId: 's1', trackId: 't1', startedAtMs: 1 });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on record while the tab is hidden', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    const onRefresh = vi.fn();
    renderHook(() => usePlayerStatsLiveRefresh(onRefresh));
    emitPlaySessionRecorded({ serverId: 's1', trackId: 't1', startedAtMs: 1 });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('refreshes when the tab becomes visible again', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    const onRefresh = vi.fn();
    renderHook(() => usePlayerStatsLiveRefresh(onRefresh));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
