import { useEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { GENRE_DETAIL_INPAGE_SCROLL_VIEWPORT_ID, readInpageScrollTop } from '@/constants/appScroll';
import {
  DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
  albumBrowseSortForServer,
  clearGenreDetailReturnStash,
  genreDetailGenreFromPath,
  isAlbumDetailPath,
  isGenreDetailPath,
  peekGenreDetailScrollRestore,
  stashGenreDetailReturnFilters,
  useAlbumBrowseSessionStore,
} from '@/features/album';
import { shouldRestoreAlbumBrowseSession } from '@/lib/navigation/albumDetailNavigation';
import type { AlbumBrowseScrollSnapshot } from '@/features/album';

/** Genre detail: locked genre filter + leave/restore session (same contract as All Albums). */
export function useGenreDetailBrowse(
  serverId: string,
  genreName: string,
  scrollSnapshotRef?: RefObject<AlbumBrowseScrollSnapshot>,
) {
  const navigationType = useNavigationType();
  const location = useLocation();
  const sort = useAlbumBrowseSessionStore(s => albumBrowseSortForServer(s.sortByServer, serverId));
  const restoredFromStashRef = useRef(false);
  const restoreKeyRef = useRef('');
  const restoreDisplayCountRef = useRef<number | undefined>(undefined);
  const restoreKey = `${serverId}:${genreName}`;
  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  if (restoreKeyRef.current !== restoreKey) {
    // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
    // eslint-disable-next-line react-hooks/refs
    restoreKeyRef.current = restoreKey;
    // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
    // eslint-disable-next-line react-hooks/refs
    restoreDisplayCountRef.current = peekGenreDetailScrollRestore(serverId, genreName)?.displayCount;
  }

  useEffect(() => {
    restoredFromStashRef.current = false;
  }, [serverId, genreName]);

  useEffect(() => {
    if (!serverId || !genreName) return;

    if (shouldRestoreAlbumBrowseSession(navigationType, location.state)) {
      restoredFromStashRef.current = true;
      return;
    }

    if (restoredFromStashRef.current) return;

    clearGenreDetailReturnStash(serverId, genreName);
  }, [serverId, genreName, navigationType, location.state]);

  useEffect(() => {
    return () => {
      if (!serverId || !genreName) return;
      const path = window.location.pathname;
      if (isAlbumDetailPath(path)) {
        // Read at cleanup time on purpose: we want the scroll snapshot as it is
        // at navigation-away. Copying it at effect setup would stash a stale value.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const snapshot = scrollSnapshotRef?.current;
        const scrollTop = Math.max(
          readInpageScrollTop(GENRE_DETAIL_INPAGE_SCROLL_VIEWPORT_ID),
          snapshot?.scrollTop ?? 0,
        );
        stashGenreDetailReturnFilters(serverId, genreName, {
          ...DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
          selectedGenres: [genreName],
          scrollTop,
          displayCount: snapshot?.displayCount,
        });
      } else if (!isGenreDetailPath(path) || genreDetailGenreFromPath(path) !== genreName) {
        clearGenreDetailReturnStash(serverId, genreName);
      }
    };
  }, [serverId, genreName, scrollSnapshotRef]);

  return {
    sort,
    // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
    // eslint-disable-next-line react-hooks/refs
    restoreDisplayCount: restoreDisplayCountRef.current,
  };
}
