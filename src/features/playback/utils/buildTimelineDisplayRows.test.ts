import { describe, it, expect } from 'vitest';
import { buildTimelineDisplayRows, findTimelineScrollLocalIndex } from '@/features/playback/utils/buildTimelineDisplayRows';
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
});
