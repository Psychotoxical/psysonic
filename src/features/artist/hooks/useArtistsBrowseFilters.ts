import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import {
  DEFAULT_ARTIST_BROWSE_RETURN_STATE,
  type ArtistBrowseReturnState,
  type ArtistBrowseViewMode,
  isArtistsBrowsePath,
  useArtistBrowseSessionStore,
} from '@/features/artist/store/artistBrowseSessionStore';
import type { ArtistCreditMode } from '@/lib/api/library';
import { isArtistDetailPath } from '@/features/album';
import { ALL_SENTINEL } from '@/features/artist/utils/artistsHelpers';
import { shouldRestoreArtistBrowseSession } from '@/lib/navigation/albumDetailNavigation';
import { useLiveSearchScopeStore } from '@/store/liveSearchScopeStore';

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

  const [letterFilter, setLetterFilter] = useState(
    () => returnStateForNavigation(serverId, navigationType, location.state).letterFilter,
  );
  const [starredOnly, setStarredOnlyRaw] = useState(
    () => returnStateForNavigation(serverId, navigationType, location.state).starredOnly,
  );
  const [creditMode, setCreditModeRaw] = useState<ArtistCreditMode>(
    () => returnStateForNavigation(serverId, navigationType, location.state).creditMode,
  );
  const [viewMode, setViewMode] = useState<ArtistBrowseViewMode>(
    () => returnStateForNavigation(serverId, navigationType, location.state).viewMode,
  );

  const browseStateRef = useRef<ArtistBrowseReturnState>(DEFAULT_ARTIST_BROWSE_RETURN_STATE);
  const restoredFromStashRef = useRef(false);
  const showArtistImages = useAuthStore(s => s.showArtistImages);

  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  browseStateRef.current = {
    filter: useLiveSearchScopeStore.getState().query,
    letterFilter,
    starredOnly,
    creditMode,
    viewMode,
    showArtistImages,
  };

  const setCreditMode = (next: ArtistCreditMode) => {
    if (next === creditMode) return;
    setCreditModeRaw(next);
    setLetterFilter(ALL_SENTINEL);
  };

  const setStarredOnly = (next: boolean) => {
    if (next) useLiveSearchScopeStore.getState().setQuery('');
    setStarredOnlyRaw(next);
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
        useLiveSearchScopeStore.getState().setQuery(restored.filter);
        // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLetterFilter(restored.letterFilter);
        setStarredOnlyRaw(restored.starredOnly);
        setCreditModeRaw(restored.creditMode ?? 'album');
        setViewMode(restored.viewMode);
        setShowArtistImages(restored.showArtistImages);
      }
      return;
    }

    if (restoredFromStashRef.current) return;

    useArtistBrowseSessionStore.getState().clearReturnStash(serverId);
    useLiveSearchScopeStore.getState().setQuery('');
    setLetterFilter(DEFAULT_ARTIST_BROWSE_RETURN_STATE.letterFilter);
    setStarredOnlyRaw(false);
    setCreditModeRaw('album');
    setViewMode('grid');
  }, [serverId, navigationType, location.state, setShowArtistImages]);

  useEffect(() => {
    return () => {
      if (!serverId) return;
      const path = window.location.pathname;
      if (isArtistDetailPath(path)) {
        // Read at cleanup time on purpose: we want the scroll snapshot as it is
        // at navigation-away. Copying it at effect setup would stash a stale value.
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
    letterFilter,
    setLetterFilter,
    starredOnly,
    setStarredOnly,
    creditMode,
    setCreditMode,
    viewMode,
    setViewMode,
  };
}
