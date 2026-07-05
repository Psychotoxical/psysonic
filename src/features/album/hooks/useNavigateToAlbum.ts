import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { navigateToAlbumDetail } from '@/lib/navigation/albumDetailNavigation';

/** Navigate to album detail, remembering the current page for the back button. */
export function useNavigateToAlbum() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (albumId: string, opts?: { search?: string }) => {
      navigateToAlbumDetail(navigate, location, albumId, opts);
    },
    [navigate, location],
  );
}
