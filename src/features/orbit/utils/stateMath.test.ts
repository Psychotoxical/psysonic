import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/orbit/store/orbitStore', () => ({
  useOrbitStore: { getState: () => ({ state: null, setState: vi.fn() }) },
}));

import { makeInitialOrbitState, type OrbitQueueItem, type OrbitState } from '@/features/orbit/api/orbit';
import { ORBIT_QUEUE_HISTORY_LIMIT } from '@/features/orbit/utils/constants';
import { applyOutboxSnapshotsToState, type OutboxSnapshot } from '@/features/orbit/utils/stateMath';

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

describe('applyOutboxSnapshotsToState — maxUsers enforcement', () => {
  const NOW = 5_000;
  const fresh = (user: string, trackIds: string[] = []): OutboxSnapshot => ({
    user,
    outboxPlaylistId: `ob-${user}`,
    trackIds,
    lastHeartbeat: NOW,
  });

  function hostState(maxUsers: number, participants: OrbitState['participants']): OrbitState {
    return {
      ...makeInitialOrbitState({ sid: 'aaaa1111', host: 'host', name: 'sesh', maxUsers }),
      participants,
    };
  }

  it('admits at most maxUsers guests, dropping the surplus', () => {
    const state = hostState(2, []);
    const next = applyOutboxSnapshotsToState(
      state,
      [fresh('aaa'), fresh('bbb'), fresh('ccc')],
      NOW,
    );
    // Three guests joined on the same tick; the deterministic username
    // tie-break keeps the first two alphabetically.
    expect(next.participants.map(p => p.user)).toEqual(['aaa', 'bbb']);
  });

  it('never displaces an established participant for a newcomer', () => {
    // `zoe` joined earlier (smaller joinedAt) — she keeps her slot even though
    // her name sorts last.
    const state = hostState(2, [{ user: 'zoe', joinedAt: 1_000, lastHeartbeat: 1_000 }]);
    const next = applyOutboxSnapshotsToState(
      state,
      [fresh('zoe'), fresh('aaa'), fresh('bbb')],
      NOW,
    );
    expect(next.participants.map(p => p.user)).toEqual(['zoe', 'aaa']);
  });

  it('ignores suggestions from an over-cap guest', () => {
    const state = hostState(2, []);
    const next = applyOutboxSnapshotsToState(
      state,
      [fresh('aaa', ['t-a']), fresh('bbb', ['t-b']), fresh('ccc', ['t-c'])],
      NOW,
    );
    const addedTracks = next.queue.map(q => q.trackId);
    expect(addedTracks).toContain('t-a');
    expect(addedTracks).toContain('t-b');
    // ccc is over the cap → not a participant, suggestion ignored.
    expect(addedTracks).not.toContain('t-c');
  });
});
