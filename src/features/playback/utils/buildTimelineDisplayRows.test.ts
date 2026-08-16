import { describe, it, expect } from 'vitest';
import {
  buildTimelineDisplayRows,
  buildTimelineQueueFromHistory,
  findTimelineScrollLocalIndex,
} from '@/features/playback/utils/buildTimelineDisplayRows';
import type { QueueItemRef } from '@/lib/media/trackTypes';

const ref = (trackId: string, extra?: Partial<QueueItemRef>): QueueItemRef => ({
  serverId: 's1',
  trackId,
  ...extra,
});

describe('buildTimelineDisplayRows', () => {
  it('orders history, current, and upcoming', () => {
    const rows = buildTimelineDisplayRows({
      historyRefs: [{ serverId: 's1', trackId: 'h1', playedAtMs: 1 }],
      queueItems: [ref('c'), ref('u1'), ref('u2')],
      queueIndex: 0,
    });
    expect(rows.map(r => r.kind)).toEqual([
      'divider', 'history', 'current', 'divider', 'upcoming', 'upcoming',
    ]);
  });

  it('finds current row local index for scroll', () => {
    const rows = buildTimelineDisplayRows({
      historyRefs: [{ serverId: 's1', trackId: 'h1', playedAtMs: 1 }],
      queueItems: [ref('c'), ref('u1')],
      queueIndex: 0,
    });
    expect(findTimelineScrollLocalIndex(rows)).toBe(2);
  });

  it('builds playback order from a selected history occurrence through Up Next', () => {
    const rows = buildTimelineDisplayRows({
      historyRefs: [
        { serverId: 's1', trackId: 'h1', playedAtMs: 1 },
        { serverId: 's2', trackId: 'h2', playedAtMs: 2 },
        { serverId: 's1', trackId: 'h3', playedAtMs: 3 },
      ],
      queueItems: [ref('c'), ref('u1', { playNextAdded: true })],
      queueIndex: 0,
    });

    expect(buildTimelineQueueFromHistory(rows, 2)).toEqual([
      { serverId: 's2', trackId: 'h2' },
      { serverId: 's1', trackId: 'h3' },
      { serverId: 's1', trackId: 'c' },
      { serverId: 's1', trackId: 'u1', playNextAdded: true },
    ]);
  });
});
