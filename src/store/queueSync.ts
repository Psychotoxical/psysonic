import { savePlayQueue } from '../api/subsonicPlayQueue';
import type { QueueItemRef, Track } from './playerStoreTypes';
import { isSubsonicServerReachable } from '../utils/network/subsonicNetworkGuard';
import {
  filterQueueRefsForPlaybackServer,
  getPlaybackServerId,
  playbackProfileIdForTrack,
} from '../utils/playback/playbackServer';
import { filterQueueRefsForServerProfile } from '../utils/playback/trackServerScope';
import { getPlaybackProgressSnapshot } from './playbackProgress';
import { touchQueueMutationClock, isIdleQueuePullSuspended, resumeIdleQueuePull } from './queuePlaybackIdle';
import { usePlayerStore } from './playerStore';

/**
 * Server-side play-queue persistence. Subsonic's `savePlayQueue` accepts
 * the current queue, the active track id, and the position in ms — so the
 * server can hand the same playback state back when the user opens
 * another client.
 *
 * Two flush shapes:
 *  - `syncQueueToServer` debounces for 5 s so rapid edits (drag-reorder,
 *    auto-queue trimming, lucky-mix swaps) collapse into a single roundtrip.
 *  - `flushQueueSyncToServer` cancels the debounce and pushes immediately —
 *    called from the playback heartbeat, `pause()`, and the app-close path
 *    where the user might switch devices mid-track.
 *
 * Mixed-server queues push only refs owned by the playback server.
 * Queues are capped at 1000 ids to match Subsonic's max-length contract.
 * Radio sessions skip persistence (the seed station is restored separately).
 */

const SYNC_DEBOUNCE_MS = 5000;
const QUEUE_ID_LIMIT = 1000;

let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let lastQueueHeartbeatAt = 0;

function isPlaybackServerReachable(): boolean {
  const serverId = getPlaybackServerId();
  return serverId ? isSubsonicServerReachable(serverId) : false;
}

function pushRefsForServer(
  refs: QueueItemRef[],
  currentTrack: Track | null,
  currentTime: number,
  serverId: string,
): Promise<void> {
  if (!serverId || refs.length === 0 || !currentTrack) return Promise.resolve();
  if (playbackProfileIdForTrack(currentTrack) !== serverId) return Promise.resolve();
  const ids = refs.slice(0, QUEUE_ID_LIMIT).map(r => r.trackId);
  const pos = Math.floor(currentTime * 1000);
  return savePlayQueue(ids, currentTrack.id, pos, serverId).catch(() => {
    // Expected when offline or the playback server is unreachable.
  });
}

export function syncQueueToServer(queue: QueueItemRef[], currentTrack: Track | null, currentTime: number): void {
  touchQueueMutationClock();
  if (!isPlaybackServerReachable()) return;
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    syncTimeout = null;
    if (!isPlaybackServerReachable()) return;
    const serverId = getPlaybackServerId();
    const refs = filterQueueRefsForPlaybackServer(queue);
    void pushRefsForServer(refs, currentTrack, currentTime, serverId);
  }, SYNC_DEBOUNCE_MS);
}

export function flushQueueSyncToServer(queue: QueueItemRef[], currentTrack: Track | null, currentTime: number): Promise<void> {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  if (!isPlaybackServerReachable()) return Promise.resolve();
  if (!currentTrack || queue.length === 0) return Promise.resolve();
  lastQueueHeartbeatAt = Date.now();
  const serverId = getPlaybackServerId();
  const refs = filterQueueRefsForPlaybackServer(queue);
  return pushRefsForServer(refs, currentTrack, currentTime, serverId);
}

/**
 * Immediate flush of one server's queue slice (e.g. before browse switch).
 * Does not mutate local player state.
 */
export function flushPlayQueueForServer(serverProfileId: string): Promise<void> {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  if (!serverProfileId || !isSubsonicServerReachable(serverProfileId)) return Promise.resolve();
  const s = usePlayerStore.getState();
  if (s.currentRadio) return Promise.resolve();
  const refs = filterQueueRefsForServerProfile(s.queueItems, serverProfileId);
  if (refs.length === 0 || !s.currentTrack) return Promise.resolve();
  const currentTime = getPlaybackProgressSnapshot().currentTime;
  return pushRefsForServer(refs, s.currentTrack, currentTime, serverProfileId);
}

/** True while a debounced savePlayQueue is scheduled. */
export function hasPendingQueueSync(): boolean {
  return syncTimeout !== null;
}

/** Last heartbeat timestamp (ms epoch). Used by the playback heartbeat to throttle the 15-second auto-flush cadence. */
export function getLastQueueHeartbeatAt(): number {
  return lastQueueHeartbeatAt;
}

/**
 * Flush the current playerStore queue to the server immediately. Skips
 * radio sessions (the seed station is restored separately). Reads the
 * live current-time via the playback-progress snapshot so the position
 * isn't stale by the debounced store commit.
 */
export function flushPlayQueuePosition(): Promise<void> {
  const s = usePlayerStore.getState();
  if (s.currentRadio) return Promise.resolve();
  return flushQueueSyncToServer(s.queueItems, s.currentTrack, getPlaybackProgressSnapshot().currentTime);
}

/**
 * When the user edited the queue while paused, idle pull is suspended (yellow LED).
 * Starting playback makes this client authoritative — push the local queue immediately
 * and re-enable idle auto-pull (blocked anyway while `isPlaying`).
 */
export function pushQueueOnPlaybackStart(
  queue: QueueItemRef[],
  currentTrack: Track | null,
  currentTime: number,
): void {
  if (!currentTrack || queue.length === 0) return;
  if (isIdleQueuePullSuspended()) {
    void flushQueueSyncToServer(queue, currentTrack, currentTime).then(() => {
      resumeIdleQueuePull();
    });
    return;
  }
  syncQueueToServer(queue, currentTrack, currentTime);
}

export function flushLocalQueueWhenTakingPlayback(): Promise<void> {
  if (!isIdleQueuePullSuspended()) return Promise.resolve();
  const s = usePlayerStore.getState();
  if (s.currentRadio || !s.currentTrack || s.queueItems.length === 0) {
    return Promise.resolve();
  }
  return flushQueueSyncToServer(
    s.queueItems,
    s.currentTrack,
    getPlaybackProgressSnapshot().currentTime,
  ).then(() => {
    resumeIdleQueuePull();
  });
}

/** Test-only: drop the debounce + reset the heartbeat. */
export function _resetQueueSyncForTest(): void {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  lastQueueHeartbeatAt = 0;
}
