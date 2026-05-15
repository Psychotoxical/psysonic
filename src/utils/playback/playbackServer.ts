import {
  buildCoverArtUrl,
  buildCoverArtUrlForServer,
  coverArtCacheKey,
  coverArtCacheKeyForServer,
} from '../../api/subsonicStreamUrl';
import { useAuthStore } from '../../store/authStore';
import { usePlayerStore } from '../../store/playerStore';
import { switchActiveServer } from '../server/switchActiveServer';
import { sameQueueTrackId } from './queueIdentity';
import type { Track } from '../../store/playerStoreTypes';

/** Server that owns the current queue / stream URLs (may differ from the browsed server). */
export function getPlaybackServerId(): string {
  const { queueServerId, queue } = usePlayerStore.getState();
  if ((queue?.length ?? 0) > 0 && queueServerId) return queueServerId;
  return useAuthStore.getState().activeServerId ?? '';
}

export function bindQueueServerForPlayback(): void {
  const sid = useAuthStore.getState().activeServerId;
  if (!sid) return;
  usePlayerStore.setState({ queueServerId: sid });
}

export function clearQueueServerForPlayback(): void {
  usePlayerStore.setState({ queueServerId: null });
}

export function playbackServerDiffersFromActive(): boolean {
  const { queueServerId, queue } = usePlayerStore.getState();
  if ((queue?.length ?? 0) === 0 || !queueServerId) return false;
  const activeSid = useAuthStore.getState().activeServerId;
  return !!activeSid && queueServerId !== activeSid;
}

/** Switch the browsed server to the queue server when they differ (e.g. artist/album links). */
export async function ensurePlaybackServerActive(): Promise<boolean> {
  if (!playbackServerDiffersFromActive()) return true;
  const playbackSid = getPlaybackServerId();
  const server = useAuthStore.getState().servers.find(s => s.id === playbackSid);
  if (!server) return false;
  return switchActiveServer(server);
}

/** Cover URLs for queue / player UI when playback uses a non-active saved server. */
export function playbackCoverArtForId(coverId: string, size: number): { src: string; cacheKey: string } {
  const playbackSid = getPlaybackServerId();
  const activeSid = useAuthStore.getState().activeServerId;
  if (playbackSid && activeSid && playbackSid !== activeSid) {
    const server = useAuthStore.getState().servers.find(s => s.id === playbackSid);
    if (server) {
      return {
        src: buildCoverArtUrlForServer(server.url, server.username, server.password, coverId, size),
        cacheKey: coverArtCacheKeyForServer(server.id, coverId, size),
      };
    }
  }
  return {
    src: buildCoverArtUrl(coverId, size),
    cacheKey: coverArtCacheKey(coverId, size),
  };
}

export function shouldBindQueueServerForPlay(
  prevQueue: Track[],
  newQueue: Track[],
  explicitQueueArg: Track[] | undefined,
): boolean {
  if (newQueue.length === 0) return false;
  if (prevQueue.length === 0) return true;
  if (explicitQueueArg === undefined) return false;
  if (explicitQueueArg.length !== prevQueue.length) return true;
  return !explicitQueueArg.every((t, i) => sameQueueTrackId(prevQueue[i]?.id, t.id));
}
