import { describe, expect, it } from 'vitest';

import {
  ORBIT_STATE_MAX_BYTES,
  makeInitialOrbitState,
  parseOrbitState,
  type OrbitQueueItem,
  type OrbitState,
} from '../../api/orbit';
import { OrbitStateTooLarge, serialiseOrbitState, serialiseOrbitStateForWire } from './helpers';

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
