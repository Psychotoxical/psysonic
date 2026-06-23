import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  navigateAlbumDetailBack,
  readAlbumDetailReturnTo,
} from '../utils/navigation/albumDetailNavigation';

/** Leave album/artist detail for the page that opened it (or history back as fallback). */
export function useAlbumDetailBack(fallback = '/') {
  const navigate = useNavigate();
  const location = useLocation();
  const locationStateRef = useRef(location.state);
  // React Compiler refs rule: ref intentionally read/written outside reactive rendering (once-only init guard or holding the latest value for effects/handlers/cleanup); not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  locationStateRef.current = location.state;

  const goBack = useCallback(
    () => navigateAlbumDetailBack(navigate, location, fallback),
    [navigate, location, fallback],
  );

  useEffect(() => {
    const returnTo = readAlbumDetailReturnTo(locationStateRef.current);
    if (!returnTo) return;

    const trapUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.pushState({ psysonicDetailBackTrap: true }, '', trapUrl);

    const onPopState = () => {
      navigateAlbumDetailBack(
        navigate,
        { state: locationStateRef.current },
        fallback,
      );
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [navigate, location.pathname, location.search, location.hash, fallback]);

  return goBack;
}
