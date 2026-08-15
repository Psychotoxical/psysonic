import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavigateFunction } from 'react-router';
import { emitTauriEvent, onInvoke, tauriMockListenerCount } from '@/test/mocks/tauri';
import { resetPlayerStore } from '@/test/helpers/storeReset';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useMediaAndWindowBridge } from './useMediaAndWindowBridge';

describe('useMediaAndWindowBridge MPRIS volume', () => {
  beforeEach(() => {
    resetPlayerStore();
    onInvoke('audio_set_volume', () => undefined);
  });

  it('applies normalized media volume events to the player store', async () => {
    const navigate = vi.fn() as unknown as NavigateFunction;
    const { unmount } = renderHook(() => useMediaAndWindowBridge(navigate));

    await waitFor(() => expect(tauriMockListenerCount('media:set-volume')).toBe(1));
    emitTauriEvent('media:set-volume', 0.42);

    expect(usePlayerStore.getState().volume).toBe(0.42);
    unmount();
  });
});
