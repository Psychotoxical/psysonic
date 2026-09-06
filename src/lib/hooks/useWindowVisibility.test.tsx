import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useWindowBlurred,
  useWindowVisibility,
  WindowVisibilityProvider,
} from '@/lib/hooks/useWindowVisibility';

function wrapper({ children }: { children: ReactNode }) {
  return <WindowVisibilityProvider>{children}</WindowVisibilityProvider>;
}

describe('WindowVisibilityProvider', () => {
  let focused = true;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = true;
    window.__psyHidden = false;
    window.__psyBlurred = false;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    window.__psyHidden = false;
    window.__psyBlurred = false;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('tracks focus loss separately from hidden state', () => {
    const { result } = renderHook(() => ({
      hidden: useWindowVisibility(),
      blurred: useWindowBlurred(),
    }), { wrapper });

    expect(result.current).toEqual({ hidden: false, blurred: false });

    focused = false;
    window.__psyBlurred = true;
    act(() => window.dispatchEvent(new Event('blur')));
    expect(result.current).toEqual({ hidden: false, blurred: true });

    focused = true;
    window.__psyBlurred = false;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(result.current).toEqual({ hidden: false, blurred: false });
  });

  it('polls the native hidden flag when the webview emits no visibility event', () => {
    const { result } = renderHook(() => useWindowVisibility(), { wrapper });
    expect(result.current).toBe(false);

    window.__psyHidden = true;
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);
  });
});
