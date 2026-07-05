import { buildCoverArtFetchUrl } from '@/cover/fetchUrl';
import { resolvePlaybackCoverScope } from '@/cover/ref';
import { coverEntryToRef, resolveAlbumCoverEntry } from '@/cover/resolveEntry';
import { coverStorageKeyFromRef } from '@/cover/storageKeys';
import { resolveCoverDisplayTier } from '@/cover/tiers';
import { useAuthStore } from '@/store/authStore';
import type { ServerProfile } from '@/store/authStoreTypes';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { switchActiveServer } from '@/utils/server/switchActiveServer';
import { sameQueueTrackId } from '@/features/playback/utils/playback/queueIdentity';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { findServerByIdOrIndexKey, resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import {
  canonicalQueueServerKey,
  resolveIndexKey,
  serverIndexKeyForProfile,
  serverIndexKeyFromUrl,
} from '@/lib/server/serverIndexKey';
import {
  activeServerProfileId,
  isMultiServerQueue,
  profileIdFromQueueRef,
  stampTrackServerIds,
} from '@/lib/media/trackServerScope';
import {
  filterQueueRefsForServerProfile,
  queueItemRefAt,
} from '@/features/playback/utils/playback/trackServerScope';

function playbackServerFromRef(ref: QueueItemRef): ServerProfile | undefined {
  const profileId = profileIdFromQueueRef(ref);
  return findServerByIdOrIndexKey(profileId) ?? findServerByIdOrIndexKey(ref.serverId);
}

/** Profile id for the currently playing queue item (mixed-server safe). */
export function getPlaybackServerId(): string {
  const playingRef = queueItemRefAt();
  if (playingRef?.serverId) {
    const server = playbackServerFromRef(playingRef);
    if (server) return server.id;
  }
  const { queueServerId, queueItems } = usePlayerStore.getState();
  if ((queueItems?.length ?? 0) > 0 && queueServerId) {
    const resolved = resolveServerIdForIndexKey(queueServerId);
    const server = findServerByIdOrIndexKey(resolved);
    return server?.id ?? resolved;
  }
  return activeServerProfileId() ?? '';
}

export function getPlaybackIndexKey(): string {
  const playingRef = queueItemRefAt();
  if (playingRef?.serverId) {
    const server = playbackServerFromRef(playingRef);
    if (server) return serverIndexKeyForProfile(server) || server.id;
    return playbackCacheKeyForRef(playingRef);
  }
  const { queueServerId, queueItems } = usePlayerStore.getState();
  if ((queueItems?.length ?? 0) > 0 && queueServerId) {
    return resolveIndexKey(queueServerId);
  }
  const activeId = activeServerProfileId() ?? '';
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
  bindQueueServerId(sid);
}

/** Pin queue playback to an explicit server profile or index key. */
export function bindQueueServerId(serverId: string): void {
  const server = findServerByIdOrIndexKey(serverId);
  const canonical = server
    ? serverIndexKeyForProfile(server) || server.id
    : canonicalQueueServerKey(serverId) || serverId;
  usePlayerStore.setState({ queueServerId: canonical });
}

/**
 * Pin the queue-level server anchor from incoming tracks.
 * Per-item `QueueItemRef.serverId` remains authoritative for mixed-server queues;
 * `queueServerId` is the first track's bucket (legacy hot-cache / sync hints).
 */
export function bindQueueServerForTracks(tracks: Track[]): void {
  const scoped = stampTrackServerIds(tracks);
  const sid = scoped[0]?.serverId ?? activeServerProfileId();
  if (!sid) return;
  bindQueueServerId(sid);
}

export function playbackCacheKeyForRef(ref: QueueItemRef | null | undefined): string {
  if (ref?.serverId) {
    return canonicalQueueServerKey(ref.serverId) || ref.serverId;
  }
  return getPlaybackCacheServerKey();
}

export function playbackProfileIdForRef(ref: QueueItemRef | null | undefined): string {
  const key = playbackCacheKeyForRef(ref);
  if (!key) return getPlaybackServerId();
  return resolveServerIdForIndexKey(key) || key;
}

export function playbackCacheKeyForTrack(
  track: Track,
  ref?: QueueItemRef | null,
): string {
  if (ref?.serverId) return playbackCacheKeyForRef(ref);
  if (track.serverId) {
    return canonicalQueueServerKey(track.serverId) || track.serverId;
  }
  return getPlaybackCacheServerKey();
}

export function playbackProfileIdForTrack(
  track: Track,
  ref?: QueueItemRef | null,
): string {
  const key = playbackCacheKeyForTrack(track, ref);
  return resolveServerIdForIndexKey(key) || key || getPlaybackServerId();
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
export function ensureQueueServerPinned(tracks?: Track[]): string {
  if (usePlayerStore.getState().queueServerId == null) {
    if (tracks?.length) bindQueueServerForTracks(tracks);
    else bindQueueServerForPlayback();
  }
  return usePlayerStore.getState().queueServerId ?? '';
}

export function clearQueueServerForPlayback(): void {
  usePlayerStore.setState({ queueServerId: null });
}

export function playbackServerDiffersFromActive(): boolean {
  const activeSid = activeServerProfileId();
  if (!activeSid) return false;
  const playingRef = queueItemRefAt();
  if (playingRef?.serverId) {
    const playbackSid = getPlaybackServerId();
    return Boolean(playbackSid) && playbackSid !== activeSid;
  }
  const { queueServerId, queueItems } = usePlayerStore.getState();
  if ((queueItems?.length ?? 0) === 0 || !queueServerId) return false;
  return resolveServerIdForIndexKey(queueServerId) !== activeSid;
}

export function queueIsMultiServer(): boolean {
  return isMultiServerQueue(usePlayerStore.getState().queueItems);
}

/** Refs owned by the server that is currently playing (mixed-queue safe). */
export function filterQueueRefsForPlaybackServer(refs: QueueItemRef[]): QueueItemRef[] {
  const playbackSid = getPlaybackServerId();
  if (!playbackSid) return [];
  return filterQueueRefsForServerProfile(refs, playbackSid);
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
