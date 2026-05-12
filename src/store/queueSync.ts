import { savePlayQueue } from '../api/subsonic';
import { getPlaybackProgressSnapshot } from './playbackProgress';
import { usePlayerStore, type Track } from './playerStore';

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
 * Queues are capped at 1000 ids to match Subsonic's max-length contract.
 * Radio sessions skip persistence (the seed station is restored separately).
 */

const SYNC_DEBOUNCE_MS = 5000;
const QUEUE_ID_LIMIT = 1000;

let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let lastQueueHeartbeatAt = 0;

export function syncQueueToServer(queue: Track[], currentTrack: Track | null, currentTime: number): void {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    syncTimeout = null;
    const ids = queue.slice(0, QUEUE_ID_LIMIT).map(t => t.id);
    const pos = Math.floor(currentTime * 1000);
    savePlayQueue(ids, currentTrack?.id, pos).catch(err => {
      console.error('Failed to sync play queue to server', err);
    });
  }, SYNC_DEBOUNCE_MS);
}

export function flushQueueSyncToServer(queue: Track[], currentTrack: Track | null, currentTime: number): Promise<void> {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  if (!currentTrack || queue.length === 0) return Promise.resolve();
  lastQueueHeartbeatAt = Date.now();
  const ids = queue.slice(0, QUEUE_ID_LIMIT).map(t => t.id);
  const pos = Math.floor(currentTime * 1000);
  return savePlayQueue(ids, currentTrack.id, pos).catch(err => {
    console.error('Failed to flush play queue to server', err);
  });
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
  return flushQueueSyncToServer(s.queue, s.currentTrack, getPlaybackProgressSnapshot().currentTime);
}

/** Test-only: drop the debounce + reset the heartbeat. */
export function _resetQueueSyncForTest(): void {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  lastQueueHeartbeatAt = 0;
}
