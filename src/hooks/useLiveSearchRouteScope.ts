import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { isArtistsBrowsePath } from '../store/artistBrowseSessionStore';
import { useLiveSearchScopeStore } from '../store/liveSearchScopeStore';

/** Activate the Artists scope badge when the browse route is open; clear on leave. */
export function useLiveSearchRouteScope() {
  const location = useLocation();

  useEffect(() => {
    const { scope, setScope, clearScope } = useLiveSearchScopeStore.getState();
    if (isArtistsBrowsePath(location.pathname)) {
      setScope('artists');
    } else if (scope === 'artists') {
      clearScope();
    }
  }, [location.pathname]);
}
