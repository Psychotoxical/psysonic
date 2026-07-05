import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { AlbumBrowseScrollSnapshot } from '@/features/album/hooks/useAlbumBrowseFilters';

type Args = {
  scrollSnapshotRef: RefObject<AlbumBrowseScrollSnapshot>;
  getScrollRoot: () => HTMLElement | null;
  isScrollRestorePending: boolean;
  resetKey: string;
};

/** Scroll to top when browse filters shrink the album grid (e.g. scoped text search). */
export function useAlbumBrowseScrollReset({
  scrollSnapshotRef,
  getScrollRoot,
  isScrollRestorePending,
  resetKey,
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
  }, [resetKey, isScrollRestorePending, getScrollRoot, scrollSnapshotRef]);
}
