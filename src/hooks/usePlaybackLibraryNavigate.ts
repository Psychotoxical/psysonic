import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ensurePlaybackServerActive } from '../utils/playback/playbackServer';

/** Navigate to library routes for the playing queue — switches to {@link queueServerId} when needed. */
export function usePlaybackLibraryNavigate() {
  const navigate = useNavigate();
  return useCallback(async (path: string) => {
    await ensurePlaybackServerActive();
    navigate(path);
  }, [navigate]);
}
