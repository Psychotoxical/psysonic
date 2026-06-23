import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';
import { isComposerDetailPath } from '../store/albumBrowseSessionStore';
import {
  DEFAULT_COMPOSER_BROWSE_RETURN_STATE,
  type ComposerBrowseReturnState,
  type ComposerBrowseViewMode,
  isComposersBrowsePath,
  useComposerBrowseSessionStore,
} from '../store/composerBrowseSessionStore';
import { shouldRestoreComposerBrowseSession } from '../utils/navigation/albumDetailNavigation';
import { useLiveSearchScopeStore } from '../store/liveSearchScopeStore';

export type ComposerBrowseScrollSnapshot = {
  scrollTop: number;
  visibleCount: number;
};

function returnStateForNavigation(
  serverId: string,
  navigationType: NavigationType,
  locationState: unknown,
): ComposerBrowseReturnState {
  if (!shouldRestoreComposerBrowseSession(navigationType, locationState) || !serverId) {
    return DEFAULT_COMPOSER_BROWSE_RETURN_STATE;
  }
  return (
    useComposerBrowseSessionStore.getState().peekReturnStash(serverId)
    ?? DEFAULT_COMPOSER_BROWSE_RETURN_STATE
  );
}

export function useComposersBrowseFilters(
  serverId: string,
  scrollSnapshotRef?: RefObject<ComposerBrowseScrollSnapshot>,
) {
  const navigationType = useNavigationType();
  const location = useLocation();

  const [letterFilter, setLetterFilter] = useState(
    () => returnStateForNavigation(serverId, navigationType, location.state).letterFilter,
  );
  const [starredOnly, setStarredOnly] = useState(
    () => returnStateForNavigation(serverId, navigationType, location.state).starredOnly,
  );
  const [viewMode, setViewMode] = useState<ComposerBrowseViewMode>(
    () => returnStateForNavigation(serverId, navigationType, location.state).viewMode,
  );

  const browseStateRef = useRef<ComposerBrowseReturnState>(DEFAULT_COMPOSER_BROWSE_RETURN_STATE);
  const restoredFromStashRef = useRef(false);

  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  browseStateRef.current = {
    filter: useLiveSearchScopeStore.getState().query,
    letterFilter,
    starredOnly,
    viewMode,
  };

  useEffect(() => {
    restoredFromStashRef.current = false;
  }, [serverId]);

  useEffect(() => {
    if (!serverId) return;

    if (shouldRestoreComposerBrowseSession(navigationType, location.state)) {
      restoredFromStashRef.current = true;
      const restored = useComposerBrowseSessionStore.getState().peekReturnStash(serverId);
      if (restored) {
        useLiveSearchScopeStore.getState().setQuery(restored.filter);
        // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLetterFilter(restored.letterFilter);
        setStarredOnly(restored.starredOnly);
        setViewMode(restored.viewMode);
      }
      return;
    }

    if (restoredFromStashRef.current) return;

    useComposerBrowseSessionStore.getState().clearReturnStash(serverId);
    useLiveSearchScopeStore.getState().setQuery('');
    setLetterFilter(DEFAULT_COMPOSER_BROWSE_RETURN_STATE.letterFilter);
    setStarredOnly(false);
    setViewMode('grid');
  }, [serverId, navigationType, location.state]);

  useEffect(() => {
    return () => {
      if (!serverId) return;
      const path = window.location.pathname;
      if (isComposerDetailPath(path)) {
        // Read at cleanup time on purpose: we want the scroll snapshot as it is
        // at navigation-away. Copying it at effect setup would stash a stale value.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        const snapshot = scrollSnapshotRef?.current;
        useComposerBrowseSessionStore.getState().stashReturnState(serverId, {
          ...browseStateRef.current,
          scrollTop: snapshot?.scrollTop,
          visibleCount: snapshot?.visibleCount,
        });
      } else if (!isComposersBrowsePath(path)) {
        useComposerBrowseSessionStore.getState().clearReturnStash(serverId);
      }
    };
  }, [serverId, scrollSnapshotRef]);

  return {
    letterFilter,
    setLetterFilter,
    starredOnly,
    setStarredOnly,
    viewMode,
    setViewMode,
  };
}
