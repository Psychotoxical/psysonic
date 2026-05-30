import { buildCoverArtFetchUrl } from '../../cover/fetchUrl';
import { resolvePlaybackCoverScope } from '../../cover/ref';
import { coverEntryToRef, resolveAlbumCoverEntry } from '../../cover/resolveEntry';
import { coverStorageKeyFromRef } from '../../cover/storageKeys';
import { resolveCoverDisplayTier } from '../../cover/tiers';
import { useAuthStore } from '../../store/authStore';
import { usePlayerStore } from '../../store/playerStore';
import { switchActiveServer } from '../server/switchActiveServer';
import { sameQueueTrackId } from './queueIdentity';
import type { QueueItemRef, Track } from '../../store/playerStoreTypes';
import { resolveServerIdForIndexKey } from '../server/serverLookup';
import {
  resolveIndexKey,
  serverIndexKeyForProfile,
  serverIndexKeyFromUrl,
} from '../server/serverIndexKey';

/** Server that owns the current queue / stream URLs (may differ from the browsed server). */
export function getPlaybackServerId(): string {
  const { queueServerId, queueItems } = usePlayerStore.getState();
  if ((queueItems?.length ?? 0) > 0 && queueServerId) {
    return resolveServerIdForIndexKey(queueServerId);
  }
  return useAuthStore.getState().activeServerId ?? '';
}

export function getPlaybackIndexKey(): string {
  const { queueServerId, queueItems } = usePlayerStore.getState();
  if ((queueItems?.length ?? 0) > 0 && queueServerId) {
    return resolveIndexKey(queueServerId);
  }
  const activeId = useAuthStore.getState().activeServerId ?? '';
  if (!activeId) return '';
  const server = useAuthStore.getState().servers.find(s => s.id === activeId);
  return server ? serverIndexKeyFromUrl(server.url) || activeId : activeId;
}

/**
 * Canonical cache/storage key for playback-owned artifacts (offline/hot-cache).
 * Falls back to legacy UUID when an indexKey cannot be resolved yet.
 */
export function getPlaybackCacheServerKey(): string {
  const indexKey = getPlaybackIndexKey();
  if (indexKey) return indexKey;
  return getPlaybackServerId();
}

export function bindQueueServerForPlayback(): void {
  const sid = useAuthStore.getState().activeServerId;
  if (!sid) return;
  const server = useAuthStore.getState().servers.find(s => s.id === sid);
  // Canonical index key on writes so mixed-server queues stay unambiguous —
  // every ref/queue-level server identifier follows the same shape that the
  // library index already uses. Falls back to the raw id when the server
  // profile cannot be resolved (e.g. tests with a stubbed auth store).
  const canonical = server ? serverIndexKeyForProfile(server) || sid : sid;
  usePlayerStore.setState({ queueServerId: canonical });
}

/**
 * Bind `queueServerId` via {@link bindQueueServerForPlayback} when it is still
 * null, then return the (now-bound) server identifier. Call this synchronously
 * before any state mutation that adds new tracks to the queue.
 *
 * Without the pin, refs land with an empty server key, {@link seedQueueResolver}
 * skips its store-write, and queue rows render as the resolver placeholder
 * (`…` / 0:00) until something else binds the server (see PR #892). Affects
 * both the manual enqueue mutations and the auto-add paths (infinite-queue
 * top-up, radio top-up).
 *
 * Idempotent: no-op when already pinned. Returns `''` when no active server is
 * available to pin (e.g. unit tests without an authed store).
 */
export function ensureQueueServerPinned(): string {
  if (usePlayerStore.getState().queueServerId == null) {
    bindQueueServerForPlayback();
  }
  return usePlayerStore.getState().queueServerId ?? '';
}

export function clearQueueServerForPlayback(): void {
  usePlayerStore.setState({ queueServerId: null });
}

export function playbackServerDiffersFromActive(): boolean {
  const { queueServerId, queueItems } = usePlayerStore.getState();
  if ((queueItems?.length ?? 0) === 0 || !queueServerId) return false;
  const activeSid = useAuthStore.getState().activeServerId;
  const resolvedQueue = resolveServerIdForIndexKey(queueServerId);
  return !!activeSid && resolvedQueue !== activeSid;
}

/**
 * True when the current queue belongs to another server (or is unpinned legacy
 * state) and a browsed-server mix should clear it before enqueueing new tracks.
 */
export function shouldHandoffQueueToActiveServer(): boolean {
  const activeSid = useAuthStore.getState().activeServerId;
  if (!activeSid) return false;
  const { queueItems, queueServerId } = usePlayerStore.getState();
  if ((queueItems?.length ?? 0) === 0) return false;
  if (!queueServerId) return true;
  return resolveServerIdForIndexKey(queueServerId) !== activeSid;
}

/**
 * Stop playback owned by another server so a new mix on the browsed server
 * can replace the queue (Lucky Mix / similar flows after ConnectionIndicator switch).
 */
export function prepareActiveServerForNewMix(): void {
  if (!shouldHandoffQueueToActiveServer()) return;
  usePlayerStore.getState().clearQueue();
  bindQueueServerForPlayback();
}

/** Switch the browsed server to the queue server when they differ (e.g. artist/album links). */
export async function ensurePlaybackServerActive(): Promise<boolean> {
  if (!playbackServerDiffersFromActive()) return true;
  const playbackSid = getPlaybackServerId();
  const server = useAuthStore.getState().servers.find(s => s.id === playbackSid);
  if (!server) return false;
  return switchActiveServer(server);
}

/** Cover fetch URL + storage key for queue prefetch (displayCssPx = layout CSS px). */
export function playbackCoverArtForAlbum(
  albumId: string,
  coverArt: string,
  displayCssPx: number,
): { src: string; cacheKey: string } {
  const entry = resolveAlbumCoverEntry(albumId, coverArt);
  if (!entry) {
    return playbackCoverArtForId(coverArt, displayCssPx);
  }
  const ref = coverEntryToRef(entry, resolvePlaybackCoverScope());
  const tier = resolveCoverDisplayTier(displayCssPx, { surface: 'sparse' });
  return {
    src: buildCoverArtFetchUrl(ref, tier),
    cacheKey: coverStorageKeyFromRef(ref, tier),
  };
}

/** @deprecated Use {@link playbackCoverArtForAlbum} with album id. */
export function playbackCoverArtForId(coverId: string, displayCssPx: number): { src: string; cacheKey: string } {
  return playbackCoverArtForAlbum(coverId, coverId, displayCssPx);
}

export function shouldBindQueueServerForPlay(
  prevQueue: QueueItemRef[],
  newQueue: Track[],
  explicitQueueArg: Track[] | undefined,
): boolean {
  if (newQueue.length === 0) return false;
  if (prevQueue.length === 0) return true;
  if (explicitQueueArg === undefined) return false;
  if (explicitQueueArg.length !== prevQueue.length) return true;
  return !explicitQueueArg.every((t, i) => sameQueueTrackId(prevQueue[i]?.trackId, t.id));
}
