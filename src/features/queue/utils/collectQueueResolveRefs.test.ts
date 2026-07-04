import { describe, it, expect } from 'vitest';
import type { QueueItemRef } from '@/lib/media/trackTypes';
import type { TimelineDisplayRow } from '@/features/playback/utils/buildTimelineDisplayRows';
import { collectQueueResolveRefs } from '@/features/queue/utils/collectQueueResolveRefs';

const ref = (i: number): QueueItemRef => ({ serverId: 's1', trackId: `t${i}` });

describe('collectQueueResolveRefs', () => {
  it('resolves the visible range plus the prefetch window for the plain queue', () => {
    const queue = Array.from({ length: 1000 }, (_, i) => ref(i));
    const refs = collectQueueResolveRefs({
      usingTimeline: false,
      timelineRows: undefined,
      queue,
      firstVisible: 400,
      lastVisible: 410,
    });
    // window = [400-50, 410+200] = [350, 610]
    expect(refs[0]!.trackId).toBe('t350');
    expect(refs[refs.length - 1]!.trackId).toBe('t610');
  });

  it('clamps the window to the queue bounds', () => {
    const queue = Array.from({ length: 20 }, (_, i) => ref(i));
    const refs = collectQueueResolveRefs({
      usingTimeline: false,
      timelineRows: undefined,
      queue,
      firstVisible: 0,
      lastVisible: 5,
    });
    expect(refs).toHaveLength(20);
    expect(refs[0]!.trackId).toBe('t0');
    expect(refs[19]!.trackId).toBe('t19');
  });

  it('returns nothing for an empty queue', () => {
    expect(
      collectQueueResolveRefs({
        usingTimeline: false,
        timelineRows: undefined,
        queue: [],
        firstVisible: 0,
        lastVisible: 0,
      }),
    ).toEqual([]);
  });

  it('skips divider rows and collects track refs in timeline mode', () => {
    const rows: TimelineDisplayRow[] = [
      { kind: 'divider', labelKey: 'queue.history', localIndex: 0, key: 'd1' },
      { kind: 'history', ref: { serverId: 's1', trackId: 'h1', playedAtMs: 1 }, localIndex: 1, key: 'h1' },
      { kind: 'current', ref: ref(0), queueIndex: 0, localIndex: 2, key: 'c' },
      { kind: 'divider', labelKey: 'queue.upNext', localIndex: 3, key: 'd2' },
      { kind: 'upcoming', ref: ref(1), queueIndex: 1, localIndex: 4, key: 'u1' },
      { kind: 'upcoming', ref: ref(2), queueIndex: 2, localIndex: 5, key: 'u2' },
    ];
    const refs = collectQueueResolveRefs({
      usingTimeline: true,
      timelineRows: rows,
      queue: [],
      firstVisible: 0,
      lastVisible: 5,
    });
    expect(refs.map(r => r.trackId)).toEqual(['h1', 't0', 't1', 't2']);
  });
});
