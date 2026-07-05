import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ensurePlaybackServerActive } from '@/features/playback/utils/playback/playbackServer';
import { navigatePathWithAlbumReturnTo } from '@/lib/navigation/albumDetailNavigation';

/** Navigate to library routes for the playing queue — switches to {@link queueServerId} when needed. */
export function usePlaybackLibraryNavigate() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(async (path: string) => {
    await ensurePlaybackServerActive();
    navigatePathWithAlbumReturnTo(navigate, location, path);
  }, [navigate, location]);
}
