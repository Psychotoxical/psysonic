import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * Track an element's `clientHeight` (ResizeObserver). Used so virtualizers can
 * set `overscan` to roughly one viewport of rows beyond the visible range.
 */
export function useElementClientHeightById(elementId: string, fallback = 800): number {
  const [h, setH] = useState(fallback);
  useLayoutEffect(() => {
    const el = typeof document !== 'undefined' ? document.getElementById(elementId) : null;
    if (!el) {
      setH(fallback);
      return;
    }
    const update = () => setH(el.clientHeight);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, [elementId, fallback]);
  return h;
}

export function useRefElementClientHeight(
  ref: RefObject<HTMLElement | null>,
  fallback = 600,
): number {
  const [h, setH] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setH(el.clientHeight);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, [ref, fallback]);
  return h;
}
