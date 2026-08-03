import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { navigateToAlbumDetail } from '@/lib/navigation/albumDetailNavigation';
import type { ArtistDetailPathOptions } from '@/lib/navigation/detailServerScope';

/** Navigate to album detail, remembering the current page for the back button. */
export function useNavigateToAlbum() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (albumId: string, opts?: ArtistDetailPathOptions) => {
      navigateToAlbumDetail(navigate, location, albumId, opts);
    },
    [navigate, location],
  );
}
