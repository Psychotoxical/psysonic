import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { useInpageScrollSentinel } from './useInpageScrollSentinel';

export type UseClientSliceInfiniteScrollArgs = {
  pageSize: number;
  resetDeps: ReadonlyArray<unknown>;
  getScrollRoot?: () => HTMLElement | null;
  scrollRootEl?: HTMLElement | null;
  rootMargin?: string;
};

export type UseClientSliceInfiniteScrollResult = {
  visibleCount: number;
  loadingMore: boolean;
  bindSentinel: ReturnType<typeof useInpageScrollSentinel>;
  /** @deprecated Use `bindSentinel`. */
  observerTarget: ReturnType<typeof useInpageScrollSentinel>;
  loadMore: () => void;
};

/**
 * Client-side infinite scroll: grow a visible slice from an in-memory list.
 * Used by Artists and Composers browse grids.
 */
export function useClientSliceInfiniteScroll({
  pageSize,
  resetDeps,
  getScrollRoot,
  scrollRootEl,
  rootMargin = '200px',
}: UseClientSliceInfiniteScrollArgs): UseClientSliceInfiniteScrollResult {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadPendingRef = useRef(false);

  const loadMore = useCallback(() => {
    if (loadPendingRef.current) return;
    loadPendingRef.current = true;
    setLoadingMore(true);
    setVisibleCount(prev => prev + pageSize);
  }, [pageSize]);

  useEffect(() => {
    loadPendingRef.current = false;
    setLoadingMore(false);
  }, [visibleCount]);

  useEffect(() => {
    setVisibleCount(pageSize);
    // resetDeps is intentionally spread into the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, ...resetDeps]);

  const bindSentinel = useInpageScrollSentinel({
    active: true,
    getScrollRoot: () =>
      getScrollRoot?.() ?? (document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID) as HTMLElement | null),
    scrollRootEl,
    rootMargin,
    onIntersect: loadMore,
  });

  return {
    visibleCount,
    loadingMore,
    bindSentinel,
    observerTarget: bindSentinel,
    loadMore,
  };
}
