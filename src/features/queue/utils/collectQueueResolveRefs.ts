import type { QueueItemRef } from '@/lib/media/trackTypes';

/** Prefetch window around the visible range (mirrors the resolver contract). */
const PREFETCH_BACK = 50;
const PREFETCH_AHEAD = 200;

/**
 * Minimal structural shape of a timeline row for resolution purposes. Kept local
 * (not imported from the playback feature) so this helper stays inside the queue
 * feature's dependency floor; `TimelineDisplayRow` is structurally assignable.
 */
export interface ResolveTimelineRow {
  kind: 'history' | 'divider' | 'current' | 'upcoming';
  ref?: { serverId: string; trackId: string };
}

/**
 * Collect the `QueueItemRef`s to resolve for the queue list's currently visible
 * range plus a prefetch window (queue thin-state). Works for both the plain
 * `queue` display and the `timeline` display (which interleaves history/current/
 * upcoming rows and dividers). Dividers carry no track, so they are skipped.
 */
export function collectQueueResolveRefs(args: {
  usingTimeline: boolean;
  timelineRows: readonly ResolveTimelineRow[] | undefined;
  queue: readonly QueueItemRef[];
  firstVisible: number;
  lastVisible: number;
}): QueueItemRef[] {
  const { usingTimeline, timelineRows, queue, firstVisible, lastVisible } = args;

  if (usingTimeline && timelineRows) {
    const start = Math.max(0, firstVisible - PREFETCH_BACK);
    const end = Math.min(timelineRows.length, lastVisible + PREFETCH_AHEAD + 1);
    const refs: QueueItemRef[] = [];
    for (let i = start; i < end; i++) {
      const row = timelineRows[i];
      if (row && row.kind !== 'divider' && row.ref) {
        refs.push({ serverId: row.ref.serverId, trackId: row.ref.trackId });
      }
    }
    return refs;
  }

  const start = Math.max(0, firstVisible - PREFETCH_BACK);
  const end = Math.min(queue.length, lastVisible + PREFETCH_AHEAD + 1);
  if (end <= start) return [];
  return queue.slice(start, end).map(r => ({ serverId: r.serverId, trackId: r.trackId }));
}
