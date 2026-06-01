import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { isAlbumsBrowsePath, isNewReleasesBrowsePath } from '../store/albumBrowseSessionStore';
import { isArtistsBrowsePath } from '../store/artistBrowseSessionStore';
import { isTracksBrowsePath } from '../store/advancedSearchSessionStore';
import { isComposersBrowsePath } from '../store/composerBrowseSessionStore';
import { useLiveSearchScopeStore } from '../store/liveSearchScopeStore';

/** Keep scope badge in sync with browse routes; clear field text when leaving browse. */
export function syncLiveSearchRouteScope(pathname: string): void {
  const store = useLiveSearchScopeStore.getState();

  if (isArtistsBrowsePath(pathname)) {
    store.setScope('artists');
  } else if (isAlbumsBrowsePath(pathname)) {
    store.setScope('albums');
  } else if (isNewReleasesBrowsePath(pathname)) {
    store.setScope('newReleases');
  } else if (isTracksBrowsePath(pathname)) {
    store.setScope('tracks');
  } else if (isComposersBrowsePath(pathname)) {
    store.setScope('composers');
  } else {
    if (store.scope != null) store.clearScope();
    if (store.query !== '') store.setQuery('');
  }
}

/** Activate the browse scope badge when a supported route is open; clear on leave. */
export function useLiveSearchRouteScope() {
  const location = useLocation();

  useEffect(() => {
    syncLiveSearchRouteScope(location.pathname);
  }, [location.pathname]);
}
