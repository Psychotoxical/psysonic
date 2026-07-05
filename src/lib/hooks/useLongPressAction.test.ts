import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { MouseEvent, PointerEvent } from 'react';
import { useLongPressAction } from '@/lib/hooks/useLongPressAction';

function makePointerDown(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return {
    pointerType: 'mouse',
    button: 0,
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as PointerEvent;
}

function makeClick(): MouseEvent {
  return { stopPropagation: vi.fn() } as unknown as MouseEvent;
}

describe('useLongPressAction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onShortPress after a quick press and click', () => {
    const onShortPress = vi.fn();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPressAction({ onShortPress, onLongPress }),
    );

    act(() => {
      result.current.pressBind.onPointerDown(makePointerDown());
    });
    act(() => {
      document.dispatchEvent(new Event('pointerup'));
    });
    act(() => {
      result.current.pressBind.onClick(makeClick());
    });

    expect(onShortPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('calls onLongPress after the hold duration and suppresses the follow-up click', () => {
    const onShortPress = vi.fn();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPressAction({ onShortPress, onLongPress }),
    );

    act(() => {
      result.current.pressBind.onPointerDown(makePointerDown());
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);

    act(() => {
      document.dispatchEvent(new Event('pointerup'));
    });
    act(() => {
      result.current.pressBind.onClick(makeClick());
    });

    expect(onShortPress).not.toHaveBeenCalled();
  });

  it('shows the hold animation shortly before the long-press fires', () => {
    const { result } = renderHook(() =>
      useLongPressAction({
        onShortPress: vi.fn(),
        onLongPress: vi.fn(),
      }),
    );

    expect(result.current.isHolding).toBe(false);
    act(() => {
      result.current.pressBind.onPointerDown(makePointerDown());
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.isHolding).toBe(true);
  });

  it('ignores non-primary mouse buttons', () => {
    const onShortPress = vi.fn();
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPressAction({ onShortPress, onLongPress }),
    );

    act(() => {
      result.current.pressBind.onPointerDown(makePointerDown({ button: 2 }));
      vi.advanceTimersByTime(1000);
    });

    expect(onShortPress).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();
    expect(result.current.isHolding).toBe(false);
  });
});
