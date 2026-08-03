import type { PointerEvent as ReactPointerEvent } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRANSIENT_UI_OPEN_EVENT } from '@/lib/dom/transientUi';
import { usePlaybackDelayPress } from './usePlaybackDelayPress';

describe('usePlaybackDelayPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('announces before a long press opens the delay modal', () => {
    const onTransientOpen = vi.fn();
    window.addEventListener(TRANSIENT_UI_OPEN_EVENT, onTransientOpen);
    const { result } = renderHook(() => usePlaybackDelayPress(vi.fn()));

    act(() => result.current.playPauseBind.onPointerDown({
      pointerType: 'mouse',
      button: 0,
      clientX: 0,
      clientY: 0,
    } as ReactPointerEvent));
    act(() => vi.advanceTimersByTime(550));

    expect(result.current.delayModalOpen).toBe(true);
    expect(onTransientOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(TRANSIENT_UI_OPEN_EVENT, onTransientOpen);
  });

  it('cancels a pending long press when the owner unmounts', () => {
    const onTransientOpen = vi.fn();
    window.addEventListener(TRANSIENT_UI_OPEN_EVENT, onTransientOpen);
    const { result, unmount } = renderHook(() => usePlaybackDelayPress(vi.fn()));

    act(() => result.current.playPauseBind.onPointerDown({
      pointerType: 'mouse',
      button: 0,
      clientX: 0,
      clientY: 0,
    } as ReactPointerEvent));
    unmount();
    act(() => vi.advanceTimersByTime(550));

    expect(onTransientOpen).not.toHaveBeenCalled();
    window.removeEventListener(TRANSIENT_UI_OPEN_EVENT, onTransientOpen);
  });
});
