import { useCallback } from 'react';
import { useAsyncInpagePagination } from '@/lib/hooks/useAsyncInpagePagination';
import { useInpageScrollSentinel } from '@/lib/hooks/useInpageScrollSentinel';

export type UseAsyncInpageScrollArgs = {
  pageSize: number;
  active: boolean;
  hasMore: boolean;
  getScrollRoot?: () => HTMLElement | null;
  scrollRootEl?: HTMLElement | null;
  rootMargin?: string;
  onLoadOffset: (offset: number, append: boolean) => void | Promise<void>;
};

/**
 * Offset-based server pagination with stable in-page sentinel wiring.
 */
export function useAsyncInpageScroll({
  pageSize,
  active,
  hasMore,
  getScrollRoot,
  scrollRootEl,
  rootMargin,
  onLoadOffset,
}: UseAsyncInpageScrollArgs) {
  const paging = useAsyncInpagePagination(pageSize);

  const loadMore = useCallback(() => {
    if (!active || !hasMore || paging.isBlocked()) return;
    paging.requestNextPage(offset => onLoadOffset(offset, true));
  }, [active, hasMore, onLoadOffset, paging]);

  const bindSentinel = useInpageScrollSentinel({
    active: active && hasMore,
    getScrollRoot,
    scrollRootEl,
    rootMargin,
    onIntersect: loadMore,
  });

  return {
    ...paging,
    bindSentinel,
    loadMore,
  };
}
