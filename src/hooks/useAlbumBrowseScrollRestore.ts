import { useLayoutEffect, useRef, useState } from 'react';
import { useNavigationType, type NavigationType } from 'react-router-dom';
import {
  peekAlbumBrowseScrollRestore,
  useAlbumBrowseSessionStore,
} from '../store/albumBrowseSessionStore';

type PendingScroll = {
  scrollTop: number;
  displayCount: number;
};

export type UseAlbumBrowseScrollRestoreArgs = {
  serverId: string;
  scrollBodyEl: HTMLElement | null;
  displayAlbumsLength: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
};

export type UseAlbumBrowseScrollRestoreResult = {
  /** True until saved scroll position is applied — hide the grid meanwhile. */
  isScrollRestorePending: boolean;
};

function readPendingScrollRestore(
  serverId: string,
  navigationType: NavigationType,
): PendingScroll | null {
  if (navigationType !== 'POP' || !serverId) return null;
  return peekAlbumBrowseScrollRestore(serverId);
}

/**
 * When returning to All Albums via browser/app back from album detail, restore
 * the in-page grid scroll position saved in `albumBrowseSessionStore`.
 */
export function useAlbumBrowseScrollRestore({
  serverId,
  scrollBodyEl,
  displayAlbumsLength,
  loading,
  loadingMore,
  hasMore,
  loadMore,
}: UseAlbumBrowseScrollRestoreArgs): UseAlbumBrowseScrollRestoreResult {
  const navigationType = useNavigationType();
  const initRef = useRef(false);
  const pendingRef = useRef<PendingScroll | null>(null);
  const doneRef = useRef(false);

  if (!initRef.current) {
    initRef.current = true;
    pendingRef.current = readPendingScrollRestore(serverId, navigationType);
  }

  const [isScrollRestorePending, setIsScrollRestorePending] = useState(
    () => readPendingScrollRestore(serverId, navigationType) !== null,
  );

  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (doneRef.current || !pending) return;
    if (!scrollBodyEl || loading) return;

    const needsMore = displayAlbumsLength < pending.displayCount && hasMore;
    if (needsMore) {
      if (!loadingMore) loadMore();
      return;
    }
    if (loadingMore) return;

    scrollBodyEl.scrollTop = pending.scrollTop;
    scrollBodyEl.dispatchEvent(new Event('scroll', { bubbles: false }));
    pendingRef.current = null;
    doneRef.current = true;
    setIsScrollRestorePending(false);
    useAlbumBrowseSessionStore.getState().clearReturnStash(serverId);
  }, [
    scrollBodyEl,
    displayAlbumsLength,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    serverId,
  ]);

  return { isScrollRestorePending };
}
