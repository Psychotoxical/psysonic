import type { QueueItemRef } from '@/lib/media/trackTypes';
import type { TimelinePlayedRef } from '@/features/playback/store/timelineSessionHistory';

export type TimelineDisplayRow =
  | { kind: 'history'; ref: TimelinePlayedRef; localIndex: number; key: string }
  | { kind: 'divider'; labelKey: 'queue.history' | 'queue.upNext'; localIndex: number; key: string }
  | { kind: 'current'; ref: QueueItemRef; queueIndex: number; localIndex: number; key: string }
  | { kind: 'upcoming'; ref: QueueItemRef; queueIndex: number; localIndex: number; key: string };

export function buildTimelineDisplayRows(args: {
  historyRefs: TimelinePlayedRef[];
  queueItems: QueueItemRef[];
  queueIndex: number;
}): TimelineDisplayRow[] {
  const { historyRefs, queueItems, queueIndex } = args;
  const rows: TimelineDisplayRow[] = [];
  let localIndex = 0;

  if (historyRefs.length > 0) {
    rows.push({
      kind: 'divider',
      labelKey: 'queue.history',
      localIndex: localIndex++,
      key: 'divider-history',
    });
    for (const ref of historyRefs) {
      rows.push({
        kind: 'history',
        ref,
        localIndex: localIndex++,
        key: `history:${ref.serverId}:${ref.trackId}:${ref.playedAtMs}`,
      });
    }
  }

  const currentRef = queueIndex >= 0 && queueIndex < queueItems.length
    ? queueItems[queueIndex]
    : null;
  if (currentRef) {
    rows.push({
      kind: 'current',
      ref: currentRef,
      queueIndex,
      localIndex: localIndex++,
      key: `current:${currentRef.serverId}:${currentRef.trackId}:${queueIndex}`,
    });
  }

  const upcoming = queueIndex >= 0
    ? queueItems.slice(queueIndex + 1)
    : queueItems;
  if (upcoming.length > 0) {
    rows.push({
      kind: 'divider',
      labelKey: 'queue.upNext',
      localIndex: localIndex++,
      key: 'divider-upnext',
    });
    for (let i = 0; i < upcoming.length; i++) {
      const absIdx = queueIndex >= 0 ? queueIndex + 1 + i : i;
      const ref = upcoming[i]!;
      rows.push({
        kind: 'upcoming',
        ref,
        queueIndex: absIdx,
        localIndex: localIndex++,
        key: `upcoming:${ref.serverId}:${ref.trackId}:${absIdx}`,
      });
    }
  }

  return rows;
}

export function findTimelineScrollLocalIndex(rows: TimelineDisplayRow[]): number | null {
  const current = rows.find(r => r.kind === 'current');
  if (current) return current.localIndex;
  const firstUpcoming = rows.find(r => r.kind === 'upcoming');
  return firstUpcoming?.localIndex ?? null;
}
