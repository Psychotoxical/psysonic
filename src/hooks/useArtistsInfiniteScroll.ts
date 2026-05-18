import React, { useCallback, useEffect, useRef, useState } from 'react';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';

interface UseArtistsInfiniteScrollArgs {
  pageSize: number;
  resetDeps: ReadonlyArray<unknown>;
  /** IntersectionObserver root (e.g. Artists in-page overlay viewport). */
  getScrollRoot?: () => HTMLElement | null;
}

interface UseArtistsInfiniteScrollResult {
  visibleCount: number;
  loadingMore: boolean;
  /** Callback ref — attaches IntersectionObserver when the sentinel mounts (fixes first paint behind `loading`). */
  observerTarget: React.RefCallback<HTMLDivElement | null>;
  loadMore: () => void;
}

/**
 * Page through the artists list with a sentinel-driven
 * IntersectionObserver. `pageSize` is dynamic because artist-images
 * mode wants smaller batches to keep disk I/O sane on big libraries
 * (5000+ artists).
 *
 * `resetDeps` is the list of values that should snap `visibleCount`
 * back to one page — filter text, letter pick, starred-only,
 * view-mode, page-size itself.
 *
 * The observer doesn't take a `hasMore` flag — the page only renders
 * the sentinel `<div ref={observerTarget}>` while there is more data,
 * so the observer naturally disconnects when the last page is reached
 * (callback ref runs with `node === null` as the sentinel unmounts).
 */
export function useArtistsInfiniteScroll({
  pageSize,
  resetDeps,
  getScrollRoot,
}: UseArtistsInfiniteScrollArgs): UseArtistsInfiniteScrollResult {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreRef = useRef<() => void>(() => {});
  const observerInst = useRef<IntersectionObserver | null>(null);
  /** Blocks overlapping sentinel callbacks until `visibleCount` commits. */
  const loadPendingRef = useRef(false);

  const loadMore = useCallback(() => {
    if (loadPendingRef.current) return;
    loadPendingRef.current = true;
    setLoadingMore(true);
    setVisibleCount(prev => prev + pageSize);
  }, [pageSize]);

  loadMoreRef.current = loadMore;

  useEffect(() => {
    loadPendingRef.current = false;
    setLoadingMore(false);
  }, [visibleCount]);

  useEffect(() => {
    setVisibleCount(pageSize);
    // resetDeps is intentionally spread into the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, ...resetDeps]);

  const observerTarget = useCallback((node: HTMLDivElement | null) => {
    observerInst.current?.disconnect();
    observerInst.current = null;
    if (!node) return;

    const rootEl = getScrollRoot?.() ?? document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) loadMoreRef.current();
      },
      {
        root: rootEl instanceof HTMLElement ? rootEl : null,
        rootMargin: '200px',
      },
    );
    observer.observe(node);
    observerInst.current = observer;
  }, [getScrollRoot]);

  useEffect(() => () => {
    observerInst.current?.disconnect();
    observerInst.current = null;
  }, []);

  return { visibleCount, loadingMore, observerTarget, loadMore };
}
