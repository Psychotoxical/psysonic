import type { Track } from '../../store/playerStoreTypes';
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

/**
 * Same-length + same-ids check. Used to skip no-op queue rewrites that would
 * otherwise reset selection / scroll / drag-source state in subscribers.
 */
export function queuesStructuralEqual(a: Track[], b: Track[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameQueueTrackId(a[i]?.id, b[i]?.id)) return false;
  }
  return true;
}

/** One-level clone so callers can mutate per-track fields without aliasing state. */
export function shallowCloneQueueTracks(queue: Track[]): Track[] {
  return queue.map(t => ({ ...t }));
}
