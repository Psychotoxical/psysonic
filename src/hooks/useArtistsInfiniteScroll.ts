import React, { useCallback, useEffect, useRef, useState } from 'react';

interface UseArtistsInfiniteScrollArgs {
  pageSize: number;
  resetDeps: ReadonlyArray<unknown>;
}

interface UseArtistsInfiniteScrollResult {
  visibleCount: number;
  loadingMore: boolean;
  observerTarget: React.RefObject<HTMLDivElement | null>;
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
 * (the cleanup runs as the sentinel unmounts).
 */
export function useArtistsInfiniteScroll({
  pageSize,
  resetDeps,
}: UseArtistsInfiniteScrollArgs): UseArtistsInfiniteScrollResult {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [loadingMore, setLoadingMore] = useState(false);
  const observerTarget = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(() => {
    if (loadingMore) return;
    setLoadingMore(true);
    setVisibleCount(prev => prev + pageSize);
    setTimeout(() => setLoadingMore(false), 100);
  }, [loadingMore, pageSize]);

  useEffect(() => {
    setVisibleCount(pageSize);
    // resetDeps is intentionally spread into the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, ...resetDeps]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '200px' },
    );
    if (observerTarget.current) observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [loadMore]);

  return { visibleCount, loadingMore, observerTarget, loadMore };
}
