import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';
import {
  ALBUMS_INPAGE_SCROLL_VIEWPORT_ID,
  readInpageScrollTop,
} from '@/constants/appScroll';
import {
  DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
  type AlbumBrowseCompFilter,
  type AlbumBrowseReturnFilters,
  type AlbumBrowseSurface,
  albumBrowseSortForServer,
  albumBrowseSurfaceForPath,
  isAlbumDetailPath,
  useAlbumBrowseSessionStore,
} from '@/features/album/store/albumBrowseSessionStore';
import type { AlbumBrowseSort } from '@/lib/library/browseTextSearch';
import { shouldRestoreAlbumBrowseSession } from '@/lib/navigation/albumDetailNavigation';
import { useLiveSearchScopeStore } from '@/store/liveSearchScopeStore';

const ALBUMS_SURFACE: AlbumBrowseSurface = 'albums';

function returnFiltersForNavigation(
  serverId: string,
  navigationType: NavigationType,
  locationState: unknown,
): AlbumBrowseReturnFilters {
  if (!shouldRestoreAlbumBrowseSession(navigationType, locationState) || !serverId) {
    return DEFAULT_ALBUM_BROWSE_RETURN_FILTERS;
  }
  return (
    useAlbumBrowseSessionStore.getState().peekReturnStash(serverId, ALBUMS_SURFACE)
    ?? DEFAULT_ALBUM_BROWSE_RETURN_FILTERS
  );
}

export type AlbumBrowseScrollSnapshot = {
  scrollTop: number;
  displayCount: number;
};

/** Keep scroll snapshot in sync with the in-page viewport (not only on React re-renders). */
export function useAlbumBrowseScrollSnapshotSync(
  snapshotRef: RefObject<AlbumBrowseScrollSnapshot>,
  scrollBodyEl: HTMLElement | null,
  displayCount: number,
): void {
  useEffect(() => {
    snapshotRef.current.displayCount = displayCount;
  }, [displayCount, snapshotRef]);

  useEffect(() => {
    if (!scrollBodyEl) return;
    const syncScrollTop = () => {
      snapshotRef.current.scrollTop = scrollBodyEl.scrollTop;
    };
    syncScrollTop();
    scrollBodyEl.addEventListener('scroll', syncScrollTop, { passive: true });
    return () => scrollBodyEl.removeEventListener('scroll', syncScrollTop);
  }, [scrollBodyEl, snapshotRef]);
}

export function useAlbumBrowseScrollSnapshotRef(
  scrollBodyEl: HTMLElement | null,
  displayCount: number,
): RefObject<AlbumBrowseScrollSnapshot> {
  const snapshotRef = useRef<AlbumBrowseScrollSnapshot>({ scrollTop: 0, displayCount: 0 });
  useAlbumBrowseScrollSnapshotSync(snapshotRef, scrollBodyEl, displayCount);
  return snapshotRef;
}

export function useAlbumBrowseFilters(
  serverId: string,
  scrollSnapshotRef?: RefObject<AlbumBrowseScrollSnapshot>,
) {
  const navigationType = useNavigationType();
  const location = useLocation();
  const sort = useAlbumBrowseSessionStore(s => albumBrowseSortForServer(s.sortByServer, serverId));
  const setBrowseSort = useAlbumBrowseSessionStore(s => s.setSort);

  const [selectedGenres, setSelectedGenres] = useState<string[]>(() =>
    returnFiltersForNavigation(serverId, navigationType, location.state).selectedGenres,
  );
  const [yearFrom, setYearFrom] = useState(() =>
    returnFiltersForNavigation(serverId, navigationType, location.state).yearFrom,
  );
  const [yearTo, setYearTo] = useState(() =>
    returnFiltersForNavigation(serverId, navigationType, location.state).yearTo,
  );
  const [compFilter, setCompFilter] = useState<AlbumBrowseCompFilter>(() =>
    returnFiltersForNavigation(serverId, navigationType, location.state).compFilter,
  );
  const [starredOnly, setStarredOnly] = useState(() =>
    returnFiltersForNavigation(serverId, navigationType, location.state).starredOnly,
  );
  const [losslessOnly, setLosslessOnly] = useState(() =>
    returnFiltersForNavigation(serverId, navigationType, location.state).losslessOnly,
  );

  const filtersRef = useRef<AlbumBrowseReturnFilters>(DEFAULT_ALBUM_BROWSE_RETURN_FILTERS);
  /** Guards against re-reset when `albumBrowseRestore` is cleared from location state. */
  const restoredFromStashRef = useRef(false);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  filtersRef.current = {
    selectedGenres,
    yearFrom,
    yearTo,
    compFilter,
    starredOnly,
    losslessOnly,
    searchQuery: useLiveSearchScopeStore.getState().query,
  };

  useEffect(() => {
    restoredFromStashRef.current = false;
  }, [serverId]);

  useEffect(() => {
    if (!serverId) return;

    if (shouldRestoreAlbumBrowseSession(navigationType, location.state)) {
      restoredFromStashRef.current = true;
      const restored = useAlbumBrowseSessionStore.getState().peekReturnStash(serverId, ALBUMS_SURFACE);
      if (restored) {
        useLiveSearchScopeStore.getState().setQuery(restored.searchQuery ?? '');
        // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedGenres(restored.selectedGenres);
        setYearFrom(restored.yearFrom);
        setYearTo(restored.yearTo);
        setCompFilter(restored.compFilter);
        setStarredOnly(restored.starredOnly);
        setLosslessOnly(restored.losslessOnly);
      }
      return;
    }

    if (restoredFromStashRef.current) return;

    useAlbumBrowseSessionStore.getState().clearReturnStash(serverId, ALBUMS_SURFACE);
    useLiveSearchScopeStore.getState().setQuery('');
    setSelectedGenres([]);
    setYearFrom('');
    setYearTo('');
    setCompFilter('all');
    setStarredOnly(false);
    setLosslessOnly(false);
  }, [serverId, navigationType, location.state]);

  useEffect(() => {
    return () => {
      if (!serverId) return;
      const path = window.location.pathname;
      if (isAlbumDetailPath(path)) {
        // Read at cleanup time on purpose: we want the scroll snapshot as it is
        // at navigation-away. Copying it at effect setup would stash a stale value.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const snapshot = scrollSnapshotRef?.current;
        const scrollTop = Math.max(
          readInpageScrollTop(ALBUMS_INPAGE_SCROLL_VIEWPORT_ID),
          snapshot?.scrollTop ?? 0,
        );
        useAlbumBrowseSessionStore.getState().stashReturnFilters(serverId, ALBUMS_SURFACE, {
          ...filtersRef.current,
          scrollTop,
          displayCount: snapshot?.displayCount,
        });
      } else if (albumBrowseSurfaceForPath(path) !== ALBUMS_SURFACE) {
        useAlbumBrowseSessionStore.getState().clearReturnStash(serverId, ALBUMS_SURFACE);
      }
    };
  }, [serverId, scrollSnapshotRef]);

  const onSortChange = (value: AlbumBrowseSort) => setBrowseSort(serverId, value);

  return {
    sort,
    onSortChange,
    selectedGenres,
    setSelectedGenres,
    yearFrom,
    setYearFrom,
    yearTo,
    setYearTo,
    compFilter,
    setCompFilter,
    starredOnly,
    setStarredOnly,
    losslessOnly,
    setLosslessOnly,
  };
}
