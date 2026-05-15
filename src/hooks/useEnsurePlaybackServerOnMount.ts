import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import {
  ensurePlaybackServerActive,
  playbackServerDiffersFromActive,
} from '../utils/playback/playbackServer';

/**
 * On Now Playing surfaces, switch the browsed server to {@link queueServerId}
 * before Subsonic fetches run. Returns false while a switch is in flight.
 */
export function useEnsurePlaybackServerOnMount(): boolean {
  const queueServerId = usePlayerStore(s => s.queueServerId);
  const queueLength = usePlayerStore(s => s.queue.length);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const [ready, setReady] = useState(() => !playbackServerDiffersFromActive());

  useEffect(() => {
    if (!playbackServerDiffersFromActive()) {
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    void ensurePlaybackServerActive().then(ok => {
      if (!cancelled) setReady(ok);
    });
    return () => { cancelled = true; };
  }, [queueServerId, queueLength, activeServerId]);

  return ready;
}
