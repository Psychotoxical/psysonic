import type { Track, QueueItemRef } from '@/lib/media/trackTypes';
import { useAuthStore } from '@/store/authStore';
import { canonicalQueueServerKey } from '@/lib/server/serverIndexKey';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';

/**
 * Pure server-scope helpers for the shared media model: stamp the owning server
 * onto a Track, and classify queue refs by server profile. No playback-store
 * read, so they live in lib/media next to the Track model. The store-reading
 * queue helpers (queueItemRefAt, filterQueueRefs*) stay in
 * features/playback/utils/playback/trackServerScope and build on these.
 */

/** Active saved-server profile id (auth UUID), when logged in. */
export function activeServerProfileId(): string | undefined {
  return useAuthStore.getState().activeServerId ?? undefined;
}

/**
 * Ensure every track carries an owning server before it enters the queue.
 * Explicit `track.serverId` wins; otherwise `fallbackServerId`, then active server.
 */
export function stampTrackServerId(track: Track, fallbackServerId?: string): Track {
  const serverId = track.serverId ?? fallbackServerId ?? activeServerProfileId();
  if (!serverId || track.serverId === serverId) {
    return serverId && !track.serverId ? { ...track, serverId } : track;
  }
  return { ...track, serverId };
}

export function stampTrackServerIds(tracks: Track[], fallbackServerId?: string): Track[] {
  return tracks.map(t => stampTrackServerId(t, fallbackServerId));
}

/** True when queue refs resolve to more than one server bucket. */
export function isMultiServerQueue(refs: QueueItemRef[]): boolean {
  const keys = new Set<string>();
  for (const ref of refs) {
    if (!ref.serverId) continue;
    keys.add(canonicalQueueServerKey(ref.serverId) || ref.serverId);
    if (keys.size > 1) return true;
  }
  return false;
}

export function profileIdFromQueueRef(ref: QueueItemRef | null | undefined): string {
  if (!ref?.serverId) return '';
  return resolveServerIdForIndexKey(ref.serverId) || ref.serverId;
}
