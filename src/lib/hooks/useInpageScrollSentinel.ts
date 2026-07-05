import { useCallback, useEffect, useRef, type MutableRefObject, type RefCallback } from 'react';

const DEFAULT_ROOT_MARGIN = '400px';

export type UseInpageScrollSentinelArgs = {
  /** When false, disconnect and ignore the sentinel. */
  active: boolean;
  getScrollRoot?: () => HTMLElement | null;
  /** Rebind when the in-page scroll viewport mounts (callback-ref body). */
  scrollRootEl?: HTMLElement | null;
  onIntersect: () => void;
  rootMargin?: string;
  /** Re-fire `onIntersect` when this changes and the sentinel is still visible. */
  drainSignal?: unknown;
  /** Updated when the sentinel enters/leaves the scroll root viewport. */
  intersectingRef?: MutableRefObject<boolean>;
};

/**
 * Stable IntersectionObserver callback ref for in-page infinite scroll.
 * Matches {@link useClientSliceInfiniteScroll} — avoids reconnect storms when
 * `onIntersect` / `loadMore` identities change every render.
 */
export function useInpageScrollSentinel({
  active,
  getScrollRoot,
  scrollRootEl,
  onIntersect,
  rootMargin = DEFAULT_ROOT_MARGIN,
  drainSignal,
  intersectingRef,
}: UseInpageScrollSentinelArgs): RefCallback<HTMLDivElement | null> {
  const onIntersectRef = useRef(onIntersect);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  onIntersectRef.current = onIntersect;

  const setIntersecting = useCallback((hit: boolean) => {
    if (intersectingRef) intersectingRef.current = hit;
  }, [intersectingRef]);

  const observerInst = useRef<IntersectionObserver | null>(null);

  const bindSentinel = useCallback((node: HTMLDivElement | null) => {
    observerInst.current?.disconnect();
    observerInst.current = null;
    if (!node) {
      setIntersecting(false);
      return;
    }
    if (!active) {
      setIntersecting(false);
      return;
    }

    const rootEl = getScrollRoot?.() ?? null;
    const observer = new IntersectionObserver(
      entries => {
        const hit = Boolean(entries[0]?.isIntersecting);
        setIntersecting(hit);
        if (hit) onIntersectRef.current();
      },
      {
        root: rootEl instanceof HTMLElement ? rootEl : null,
        rootMargin,
      },
    );
    observer.observe(node);
    observerInst.current = observer;
    // scrollRootEl is an intentional re-create trigger: when the resolved scroll
    // root element changes the sentinel must re-bind its observer to the new root,
    // even though the body reads it via getScrollRoot() rather than directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, getScrollRoot, scrollRootEl, rootMargin, setIntersecting]);

  useEffect(() => {
    const observer = observerInst.current;
    if (!observer || !active) return;
    for (const entry of observer.takeRecords()) {
      const hit = entry.isIntersecting;
      setIntersecting(hit);
      if (hit) onIntersectRef.current();
    }
  }, [active, drainSignal, setIntersecting]);

  useEffect(() => () => {
    observerInst.current?.disconnect();
    observerInst.current = null;
  }, []);

  return bindSentinel;
}
