// Shuffle physically reorders the queue, so the risk is not "is it random" — it
// is whether turning it off puts the queue back. These tests pin the restore:
// the playing track never moves, duplicate track ids do not collapse, and rows
// that appeared while shuffle was on (enqueued, radio top-up) are kept rather
// than dropped on the floor.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItemRef } from '@/lib/media/trackTypes';
import { restoreOriginalOrder, setShuffleOriginalOrder } from './shuffleModeActions';
import { createQueueMutationActions } from './queueMutationActions';

vi.mock('@/features/playback/store/queueSync', () => ({
  syncUserQueueMutationToServer: vi.fn(),
}));
vi.mock('@/features/playback/store/queueUndo', () => ({
  pushQueueUndoFromGetter: vi.fn(),
}));

const ref = (trackId: string): QueueItemRef => ({ serverId: 's1', trackId });
const ids = (items: QueueItemRef[]) => items.map(i => i.trackId);

describe('restoreOriginalOrder', () => {
  it('puts a shuffled queue back into its original order', () => {
    const shuffledQueue = [ref('a'), ref('d'), ref('b'), ref('e'), ref('c')];
    const restored = restoreOriginalOrder(shuffledQueue, ['a', 'b', 'c', 'd', 'e']);
    expect(ids(restored)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('appends rows that joined the queue while shuffle was on', () => {
    // 'x' and 'y' were enqueued (or topped up by radio) after shuffle started,
    // so the remembered order knows nothing about them.
    const current = [ref('c'), ref('x'), ref('a'), ref('y'), ref('b')];
    const restored = restoreOriginalOrder(current, ['a', 'b', 'c']);
    expect(ids(restored)).toEqual(['a', 'b', 'c', 'x', 'y']);
  });

  it('drops ids from the remembered order that are no longer in the queue', () => {
    // 'b' was removed by the user while shuffled.
    const restored = restoreOriginalOrder([ref('c'), ref('a')], ['a', 'b', 'c']);
    expect(ids(restored)).toEqual(['a', 'c']);
  });

  it('keeps every copy of a duplicated track', () => {
    const current = [ref('b'), ref('a'), ref('a')];
    const restored = restoreOriginalOrder(current, ['a', 'b', 'a']);
    expect(ids(restored)).toEqual(['a', 'b', 'a']);
    expect(restored).toHaveLength(3);
  });

  it('never loses or duplicates a row', () => {
    const current = [ref('c'), ref('x'), ref('a'), ref('b')];
    const restored = restoreOriginalOrder(current, ['a', 'b', 'c', 'ghost']);
    expect(restored).toHaveLength(current.length);
    expect(new Set(restored).size).toBe(current.length);
  });

  it('returns the queue unchanged when nothing was remembered', () => {
    const current = [ref('a'), ref('b')];
    expect(ids(restoreOriginalOrder(current, []))).toEqual(['a', 'b']);
  });
});

describe('toggleShuffleMode', () => {
  beforeEach(() => {
    setShuffleOriginalOrder([]);
    window.localStorage.clear();
  });

  /** Minimal player-state stub: only what the action reads and writes. */
  function harness(queue: string[], queueIndex: number, shuffleMode = false) {
    let state = {
      queueItems: queue.map(ref),
      queueIndex,
      shuffleMode,
      currentTrack: queue[queueIndex] ? { id: queue[queueIndex] } : null,
      currentTime: 0,
    };
    const set = (partial: unknown) => {
      const patch = typeof partial === 'function'
        ? (partial as (s: typeof state) => Partial<typeof state>)(state)
        : partial as Partial<typeof state>;
      state = { ...state, ...patch };
    };
    const get = () => state as never;
    const { toggleShuffleMode } = createQueueMutationActions(set as never, get);
    return { toggleShuffleMode, read: () => state };
  }

  it('keeps the playing track in place and shuffles only what is ahead', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic
    const h = harness(['a', 'b', 'c', 'd', 'e'], 1);
    h.toggleShuffleMode();
    const s = h.read();

    expect(s.shuffleMode).toBe(true);
    // Played rows and the current track are untouched...
    expect(ids(s.queueItems).slice(0, 2)).toEqual(['a', 'b']);
    // ...the index still points at the playing track...
    expect(s.queueItems[s.queueIndex].trackId).toBe('b');
    // ...and the rest is a permutation of what was ahead, nothing lost.
    expect(ids(s.queueItems).slice(2).sort()).toEqual(['c', 'd', 'e']);
    random.mockRestore();
  });

  it('restores the original order when switched off, index following the track', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const h = harness(['a', 'b', 'c', 'd', 'e'], 0);
    h.toggleShuffleMode();
    expect(h.read().shuffleMode).toBe(true);

    h.toggleShuffleMode();
    const s = h.read();
    expect(s.shuffleMode).toBe(false);
    expect(ids(s.queueItems)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s.queueItems[s.queueIndex].trackId).toBe('a');
    vi.restoreAllMocks();
  });

  it('flips the mode on an empty queue without touching it', () => {
    const h = harness([], 0);
    h.toggleShuffleMode();
    expect(h.read().shuffleMode).toBe(true);
    expect(h.read().queueItems).toEqual([]);
  });

  it('persists the flag and the original order so it survives a restart', () => {
    const h = harness(['a', 'b', 'c'], 0);
    h.toggleShuffleMode();
    const stored = JSON.parse(window.localStorage.getItem('psysonic_shuffle_mode') ?? '{}');
    expect(stored.enabled).toBe(true);
    expect(stored.originalOrder).toEqual(['a', 'b', 'c']);

    h.toggleShuffleMode();
    expect(window.localStorage.getItem('psysonic_shuffle_mode')).toBeNull();
  });
});
