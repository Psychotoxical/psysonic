import { useEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { GENRE_DETAIL_INPAGE_SCROLL_VIEWPORT_ID, readInpageScrollTop } from '../constants/appScroll';
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
} from '../store/albumBrowseSessionStore';
import { shouldRestoreAlbumBrowseSession } from '../utils/navigation/albumDetailNavigation';
import type { AlbumBrowseScrollSnapshot } from './useAlbumBrowseFilters';

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
  if (restoreKeyRef.current !== restoreKey) {
    restoreKeyRef.current = restoreKey;
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
    restoreDisplayCount: restoreDisplayCountRef.current,
  };
}
