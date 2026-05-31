import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import {
  DEFAULT_ARTIST_BROWSE_RETURN_STATE,
  type ArtistBrowseReturnState,
  type ArtistBrowseViewMode,
  isArtistsBrowsePath,
  useArtistBrowseSessionStore,
} from '../store/artistBrowseSessionStore';
import { isArtistDetailPath } from '../store/albumBrowseSessionStore';
import { shouldRestoreArtistBrowseSession } from '../utils/navigation/albumDetailNavigation';

export type ArtistBrowseScrollSnapshot = {
  scrollTop: number;
  visibleCount: number;
};

function returnStateForNavigation(
  serverId: string,
  navigationType: NavigationType,
  locationState: unknown,
): ArtistBrowseReturnState {
  if (!shouldRestoreArtistBrowseSession(navigationType, locationState) || !serverId) {
    return DEFAULT_ARTIST_BROWSE_RETURN_STATE;
  }
  return (
    useArtistBrowseSessionStore.getState().peekReturnStash(serverId)
    ?? DEFAULT_ARTIST_BROWSE_RETURN_STATE
  );
}

export function useArtistsBrowseFilters(
  serverId: string,
  scrollSnapshotRef?: RefObject<ArtistBrowseScrollSnapshot>,
) {
  const navigationType = useNavigationType();
  const location = useLocation();
  const setShowArtistImages = useAuthStore(s => s.setShowArtistImages);

  const [filter, setFilter] = useState(
    () => returnStateForNavigation(serverId, navigationType, location.state).filter,
  );
  const [letterFilter, setLetterFilter] = useState(
    () => returnStateForNavigation(serverId, navigationType, location.state).letterFilter,
  );
  const [starredOnly, setStarredOnly] = useState(
    () => returnStateForNavigation(serverId, navigationType, location.state).starredOnly,
  );
  const [viewMode, setViewMode] = useState<ArtistBrowseViewMode>(
    () => returnStateForNavigation(serverId, navigationType, location.state).viewMode,
  );

  const browseStateRef = useRef<ArtistBrowseReturnState>(DEFAULT_ARTIST_BROWSE_RETURN_STATE);
  const restoredFromStashRef = useRef(false);
  const showArtistImages = useAuthStore(s => s.showArtistImages);

  browseStateRef.current = {
    filter,
    letterFilter,
    starredOnly,
    viewMode,
    showArtistImages,
  };

  useEffect(() => {
    restoredFromStashRef.current = false;
  }, [serverId]);

  useEffect(() => {
    if (!serverId) return;

    if (shouldRestoreArtistBrowseSession(navigationType, location.state)) {
      restoredFromStashRef.current = true;
      const restored = useArtistBrowseSessionStore.getState().peekReturnStash(serverId);
      if (restored) {
        setFilter(restored.filter);
        setLetterFilter(restored.letterFilter);
        setStarredOnly(restored.starredOnly);
        setViewMode(restored.viewMode);
        setShowArtistImages(restored.showArtistImages);
      }
      return;
    }

    if (restoredFromStashRef.current) return;

    useArtistBrowseSessionStore.getState().clearReturnStash(serverId);
    setFilter('');
    setLetterFilter(DEFAULT_ARTIST_BROWSE_RETURN_STATE.letterFilter);
    setStarredOnly(false);
    setViewMode('grid');
  }, [serverId, navigationType, location.state, setShowArtistImages]);

  useEffect(() => {
    return () => {
      if (!serverId) return;
      const path = window.location.pathname;
      if (isArtistDetailPath(path)) {
        const snapshot = scrollSnapshotRef?.current;
        useArtistBrowseSessionStore.getState().stashReturnState(serverId, {
          ...browseStateRef.current,
          scrollTop: snapshot?.scrollTop,
          visibleCount: snapshot?.visibleCount,
        });
      } else if (!isArtistsBrowsePath(path)) {
        useArtistBrowseSessionStore.getState().clearReturnStash(serverId);
      }
    };
  }, [serverId, scrollSnapshotRef]);

  return {
    filter,
    setFilter,
    letterFilter,
    setLetterFilter,
    starredOnly,
    setStarredOnly,
    viewMode,
    setViewMode,
  };
}
