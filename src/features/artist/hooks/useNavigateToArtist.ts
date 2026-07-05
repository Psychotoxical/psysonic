import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { navigateToArtistDetail } from '@/lib/navigation/albumDetailNavigation';

/** Navigate to artist detail, remembering the current page for the back button. */
export function useNavigateToArtist() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (artistId: string, opts?: { search?: string }) => {
      navigateToArtistDetail(navigate, location, artistId, opts);
    },
    [navigate, location],
  );
}
