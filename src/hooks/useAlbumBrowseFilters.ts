import { useEffect, useRef, useState, type RefObject } from 'react';
import { useNavigationType, type NavigationType } from 'react-router-dom';
import {
  DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
  type AlbumBrowseCompFilter,
  type AlbumBrowseReturnFilters,
  albumBrowseSortForServer,
  isAlbumDetailPath,
  useAlbumBrowseSessionStore,
} from '../store/albumBrowseSessionStore';
import type { AlbumBrowseSort } from '../utils/library/browseTextSearch';

function returnFiltersForNavigation(
  serverId: string,
  navigationType: NavigationType,
): AlbumBrowseReturnFilters {
  if (navigationType !== 'POP' || !serverId) return DEFAULT_ALBUM_BROWSE_RETURN_FILTERS;
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
  const sort = useAlbumBrowseSessionStore(s => albumBrowseSortForServer(s.sortByServer, serverId));
  const setBrowseSort = useAlbumBrowseSessionStore(s => s.setSort);

  const [selectedGenres, setSelectedGenres] = useState<string[]>(() =>
    returnFiltersForNavigation(serverId, navigationType).selectedGenres,
  );
  const [yearFrom, setYearFrom] = useState(() =>
    returnFiltersForNavigation(serverId, navigationType).yearFrom,
  );
  const [yearTo, setYearTo] = useState(() =>
    returnFiltersForNavigation(serverId, navigationType).yearTo,
  );
  const [compFilter, setCompFilter] = useState<AlbumBrowseCompFilter>(() =>
    returnFiltersForNavigation(serverId, navigationType).compFilter,
  );
  const [starredOnly, setStarredOnly] = useState(() =>
    returnFiltersForNavigation(serverId, navigationType).starredOnly,
  );
  const [losslessOnly, setLosslessOnly] = useState(() =>
    returnFiltersForNavigation(serverId, navigationType).losslessOnly,
  );

  const filtersRef = useRef<AlbumBrowseReturnFilters>(DEFAULT_ALBUM_BROWSE_RETURN_FILTERS);
  filtersRef.current = {
    selectedGenres,
    yearFrom,
    yearTo,
    compFilter,
    starredOnly,
    losslessOnly,
  };

  useEffect(() => {
    if (!serverId) return;

    if (navigationType === 'POP') {
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

    useAlbumBrowseSessionStore.getState().clearReturnStash(serverId);
    setSelectedGenres([]);
    setYearFrom('');
    setYearTo('');
    setCompFilter('all');
    setStarredOnly(false);
    setLosslessOnly(false);
  }, [serverId, navigationType]);

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
