import { useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';
import {
  clearGenreDetailReturnStash,
  peekAlbumBrowseScrollRestore,
  peekGenreDetailScrollRestore,
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
  /** Album grid browse surface (All Albums, New Releases, Random Albums). */
  surface?: AlbumBrowseSurface;
  /** Genre detail page — uses genre-scoped stash instead of `surface`. */
  genreName?: string;
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
  surface: AlbumBrowseSurface | undefined,
  genreName: string | undefined,
  navigationType: NavigationType,
  locationState: unknown,
): PendingScroll | null {
  if (!shouldRestoreAlbumBrowseSession(navigationType, locationState) || !serverId) return null;
  if (genreName) return peekGenreDetailScrollRestore(serverId, genreName);
  if (surface) return peekAlbumBrowseScrollRestore(serverId, surface);
  return null;
}

function clearScrollRestoreStash(
  serverId: string,
  surface: AlbumBrowseSurface | undefined,
  genreName: string | undefined,
): void {
  if (genreName) {
    clearGenreDetailReturnStash(serverId, genreName);
    return;
  }
  if (surface) {
    useAlbumBrowseSessionStore.getState().clearReturnStash(serverId, surface);
  }
}

/**
 * When returning to an album grid browse surface via browser/app back from album
 * detail, restore the in-page grid scroll position saved in `albumBrowseSessionStore`.
 */
export function useAlbumBrowseScrollRestore({
  serverId,
  surface,
  genreName,
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
    pendingRef.current = readPendingScrollRestore(
      serverId,
      surface,
      genreName,
      navigationType,
      location.state,
    );
  }

  const [isScrollRestorePending, setIsScrollRestorePending] = useState(
    () => readPendingScrollRestore(serverId, surface, genreName, navigationType, location.state) !== null,
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
    clearScrollRestoreStash(serverId, surface, genreName);
  }, [
    scrollBodyEl,
    displayAlbumsLength,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    serverId,
    surface,
    genreName,
  ]);

  return { isScrollRestorePending };
}
