import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { navigateAlbumDetailBack } from '../utils/navigation/albumDetailNavigation';

/** Leave album detail for the page that opened it (or history back as fallback). */
export function useAlbumDetailBack(fallback = '/') {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    () => navigateAlbumDetailBack(navigate, location, fallback),
    [navigate, location, fallback],
  );
}
