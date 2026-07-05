import { useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';
import {
  peekComposerBrowseScrollRestore,
  useComposerBrowseSessionStore,
} from '@/features/composers/store/composerBrowseSessionStore';
import { shouldRestoreComposerBrowseSession } from '@/lib/navigation/albumDetailNavigation';

type PendingScroll = {
  scrollTop: number;
  visibleCount: number;
};

export type UseComposersBrowseScrollRestoreArgs = {
  serverId: string;
  scrollBodyEl: HTMLElement | null;
  visibleCount: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
};

export type UseComposersBrowseScrollRestoreResult = {
  isScrollRestorePending: boolean;
};

function readPendingScrollRestore(
  serverId: string,
  navigationType: NavigationType,
  locationState: unknown,
): PendingScroll | null {
  if (!shouldRestoreComposerBrowseSession(navigationType, locationState) || !serverId) return null;
  return peekComposerBrowseScrollRestore(serverId);
}

/** Restore Composers in-page scroll after returning from composer detail. */
export function useComposersBrowseScrollRestore({
  serverId,
  scrollBodyEl,
  visibleCount,
  loading,
  loadingMore,
  hasMore,
  loadMore,
}: UseComposersBrowseScrollRestoreArgs): UseComposersBrowseScrollRestoreResult {
  const navigationType = useNavigationType();
  const location = useLocation();
  const initRef = useRef(false);
  const pendingRef = useRef<PendingScroll | null>(null);
  const doneRef = useRef(false);

  // React Compiler refs rule: ref used as a once-only init guard (checked before first assignment); not render data.
  // eslint-disable-next-line react-hooks/refs
  if (!initRef.current) {
    initRef.current = true;
    // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
    // eslint-disable-next-line react-hooks/refs
    pendingRef.current = readPendingScrollRestore(serverId, navigationType, location.state);
  }

  const [isScrollRestorePending, setIsScrollRestorePending] = useState(
    () => readPendingScrollRestore(serverId, navigationType, location.state) !== null,
  );

  // React Compiler immutability rule: intentional imperative mutation of an external/DOM target inside an effect.
  // eslint-disable-next-line react-hooks/immutability
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (doneRef.current || !pending) return;
    if (!scrollBodyEl || loading) return;

    const needsMore = visibleCount < pending.visibleCount && hasMore;
    if (needsMore) {
      if (!loadingMore) loadMore();
      return;
    }
    if (loadingMore) return;

    // React Compiler immutability rule: intentional imperative mutation of an external/DOM target inside an effect.
    // eslint-disable-next-line react-hooks/immutability
    scrollBodyEl.scrollTop = pending.scrollTop;
    scrollBodyEl.dispatchEvent(new Event('scroll', { bubbles: false }));
    pendingRef.current = null;
    doneRef.current = true;
    // React Compiler set-state-in-effect rule: state set from a DOM/layout measurement.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsScrollRestorePending(false);
    useComposerBrowseSessionStore.getState().clearReturnStash(serverId);
  }, [
    scrollBodyEl,
    visibleCount,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    serverId,
  ]);

  return { isScrollRestorePending };
}
