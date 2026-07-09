import { savePlayQueue } from '@/lib/api/subsonicPlayQueue';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { isSubsonicServerReachable } from '@/lib/network/subsonicNetworkGuard';
import {
  filterQueueRefsForPlaybackServer,
  getPlaybackServerId,
  playbackProfileIdForTrack,
} from '@/features/playback/utils/playback/playbackServer';
import { filterQueueRefsForServerProfile } from '@/features/playback/utils/playback/trackServerScope';
import { getPlaybackProgressSnapshot } from '@/features/playback/store/playbackProgress';
import {
  touchQueueMutationClock,
  isIdleQueuePullSuspended,
  resumeIdleQueuePull,
  markQueuePushFailed,
  clearQueuePushFailed,
  isQueuePushFailed,
  markQueueNaturallyEnded,
} from '@/features/playback/store/queuePlaybackIdle';
import { usePlayerStore } from '@/features/playback/store/playerStore';

/**
 * Server-side play-queue persistence. Subsonic's `savePlayQueue` accepts
 * the current queue, the active track id, and the position in ms — so the
 * server can hand the same playback state back when the user opens
 * another client.
 *
 * Two flush shapes:
 *  - `syncQueueToServer` debounces playback position/queue pushes (track
 *    changes, resume) without blocking idle auto-pull.
 *  - `syncUserQueueMutationToServer` — same debounce plus idle-pull
 *    suspension for user-initiated queue edits.
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

/** @returns true when the server accepted the queue (or there was nothing to push). */
function pushRefsForServer(
  refs: QueueItemRef[],
  currentTrack: Track | null,
  currentTime: number,
  serverId: string,
): Promise<boolean> {
  if (!serverId || refs.length === 0 || !currentTrack) return Promise.resolve(true);
  if (playbackProfileIdForTrack(currentTrack) !== serverId) return Promise.resolve(true);
  const ids = refs.slice(0, QUEUE_ID_LIMIT).map(r => r.trackId);
  const pos = Math.floor(currentTime * 1000);
  return savePlayQueue(ids, currentTrack.id, pos, serverId).then(
    () => {
      // Server accepted the queue: local and server agree, so any prior failed
      // push is resolved and idle auto-pull can safely resume.
      clearQueuePushFailed();
      return true;
    },
    () => {
      // Offline / unreachable / URI-too-long: keep local queue authoritative so
      // idle auto-pull cannot rewind to the last successful server snapshot.
      // Transient and self-clearing (next successful push), and does not light
      // the handoff LED — unlike a user edit's `idleQueuePullSuspended`.
      markQueuePushFailed();
      return false;
    },
  );
}

function scheduleQueueSyncToServer(
  queue: QueueItemRef[],
  currentTrack: Track | null,
  currentTime: number,
): void {
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

/** Debounced push during playback (track advance, resume) — does not suspend idle pull. */
export function syncQueueToServer(queue: QueueItemRef[], currentTrack: Track | null, currentTime: number): void {
  scheduleQueueSyncToServer(queue, currentTrack, currentTime);
}

/** Debounced push after a user queue edit — suspends idle auto-pull until manual sync or Play. */
export function syncUserQueueMutationToServer(
  queue: QueueItemRef[],
  currentTrack: Track | null,
  currentTime: number,
): void {
  touchQueueMutationClock();
  scheduleQueueSyncToServer(queue, currentTrack, currentTime);
}

/** @returns true when the push succeeded (or was a no-op). */
export function flushQueueSyncToServer(
  queue: QueueItemRef[],
  currentTrack: Track | null,
  currentTime: number,
): Promise<boolean> {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  if (!isPlaybackServerReachable()) return Promise.resolve(true);
  if (!currentTrack || queue.length === 0) return Promise.resolve(true);
  lastQueueHeartbeatAt = Date.now();
  const serverId = getPlaybackServerId();
  const refs = filterQueueRefsForPlaybackServer(queue);
  return pushRefsForServer(refs, currentTrack, currentTime, serverId);
}

/**
 * Immediate flush of one server's queue slice (e.g. before browse switch).
 * Does not mutate local player state.
 */
export function flushPlayQueueForServer(serverProfileId: string): Promise<boolean> {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  if (!serverProfileId || !isSubsonicServerReachable(serverProfileId)) return Promise.resolve(true);
  const s = usePlayerStore.getState();
  if (s.currentRadio) return Promise.resolve(true);
  const refs = filterQueueRefsForServerProfile(s.queueItems, serverProfileId);
  if (refs.length === 0 || !s.currentTrack) return Promise.resolve(true);
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
export function flushPlayQueuePosition(): Promise<boolean> {
  const s = usePlayerStore.getState();
  if (s.currentRadio) return Promise.resolve(true);
  return flushQueueSyncToServer(s.queueItems, s.currentTrack, getPlaybackProgressSnapshot().currentTime);
}

/**
 * Queue exhausted (repeat off): push the final track at end-of-file so idle
 * auto-pull does not rewind to an earlier debounced position on the server.
 */
export function finalizePlayQueueAtTrackEnd(
  queue: QueueItemRef[],
  currentTrack: Track,
): Promise<boolean> {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  markQueueNaturallyEnded();
  const endSec = Math.max(0, currentTrack.duration ?? 0);
  return flushQueueSyncToServer(queue, currentTrack, endSec);
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
  if (isIdleQueuePullSuspended() || isQueuePushFailed()) {
    void flushQueueSyncToServer(queue, currentTrack, currentTime).then(ok => {
      if (ok) resumeIdleQueuePull();
    });
    return;
  }
  syncQueueToServer(queue, currentTrack, currentTime);
}

export function flushLocalQueueWhenTakingPlayback(): Promise<void> {
  if (!isIdleQueuePullSuspended() && !isQueuePushFailed()) return Promise.resolve();
  const s = usePlayerStore.getState();
  if (s.currentRadio || !s.currentTrack || s.queueItems.length === 0) {
    return Promise.resolve();
  }
  return flushQueueSyncToServer(
    s.queueItems,
    s.currentTrack,
    getPlaybackProgressSnapshot().currentTime,
  ).then(ok => {
    if (ok) resumeIdleQueuePull();
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
