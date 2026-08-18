import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { canonicalQueueServerKey } from '@/lib/server/serverIndexKey';

/**
 * Strip the `stream:` prefix that some Rust events attach to track ids when
 * they're routed through the HTTP source. Both forms identify the same track,
 * so equality and structural-diff checks need to normalize first.
 */
export function normalizeAnalysisTrackId(trackId?: string | null): string | null {
  if (!trackId) return null;
  if (trackId.startsWith('stream:')) return trackId.slice('stream:'.length);
  return trackId;
}

/** Compare track ids across `stream:` / bare Subsonic forms. */
export function sameQueueTrackId(a: string | undefined | null, b: string | undefined | null): boolean {
  if (a == null || b == null) return false;
  const na = normalizeAnalysisTrackId(a) ?? a;
  const nb = normalizeAnalysisTrackId(b) ?? b;
  return na === nb;
}

function normalizedQueueServerId(serverId?: string | null): string | null {
  if (!serverId) return null;
  return canonicalQueueServerKey(serverId) || serverId;
}

/** Compare full tracks by owner + normalized id, with raw-id fallback for legacy ownerless tracks. */
export function sameQueueTrack(
  a: Pick<Track, 'id' | 'serverId'> | null | undefined,
  b: Pick<Track, 'id' | 'serverId'> | null | undefined,
): boolean {
  if (!a || !b || !sameQueueTrackId(a.id, b.id)) return false;
  const aServerId = normalizedQueueServerId(a.serverId);
  const bServerId = normalizedQueueServerId(b.serverId);
  return !aServerId || !bServerId || aServerId === bServerId;
}

/** Stable mixed-queue identity for in-memory sets and persisted shuffle order. */
export function queueItemIdentityKey(
  item: Pick<QueueItemRef, 'serverId' | 'trackId'>,
): string {
  return queueTrackIdentityKey(item.trackId, item.serverId);
}

export function queueTrackIdentityKey(trackId: string, serverId?: string | null): string {
  return JSON.stringify([
    normalizedQueueServerId(serverId) ?? '',
    normalizeAnalysisTrackId(trackId) ?? trackId,
  ]);
}

/** Accepts legacy raw preload ids while preferring the server-qualified key. */
export function queueTrackIdentityMatches(
  identityOrTrackId: string | null | undefined,
  trackId: string,
  serverId?: string | null,
): boolean {
  if (!identityOrTrackId) return false;
  if (sameQueueTrackId(identityOrTrackId, trackId)) return true;
  return identityOrTrackId === queueTrackIdentityKey(trackId, serverId);
}

/** Match an engine event's raw id to a pending server-qualified preload key. */
export function queueIdentityContainsTrackId(
  identityOrTrackId: string | null | undefined,
  trackId: string,
): boolean {
  if (!identityOrTrackId) return false;
  if (sameQueueTrackId(identityOrTrackId, trackId)) return true;
  const identityTrackId = queueTrackIdFromIdentity(identityOrTrackId);
  return identityTrackId != null && sameQueueTrackId(identityTrackId, trackId);
}

export function queueTrackIdFromIdentity(identityOrTrackId: string): string | null {
  try {
    const parsed = JSON.parse(identityOrTrackId) as unknown;
    return Array.isArray(parsed) && typeof parsed[1] === 'string'
      ? parsed[1]
      : identityOrTrackId;
  } catch {
    return identityOrTrackId;
  }
}

/** Compare a thin queue ref to a resolved track without treating raw ids as global. */
export function queueItemRefMatchesTrack(
  ref: Pick<QueueItemRef, 'serverId' | 'trackId'> | null | undefined,
  track: Pick<Track, 'id' | 'serverId'> | null | undefined,
): boolean {
  if (!ref || !track || !sameQueueTrackId(ref.trackId, track.id)) return false;
  const refServerId = normalizedQueueServerId(ref.serverId);
  const trackServerId = normalizedQueueServerId(track.serverId);
  return !refServerId || !trackServerId || refServerId === trackServerId;
}

/** Prefer the current queue slot, then recover the matching mixed-server owner. */
export function findQueueItemRefForTrack(
  items: QueueItemRef[],
  track: Pick<Track, 'id' | 'serverId'>,
  preferredIndex: number,
): QueueItemRef | undefined {
  const preferred = items[preferredIndex];
  if (queueItemRefMatchesTrack(preferred, track)) return preferred;
  return items.find(ref => queueItemRefMatchesTrack(ref, track));
}

/** Canonical queue ref identity — server + track id (mixed-server safe). */
export function sameQueueItemRef(
  a: Pick<QueueItemRef, 'serverId' | 'trackId'>,
  b: Pick<QueueItemRef, 'serverId' | 'trackId'>,
): boolean {
  return queueItemIdentityKey(a) === queueItemIdentityKey(b);
}

export function findQueueItemRefIndex(
  items: QueueItemRef[],
  ref: Pick<QueueItemRef, 'serverId' | 'trackId'>,
): number {
  return items.findIndex(r => sameQueueItemRef(r, ref));
}

/**
 * Same-length + same-ids check. Used to skip no-op queue rewrites that would
 * otherwise reset selection / scroll / drag-source state in subscribers.
 */
export function queuesStructuralEqual(a: Track[], b: Track[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameQueueTrack(a[i], b[i])) return false;
  }
  return true;
}

/** One-level clone so callers can mutate per-track fields without aliasing state. */
export function shallowCloneQueueTracks(queue: Track[]): Track[] {
  return queue.map(t => ({ ...t }));
}
