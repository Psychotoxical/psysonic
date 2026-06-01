import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { isAlbumsBrowsePath, isNewReleasesBrowsePath } from '../store/albumBrowseSessionStore';
import { isArtistsBrowsePath } from '../store/artistBrowseSessionStore';
import { isTracksBrowsePath } from '../store/advancedSearchSessionStore';
import { useLiveSearchScopeStore } from '../store/liveSearchScopeStore';

/** Activate the browse scope badge when a supported route is open; clear on leave. */
export function useLiveSearchRouteScope() {
  const location = useLocation();

  useEffect(() => {
    const { scope, setScope, clearScope } = useLiveSearchScopeStore.getState();
    const path = location.pathname;

    if (isArtistsBrowsePath(path)) {
      setScope('artists');
    } else if (isAlbumsBrowsePath(path)) {
      setScope('albums');
    } else if (isNewReleasesBrowsePath(path)) {
      setScope('newReleases');
    } else if (isTracksBrowsePath(path)) {
      setScope('tracks');
    } else if (scope != null) {
      clearScope();
    }
  }, [location.pathname]);
}
