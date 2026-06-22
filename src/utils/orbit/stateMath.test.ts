import { describe, expect, it, vi } from 'vitest';

vi.mock('../../store/orbitStore', () => ({
  useOrbitStore: { getState: () => ({ state: null, setState: vi.fn() }) },
}));

import { makeInitialOrbitState, type OrbitQueueItem, type OrbitState } from '../../api/orbit';
import { ORBIT_QUEUE_HISTORY_LIMIT } from './constants';
import { applyOutboxSnapshotsToState, type OutboxSnapshot } from './stateMath';

function stateWithQueue(queue: OrbitQueueItem[]): OrbitState {
  return { ...makeInitialOrbitState({ sid: 'aaaa1111', host: 'host', name: 'sesh' }), queue };
}

describe('applyOutboxSnapshotsToState — queue history cap', () => {
  it('drops the oldest entries when new suggestions push past the limit', () => {
    // A full history (addedAt 0…limit-1) plus 10 brand-new suggestions.
    const existing: OrbitQueueItem[] = Array.from({ length: ORBIT_QUEUE_HISTORY_LIMIT }, (_, i) => ({
      trackId: `old-${i}`,
      addedBy: 'old',
      addedAt: i,
    }));
    const state = stateWithQueue(existing);
    const now = 1_000_000;
    const snapshots: OutboxSnapshot[] = [
      {
        user: 'bob',
        outboxPlaylistId: 'ob',
        trackIds: Array.from({ length: 10 }, (_, i) => `new-${i}`),
        lastHeartbeat: now,
      },
    ];

    const next = applyOutboxSnapshotsToState(state, snapshots, now);

    expect(next.queue.length).toBe(ORBIT_QUEUE_HISTORY_LIMIT);
    // All 10 new suggestions survive…
    for (let i = 0; i < 10; i++) {
      expect(next.queue.some(q => q.trackId === `new-${i}`)).toBe(true);
    }
    // …and the 10 oldest were evicted.
    for (let i = 0; i < 10; i++) {
      expect(next.queue.some(q => q.trackId === `old-${i}`)).toBe(false);
    }
    // The youngest retained "old" entries are still present.
    expect(next.queue.some(q => q.trackId === `old-${ORBIT_QUEUE_HISTORY_LIMIT - 1}`)).toBe(true);
  });

  it('leaves a sub-limit queue untouched', () => {
    const state = stateWithQueue([{ trackId: 't0', addedBy: 'old', addedAt: 0 }]);
    const now = 1_000_000;
    const next = applyOutboxSnapshotsToState(
      state,
      [{ user: 'bob', outboxPlaylistId: 'ob', trackIds: ['t1'], lastHeartbeat: now }],
      now,
    );
    expect(next.queue.map(q => q.trackId)).toEqual(['t0', 't1']);
  });
});
