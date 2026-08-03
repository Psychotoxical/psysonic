import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useInpageScrollSentinel } from '@/lib/hooks/useInpageScrollSentinel';
import { intersectionObserverCount, latestIntersectionObserver } from '@/test/mocks/browser';

/** The observer the hook just bound, failing loudly when it bound none. */
function boundObserver() {
  const observer = latestIntersectionObserver();
  expect(observer, 'the hook bound no IntersectionObserver').toBeDefined();
  return observer!;
}

describe('useInpageScrollSentinel', () => {
  it('returns a callback ref function', () => {
    const onIntersect = vi.fn();
    const { result } = renderHook(() =>
      useInpageScrollSentinel({
        active: true,
        onIntersect,
      }),
    );
    expect(typeof result.current).toBe('function');
  });

  it('calls onIntersect when the sentinel comes into view', () => {
    const onIntersect = vi.fn();
    const { result } = renderHook(() =>
      useInpageScrollSentinel({ active: true, onIntersect }),
    );

    result.current(document.createElement('div'));
    boundObserver().emit(true);

    expect(onIntersect).toHaveBeenCalledTimes(1);
  });

  // Why both album grids stalled: an observer reports *changes*, so a sentinel
  // that stays inside the rootMargin after a page is appended produces no second
  // callback. Re-rendering does not conjure one either. The flag is therefore the
  // only thing left that tells a consumer more content is still wanted.
  it('keeps the visibility flag set without firing again while it stays in view', () => {
    const onIntersect = vi.fn();
    const intersectingRef = { current: false };

    const { result, rerender } = renderHook(() =>
      useInpageScrollSentinel({ active: true, onIntersect, intersectingRef }),
    );

    result.current(document.createElement('div'));
    boundObserver().emit(true);
    expect(onIntersect).toHaveBeenCalledTimes(1);

    rerender();

    expect(onIntersect).toHaveBeenCalledTimes(1);
    expect(intersectingRef.current).toBe(true);
  });

  it('replays a pending record when the drain signal changes', () => {
    const onIntersect = vi.fn();
    const intersectingRef = { current: false };

    const { result, rerender } = renderHook(
      ({ drainSignal }) =>
        useInpageScrollSentinel({ active: true, onIntersect, intersectingRef, drainSignal }),
      { initialProps: { drainSignal: false } },
    );

    result.current(document.createElement('div'));
    const observer = boundObserver();
    observer.takeRecords.mockReturnValue([
      { isIntersecting: true } as IntersectionObserverEntry,
    ]);

    rerender({ drainSignal: true });

    expect(onIntersect).toHaveBeenCalledTimes(1);
    expect(intersectingRef.current).toBe(true);
  });

  it('clears the visibility flag when the sentinel leaves the viewport', () => {
    const onIntersect = vi.fn();
    const intersectingRef = { current: false };

    const { result } = renderHook(() =>
      useInpageScrollSentinel({ active: true, onIntersect, intersectingRef }),
    );

    result.current(document.createElement('div'));
    boundObserver().emit(true);
    expect(intersectingRef.current).toBe(true);

    boundObserver().emit(false);
    expect(intersectingRef.current).toBe(false);
  });

  it('clears the visibility flag when the sentinel node is detached', () => {
    const onIntersect = vi.fn();
    const intersectingRef = { current: false };

    const { result } = renderHook(() =>
      useInpageScrollSentinel({ active: true, onIntersect, intersectingRef }),
    );

    result.current(document.createElement('div'));
    boundObserver().emit(true);
    expect(intersectingRef.current).toBe(true);

    result.current(null);
    expect(intersectingRef.current).toBe(false);
  });

  it('does not observe while inactive', () => {
    const onIntersect = vi.fn();
    const intersectingRef = { current: true };

    const { result } = renderHook(() =>
      useInpageScrollSentinel({ active: false, onIntersect, intersectingRef }),
    );

    result.current(document.createElement('div'));

    expect(intersectionObserverCount()).toBe(0);
    expect(intersectingRef.current).toBe(false);
    expect(onIntersect).not.toHaveBeenCalled();
  });
});
