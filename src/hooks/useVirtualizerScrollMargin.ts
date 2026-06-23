import { useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';

/**
 * Distance between a virtualizer's wrapper element and its scroll element.
 * Pass as `scrollMargin` to `useVirtualizer`, and subtract from `vItem.start`
 * when positioning rendered rows. Without it, `@tanstack/react-virtual`
 * places rows relative to the scroll-element top — so a wrapper that sits
 * below other content (sticky header, tracklist, hero) ends up with rows at
 * the wrong Y, and rows still in the viewport may unmount.
 *
 * Re-measures via `ResizeObserver` on the scroll element and its first child
 * so content growing above the wrapper updates the offset.
 */
export function useVirtualizerScrollMargin(
  wrapRef: React.RefObject<HTMLElement | null>,
  getScrollElement: () => HTMLElement | null,
  options: {
    active: boolean;
    /** Caller-supplied dependencies that affect the wrapper's position. */
    deps: ReadonlyArray<unknown>;
  },
): number {
  const [scrollMargin, setScrollMargin] = useState(0);
  const getterRef = useRef(getScrollElement);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  getterRef.current = getScrollElement;
  useLayoutEffect(() => {
    if (!options.active) return;
    const wrap = wrapRef.current;
    const scrollEl = getterRef.current();
    if (!wrap || !scrollEl) return;
    const measure = () => {
      const margin =
        wrap.getBoundingClientRect().top
        - scrollEl.getBoundingClientRect().top
        + scrollEl.scrollTop;
      setScrollMargin(prev => (Math.abs(prev - margin) < 1 ? prev : margin));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scrollEl);
    const scrollContent = scrollEl.firstElementChild as Element | null;
    if (scrollContent) ro.observe(scrollContent);
    return () => ro.disconnect();
    // options.deps is a caller-supplied dependency list spread in on purpose so
    // this reusable hook re-measures when the caller's layout inputs change;
    // it cannot be statically verified, which is expected here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.active, wrapRef, ...options.deps]);
  return scrollMargin;
}
