import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { stampTrackServerId } from '@/lib/media/trackServerScope';
import { canonicalQueueServerKey } from '@/lib/server/serverIndexKey';
import { canonicalizeConfirmedNavidromeId } from '@/lib/server/navidromeCanonicalIds';

export function canonicalizePlaybackTrack(track: Track, fallbackServerId = ''): Track {
  const owner = canonicalQueueServerKey(track.serverId ?? fallbackServerId);
  if (!owner) return track;
  const canonicalize = (value: string): string => canonicalizeConfirmedNavidromeId(owner, value);
  const id = canonicalize(track.id);
  const albumId = canonicalize(track.albumId);
  const artistId = track.artistId ? canonicalize(track.artistId) : track.artistId;
  const coverArt = track.coverArt ? canonicalize(track.coverArt) : track.coverArt;
  const artists = track.artists?.map(artist => ({
    ...artist,
    id: artist.id ? canonicalize(artist.id) : artist.id,
  }));
  if (
    id === track.id
    && albumId === track.albumId
    && artistId === track.artistId
    && coverArt === track.coverArt
    && artists?.every((artist, index) => artist.id === track.artists?.[index]?.id) !== false
  ) return track;
  return { ...track, id, albumId, artistId, coverArt, artists };
}

export function canonicalizeQueueItemRef(ref: QueueItemRef): QueueItemRef {
  const serverId = canonicalQueueServerKey(ref.serverId);
  const trackId = canonicalizeConfirmedNavidromeId(serverId, ref.trackId);
  return serverId === ref.serverId && trackId === ref.trackId ? ref : { ...ref, serverId, trackId };
}

/**
 * Derive thin `QueueItemRef`s from a `Track[]` queue (thin-state). Per-item
 * `serverId` is the canonical server index key — every writer normalizes here
 * so refs are unambiguous across mixed-server queues (same `trackId` on two
 * servers must collide on nothing, since the resolver uses `serverId:trackId`).
 * Queue-only flags are carried through, others omitted to keep the persisted /
 * derived list small. Pure — no store import beyond the canonicalizer, so both
 * `playerStore` (persist) and the resolver bridge can use it without a
 * circular dependency.
 */
export function toQueueItemRefs(serverId: string, queue: Track[]): QueueItemRef[] {
  return queue.map(t => {
    const scoped = stampTrackServerId(t, serverId);
    const canonicalId = canonicalQueueServerKey(scoped.serverId ?? serverId);
    const activeTrack = canonicalizePlaybackTrack(scoped, canonicalId);
    const ref: QueueItemRef = { serverId: canonicalId, trackId: activeTrack.id };
    if (t.autoAdded) ref.autoAdded = true;
    if (t.radioAdded) ref.radioAdded = true;
    if (t.playNextAdded) ref.playNextAdded = true;
    if (t.directStreamUrl) ref.directStreamUrl = t.directStreamUrl;
    if (t.directCoverArtUrl) ref.directCoverArtUrl = t.directCoverArtUrl;
    return ref;
  });
}
