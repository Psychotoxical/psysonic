import { describe, expect, it } from 'vitest';

import {
  ORBIT_STATE_MAX_BYTES,
  makeInitialOrbitState,
  parseOrbitState,
  type OrbitQueueItem,
  type OrbitState,
} from '@/features/orbit/api/orbit';
import {
  makeCoalescedRunner,
  OrbitStateTooLarge,
  serialiseOrbitState,
  serialiseOrbitStateForWire,
} from '@/features/orbit/utils/helpers';

function baseState(): OrbitState {
  return makeInitialOrbitState({ sid: 'aaaa1111', host: 'host', name: 'sesh' });
}

function makeQueue(n: number): OrbitQueueItem[] {
  // addedAt == index, so "oldest" is the lowest addedAt.
  return Array.from({ length: n }, (_, i) => ({
    trackId: `track-${i}-${'x'.repeat(40)}`,
    addedBy: `user${i % 10}`,
    addedAt: i,
  }));
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

describe('serialiseOrbitStateForWire', () => {
  it('passes a within-budget state through untouched', () => {
    const state = { ...baseState(), queue: makeQueue(5) };
    expect(serialiseOrbitStateForWire(state)).toBe(serialiseOrbitState(state));
  });

  it('trims oldest suggestions until the blob fits the byte budget', () => {
    const state = { ...baseState(), queue: makeQueue(300) };
    // Sanity: the untrimmed state really is over budget.
    expect(() => serialiseOrbitState(state)).toThrow(OrbitStateTooLarge);

    const wire = serialiseOrbitStateForWire(state);
    expect(byteLen(wire)).toBeLessThanOrEqual(ORBIT_STATE_MAX_BYTES);

    const parsed = parseOrbitState(JSON.parse(wire));
    expect(parsed).not.toBeNull();
    const retained = parsed!.queue;
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(300);
    // The dropped entries are the oldest — every retained addedAt is a
    // contiguous suffix ending at the newest (299).
    const addedAts = retained.map(q => q.addedAt);
    expect(Math.max(...addedAts)).toBe(299);
    expect(Math.min(...addedAts)).toBe(300 - retained.length);
  });

  it('falls back to trimming the play queue once history is exhausted', () => {
    const playQueue = Array.from({ length: 400 }, (_, i) => ({
      trackId: `pq-${i}-${'y'.repeat(40)}`,
      addedBy: `user${i % 10}`,
    }));
    const state: OrbitState = { ...baseState(), queue: [], playQueue, playQueueTotal: playQueue.length };
    expect(() => serialiseOrbitState(state)).toThrow(OrbitStateTooLarge);

    const wire = serialiseOrbitStateForWire(state);
    expect(byteLen(wire)).toBeLessThanOrEqual(ORBIT_STATE_MAX_BYTES);
    const parsed = parseOrbitState(JSON.parse(wire));
    expect(parsed!.queue).toEqual([]);
    expect((parsed!.playQueue ?? []).length).toBeLessThan(400);
  });
});

describe('makeCoalescedRunner', () => {
  // Let the microtask queue drain so an awaiting do-while loop can advance.
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

  it('never runs two task bodies concurrently and coalesces mid-flight calls into one rerun', async () => {
    let starts = 0;
    const releases: Array<() => void> = [];
    const task = () => {
      starts++;
      return new Promise<void>(res => { releases.push(res); });
    };
    const run = makeCoalescedRunner(task);

    void run(); // run #1 starts and blocks
    void run(); // in-flight → flags a rerun, no second body
    void run(); // in-flight → still just one pending rerun
    expect(starts).toBe(1);

    releases[0](); // finish #1 → the coalesced rerun fires exactly one more body
    await flush();
    expect(starts).toBe(2);

    releases[1](); // finish #2 → no rerun pending, runner goes idle
    await flush();
    expect(starts).toBe(2);

    void run(); // lock released → a fresh call starts a new body
    expect(starts).toBe(3);
  });
});
