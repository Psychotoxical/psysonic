import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { navigateToArtistDetail } from '@/lib/navigation/albumDetailNavigation';
import type { ArtistDetailPathOptions } from '@/lib/navigation/detailServerScope';

/** Navigate to artist detail, remembering the current page for the back button. */
export function useNavigateToArtist() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (artistId: string, opts?: ArtistDetailPathOptions) => {
      navigateToArtistDetail(navigate, location, artistId, opts);
    },
    [navigate, location],
  );
}
