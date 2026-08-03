import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  TRANSIENT_UI_OPEN_EVENT,
  requestTransientUiClose,
} from '@/lib/dom/transientUi';
import { usePlayerBarAnchoredPopover } from './usePlayerBarAnchoredPopover';

describe('usePlayerBarAnchoredPopover', () => {
  it('closes an open popover when covering UI is requested', () => {
    const { result } = renderHook(() => usePlayerBarAnchoredPopover(320));
    act(() => result.current.setOpen(true));
    expect(result.current.open).toBe(true);

    act(() => requestTransientUiClose());

    expect(result.current.open).toBe(false);
  });

  it('announces before opening a player-bar popover', () => {
    const onOpen = vi.fn();
    window.addEventListener(TRANSIENT_UI_OPEN_EVENT, onOpen);
    const { result } = renderHook(() => usePlayerBarAnchoredPopover(320));

    act(() => result.current.toggleOpen());

    expect(result.current.open).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(TRANSIENT_UI_OPEN_EVENT, onOpen);
  });
});
