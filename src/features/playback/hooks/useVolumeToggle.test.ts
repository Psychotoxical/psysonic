import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVolumeToggle } from './useVolumeToggle';
import { usePlayerStore } from '../store/playerStore';
import { resetAllStores } from '@/test/helpers/storeReset';

beforeEach(() => {
  resetAllStores();
});

describe('useVolumeToggle', () => {
  it('mutes to 0 and restores the pre-mute level on unmute', () => {
    usePlayerStore.setState({ volume: 0.8 });
    const setVolume = vi
      .spyOn(usePlayerStore.getState(), 'setVolume')
      .mockImplementation(v => usePlayerStore.setState({ volume: v }));

    const { result } = renderHook(() => useVolumeToggle());

    act(() => { result.current.toggleMute(); });
    expect(setVolume).toHaveBeenLastCalledWith(0);

    act(() => { result.current.toggleMute(); });
    expect(setVolume).toHaveBeenLastCalledWith(0.8);
  });

  it('restores the last non-zero level after the slider was dragged to 0 (not via the mute button)', () => {
    usePlayerStore.setState({ volume: 0.6 });
    const setVolume = vi
      .spyOn(usePlayerStore.getState(), 'setVolume')
      .mockImplementation(v => usePlayerStore.setState({ volume: v }));

    const { result } = renderHook(() => useVolumeToggle());

    // User drags the slider to 0 directly — the mute button was never clicked.
    act(() => { usePlayerStore.setState({ volume: 0 }); });

    act(() => { result.current.toggleMute(); });
    expect(setVolume).toHaveBeenLastCalledWith(0.6);
  });
});
