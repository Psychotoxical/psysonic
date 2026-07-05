import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
type BrowseScrollSnapshot = {
  scrollTop: number;
  visibleCount: number;
};

type Args = {
  scrollSnapshotRef: RefObject<BrowseScrollSnapshot>;
  getScrollRoot: () => HTMLElement | null;
  isScrollRestorePending: boolean;
  resetKey: string;
  viewMode: 'grid' | 'list';
  listVirtualize: boolean;
  listVirtualizer: Virtualizer<HTMLElement, Element>;
};

/** Scroll to top when browse filters shrink the list (e.g. scoped text search). */
export function useArtistsBrowseScrollReset({
  scrollSnapshotRef,
  getScrollRoot,
  isScrollRestorePending,
  resetKey,
  viewMode,
  listVirtualize,
  listVirtualizer,
}: Args): void {
  const prevResetKeyRef = useRef(resetKey);

  useLayoutEffect(() => {
    if (isScrollRestorePending) return;
    if (prevResetKeyRef.current === resetKey) return;
    prevResetKeyRef.current = resetKey;

    const el = getScrollRoot();
    if (!el) return;

    if (el.scrollTop !== 0) {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: false }));
    }
    scrollSnapshotRef.current.scrollTop = 0;

    if (listVirtualize && viewMode === 'list') listVirtualizer.scrollToOffset(0);
  }, [
    resetKey,
    isScrollRestorePending,
    getScrollRoot,
    scrollSnapshotRef,
    viewMode,
    listVirtualize,
    listVirtualizer,
  ]);
}
