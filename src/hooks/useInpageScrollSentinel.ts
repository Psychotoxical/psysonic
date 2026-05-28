import { useCallback, useEffect, useRef, type RefCallback } from 'react';

const DEFAULT_ROOT_MARGIN = '400px';

export type UseInpageScrollSentinelArgs = {
  /** When false, disconnect and ignore the sentinel. */
  active: boolean;
  getScrollRoot?: () => HTMLElement | null;
  /** Rebind when the in-page scroll viewport mounts (callback-ref body). */
  scrollRootEl?: HTMLElement | null;
  onIntersect: () => void;
  rootMargin?: string;
};

/**
 * Stable IntersectionObserver callback ref for in-page infinite scroll.
 * Matches {@link useArtistsInfiniteScroll} — avoids reconnect storms when
 * `onIntersect` / `loadMore` identities change every render.
 */
export function useInpageScrollSentinel({
  active,
  getScrollRoot,
  scrollRootEl,
  onIntersect,
  rootMargin = DEFAULT_ROOT_MARGIN,
}: UseInpageScrollSentinelArgs): RefCallback<HTMLDivElement | null> {
  const onIntersectRef = useRef(onIntersect);
  onIntersectRef.current = onIntersect;
  const observerInst = useRef<IntersectionObserver | null>(null);

  const bindSentinel = useCallback((node: HTMLDivElement | null) => {
    observerInst.current?.disconnect();
    observerInst.current = null;
    if (!node || !active) return;

    const rootEl = getScrollRoot?.() ?? null;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) onIntersectRef.current();
      },
      {
        root: rootEl instanceof HTMLElement ? rootEl : null,
        rootMargin,
      },
    );
    observer.observe(node);
    observerInst.current = observer;
  }, [active, getScrollRoot, scrollRootEl, rootMargin]);

  useEffect(() => () => {
    observerInst.current?.disconnect();
    observerInst.current = null;
  }, []);

  return bindSentinel;
}
