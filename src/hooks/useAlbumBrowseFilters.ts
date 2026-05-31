import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';
import {
  DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
  type AlbumBrowseCompFilter,
  type AlbumBrowseReturnFilters,
  albumBrowseSortForServer,
  isAlbumDetailPath,
  useAlbumBrowseSessionStore,
} from '../store/albumBrowseSessionStore';
import type { AlbumBrowseSort } from '../utils/library/browseTextSearch';
import { shouldRestoreAlbumBrowseSession } from '../utils/navigation/albumDetailNavigation';

function returnFiltersForNavigation(
  serverId: string,
  navigationType: NavigationType,
  locationState: unknown,
): AlbumBrowseReturnFilters {
  if (!shouldRestoreAlbumBrowseSession(navigationType, locationState) || !serverId) {
    return DEFAULT_ALBUM_BROWSE_RETURN_FILTERS;
  }
  return (
    useAlbumBrowseSessionStore.getState().peekReturnStash(serverId)
    ?? DEFAULT_ALBUM_BROWSE_RETURN_FILTERS
  );
}

export type AlbumBrowseScrollSnapshot = {
  scrollTop: number;
  displayCount: number;
};

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
  filtersRef.current = {
    selectedGenres,
    yearFrom,
    yearTo,
    compFilter,
    starredOnly,
    losslessOnly,
  };

  useEffect(() => {
    restoredFromStashRef.current = false;
  }, [serverId]);

  useEffect(() => {
    if (!serverId) return;

    if (shouldRestoreAlbumBrowseSession(navigationType, location.state)) {
      restoredFromStashRef.current = true;
      const restored = useAlbumBrowseSessionStore.getState().peekReturnStash(serverId);
      if (restored) {
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

    useAlbumBrowseSessionStore.getState().clearReturnStash(serverId);
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
        const snapshot = scrollSnapshotRef?.current;
        useAlbumBrowseSessionStore.getState().stashReturnFilters(serverId, {
          ...filtersRef.current,
          scrollTop: snapshot?.scrollTop,
          displayCount: snapshot?.displayCount,
        });
      } else if (path !== '/albums') {
        useAlbumBrowseSessionStore.getState().clearReturnStash(serverId);
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
