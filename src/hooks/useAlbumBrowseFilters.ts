import { useEffect, useRef, useState } from 'react';
import { useNavigationType } from 'react-router-dom';
import {
  DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
  type AlbumBrowseCompFilter,
  type AlbumBrowseReturnFilters,
  albumBrowseSortForServer,
  isAlbumDetailPath,
  useAlbumBrowseSessionStore,
} from '../store/albumBrowseSessionStore';
import type { AlbumBrowseSort } from '../utils/library/browseTextSearch';

export function useAlbumBrowseFilters(serverId: string) {
  const navigationType = useNavigationType();
  const sort = useAlbumBrowseSessionStore(s => albumBrowseSortForServer(s.sortByServer, serverId));
  const setBrowseSort = useAlbumBrowseSessionStore(s => s.setSort);

  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [compFilter, setCompFilter] = useState<AlbumBrowseCompFilter>('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const [losslessOnly, setLosslessOnly] = useState(false);

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
        useAlbumBrowseSessionStore.getState().stashReturnFilters(serverId, filtersRef.current);
      } else if (path !== '/albums') {
        useAlbumBrowseSessionStore.getState().clearReturnStash(serverId);
      }
    };
  }, [serverId]);

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
