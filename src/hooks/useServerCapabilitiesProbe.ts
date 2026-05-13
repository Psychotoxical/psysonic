import { useEffect } from 'react';
import { getMusicFolders } from '../api/subsonicLibrary';
import { probeEntityRatingSupport } from '../api/subsonicStarRating';
import { useAuthStore } from '../store/authStore';
import { cleanupOrphanedOrbitPlaylists } from '../utils/orbit';

/**
 * Per-server one-shot probe run after login:
 *  - Fetches the server's music folders (falls back to []).
 *  - Probes which entity types support star ratings (falls back to
 *    `track_only` for old/non-Navidrome servers).
 *  - Sweeps leftover Orbit session / outbox playlists from crashed or
 *    force-closed sessions so they don't pollute the playlist view.
 *
 * Each step is server-scoped — if the user switches servers mid-probe the
 * stale result is dropped.
 */
export function useServerCapabilitiesProbe(): void {
  const isLoggedIn = useAuthStore(s => s.isLoggedIn);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const setMusicFolders = useAuthStore(s => s.setMusicFolders);
  const setEntityRatingSupport = useAuthStore(s => s.setEntityRatingSupport);

  useEffect(() => {
    if (!isLoggedIn || !activeServerId) return;
    const serverAtStart = activeServerId;
    let cancelled = false;
    (async () => {
      const stillThisServer = () => !cancelled && useAuthStore.getState().activeServerId === serverAtStart;
      try {
        const folders = await getMusicFolders();
        if (stillThisServer()) setMusicFolders(folders);
      } catch {
        if (stillThisServer()) setMusicFolders([]);
      }
      try {
        const level = await probeEntityRatingSupport();
        if (stillThisServer()) setEntityRatingSupport(serverAtStart, level);
      } catch {
        if (stillThisServer()) setEntityRatingSupport(serverAtStart, 'track_only');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, activeServerId, setMusicFolders, setEntityRatingSupport]);

  useEffect(() => {
    if (!isLoggedIn || !activeServerId) return;
    void cleanupOrphanedOrbitPlaylists();
  }, [isLoggedIn, activeServerId]);
}
