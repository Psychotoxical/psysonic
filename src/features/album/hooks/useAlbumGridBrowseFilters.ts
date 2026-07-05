import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import {
  DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
  type AlbumBrowseReturnFilters,
  type AlbumBrowseSurface,
  albumBrowseSurfaceForPath,
  isAlbumDetailPath,
  useAlbumBrowseSessionStore,
} from '@/features/album/store/albumBrowseSessionStore';
import { shouldRestoreAlbumBrowseSession } from '@/lib/navigation/albumDetailNavigation';
import { useLiveSearchScopeStore } from '@/store/liveSearchScopeStore';
import {
  inpageScrollViewportIdForSurface,
  readInpageScrollTop,
} from '@/constants/appScroll';
import type { AlbumBrowseScrollSnapshot } from '@/features/album/hooks/useAlbumBrowseFilters';

export type AlbumGridBrowseSnapshot = {
  albums: SubsonicAlbum[];
  hasMore: boolean;
};

function sameGenreSelection(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function returnStateForNavigation(
  serverId: string,
  surface: AlbumBrowseSurface,
  navigationType: NavigationType,
  locationState: unknown,
): AlbumBrowseReturnFilters {
  if (!shouldRestoreAlbumBrowseSession(navigationType, locationState) || !serverId) {
    return DEFAULT_ALBUM_BROWSE_RETURN_FILTERS;
  }
  return (
    useAlbumBrowseSessionStore.getState().peekReturnStash(serverId, surface)
    ?? DEFAULT_ALBUM_BROWSE_RETURN_FILTERS
  );
}

/** Genre-filter album grid pages (New Releases, Random Albums) — shared leave-restore. */
export function useAlbumGridBrowseFilters(
  serverId: string,
  surface: AlbumBrowseSurface,
  scrollSnapshotRef?: RefObject<AlbumBrowseScrollSnapshot>,
  gridSnapshotRef?: RefObject<AlbumGridBrowseSnapshot>,
) {
  const navigationType = useNavigationType();
  const location = useLocation();
  const initialState = returnStateForNavigation(serverId, surface, navigationType, location.state);

  const [selectedGenres, setSelectedGenres] = useState<string[]>(() => initialState.selectedGenres);
  const restoredFromStashRef = useRef(false);
  const filtersRef = useRef({ selectedGenres, searchQuery: '' });
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  filtersRef.current = {
    selectedGenres,
    searchQuery: useLiveSearchScopeStore.getState().query,
  };

  useEffect(() => {
    restoredFromStashRef.current = false;
  }, [serverId, surface]);

  useEffect(() => {
    if (!serverId) return;

    if (shouldRestoreAlbumBrowseSession(navigationType, location.state)) {
      restoredFromStashRef.current = true;
      const restored = useAlbumBrowseSessionStore.getState().peekReturnStash(serverId, surface);
      if (restored) {
        useLiveSearchScopeStore.getState().setQuery(restored.searchQuery ?? '');
        if (!sameGenreSelection(restored.selectedGenres, filtersRef.current.selectedGenres)) {
          setSelectedGenres(restored.selectedGenres);
        }
      }
      return;
    }

    if (restoredFromStashRef.current) return;

    useAlbumBrowseSessionStore.getState().clearReturnStash(serverId, surface);
    useLiveSearchScopeStore.getState().setQuery('');
    setSelectedGenres([]);
  }, [serverId, surface, navigationType, location.state]);

  useEffect(() => {
    return () => {
      if (!serverId) return;
      const path = window.location.pathname;
      if (isAlbumDetailPath(path)) {
        // Read at cleanup time on purpose: we want the snapshots as they are at
        // navigation-away. Copying them at effect setup would stash stale values.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const scrollSnapshot = scrollSnapshotRef?.current;
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const gridSnapshot = gridSnapshotRef?.current;
        const viewportId = inpageScrollViewportIdForSurface(surface);
        const scrollTop = Math.max(
          readInpageScrollTop(viewportId),
          scrollSnapshot?.scrollTop ?? 0,
        );
        useAlbumBrowseSessionStore.getState().stashReturnFilters(serverId, surface, {
          ...DEFAULT_ALBUM_BROWSE_RETURN_FILTERS,
          selectedGenres: filtersRef.current.selectedGenres,
          searchQuery: filtersRef.current.searchQuery,
          scrollTop,
          displayCount: gridSnapshot?.albums.length ?? scrollSnapshot?.displayCount,
          albums: gridSnapshot?.albums,
          hasMore: gridSnapshot?.hasMore,
        });
      } else if (albumBrowseSurfaceForPath(path) !== surface) {
        useAlbumBrowseSessionStore.getState().clearReturnStash(serverId, surface);
      }
    };
  }, [serverId, surface, scrollSnapshotRef, gridSnapshotRef]);

  return {
    selectedGenres,
    setSelectedGenres,
    initialAlbums: initialState.albums ?? null,
    initialHasMore: initialState.hasMore,
  };
}
