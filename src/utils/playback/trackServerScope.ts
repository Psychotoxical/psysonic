import type { QueueItemRef, Track } from '../../store/playerStoreTypes';
import { useAuthStore } from '../../store/authStore';
import { usePlayerStore } from '../../store/playerStore';
import { canonicalQueueServerKey } from '../server/serverIndexKey';
import { resolveServerIdForIndexKey } from '../server/serverLookup';

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

/** Canonical queue ref at `index`, or the currently playing slot. */
export function queueItemRefAt(index?: number): QueueItemRef | null {
  const { queueItems, queueIndex } = usePlayerStore.getState();
  if (!queueItems?.length) return null;
  const idx = index ?? queueIndex;
  if (idx < 0 || idx >= queueItems.length) return null;
  return queueItems[idx] ?? null;
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
