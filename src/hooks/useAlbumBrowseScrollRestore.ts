import { useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';
import {
  peekAlbumBrowseScrollRestore,
  type AlbumBrowseSurface,
  useAlbumBrowseSessionStore,
} from '../store/albumBrowseSessionStore';
import { shouldRestoreAlbumBrowseSession } from '../utils/navigation/albumDetailNavigation';

type PendingScroll = {
  scrollTop: number;
  displayCount: number;
};

export type UseAlbumBrowseScrollRestoreArgs = {
  serverId: string;
  surface: AlbumBrowseSurface;
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
  surface: AlbumBrowseSurface,
  navigationType: NavigationType,
  locationState: unknown,
): PendingScroll | null {
  if (!shouldRestoreAlbumBrowseSession(navigationType, locationState) || !serverId) return null;
  return peekAlbumBrowseScrollRestore(serverId, surface);
}

/**
 * When returning to an album grid browse surface via browser/app back from album
 * detail, restore the in-page grid scroll position saved in `albumBrowseSessionStore`.
 */
export function useAlbumBrowseScrollRestore({
  serverId,
  surface,
  scrollBodyEl,
  displayAlbumsLength,
  loading,
  loadingMore,
  hasMore,
  loadMore,
}: UseAlbumBrowseScrollRestoreArgs): UseAlbumBrowseScrollRestoreResult {
  const navigationType = useNavigationType();
  const location = useLocation();
  const initRef = useRef(false);
  const pendingRef = useRef<PendingScroll | null>(null);
  const doneRef = useRef(false);

  if (!initRef.current) {
    initRef.current = true;
    pendingRef.current = readPendingScrollRestore(serverId, surface, navigationType, location.state);
  }

  const [isScrollRestorePending, setIsScrollRestorePending] = useState(
    () => readPendingScrollRestore(serverId, surface, navigationType, location.state) !== null,
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
    useAlbumBrowseSessionStore.getState().clearReturnStash(serverId, surface);
  }, [
    scrollBodyEl,
    displayAlbumsLength,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    serverId,
    surface,
  ]);

  return { isScrollRestorePending };
}
