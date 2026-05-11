/**
 * Queue-mutation characterization for `playerStore` (Phase F1 / PR 2a).
 *
 * Covers public queue actions — `enqueue`, `enqueueAt`, `playNext`,
 * `clearQueue`, `reorderQueue`, `removeTrack`, plus the undo/redo flow.
 * The queue-undo stack lives at module scope (outside the Zustand state),
 * so each test drains it before exercising — see `resetForQueueTest`.
 *
 * Playback actions (`play`, `pause`, `seek`, `next`, `previous`, repeat /
 * shuffle modes) live in PR 2b.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `playerStore` pulls `savePlayQueue` from `@/api/subsonic`, which talks to a
// real server. Override only what the queue path touches; everything else
// stays as the actual module so unrelated imports don't break.
vi.mock('@/api/subsonic', async () => {
  const actual = await vi.importActual<typeof import('@/api/subsonic')>('@/api/subsonic');
  return {
    ...actual,
    savePlayQueue: vi.fn(async () => undefined),
    getPlayQueue: vi.fn(async () => ({ songs: [], current: undefined, position: 0 })),
    buildStreamUrl: vi.fn((id: string) => `https://mock/stream/${id}`),
  };
});

// `enqueue` / `enqueueAt` call `orbitBulkGuard` for multi-track inserts when
// the caller hasn't pre-confirmed. Force the guard to short-circuit through.
vi.mock('@/utils/orbitBulkGuard', () => ({
  orbitBulkGuard: vi.fn(async () => true),
}));

import { usePlayerStore } from './playerStore';
import { onInvoke } from '@/test/mocks/tauri';
import { resetPlayerStore } from '@/test/helpers/storeReset';
import { makeTrack, makeTracks } from '@/test/helpers/factories';

beforeEach(() => {
  resetPlayerStore();
  // `clearQueue` fires `invoke('audio_stop')`; every queue mutation triggers a
  // debounced `syncQueueToServer` we don't need to advance.
  onInvoke('audio_stop', () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('enqueue', () => {
  it('appends a single track to an empty queue', () => {
    const t1 = makeTrack({ id: 't1' });
    usePlayerStore.getState().enqueue([t1], true);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(['t1']);
  });

  it('appends multiple tracks in order', () => {
    const tracks = makeTracks(3);
    usePlayerStore.getState().enqueue(tracks, true);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(tracks.map(t => t.id));
  });

  it('inserts before the first upcoming auto-added separator', () => {
    const head = makeTrack({ id: 'head' });
    const auto = makeTrack({ id: 'auto', autoAdded: true });
    const tail = makeTrack({ id: 'tail', autoAdded: true });
    usePlayerStore.setState({ queue: [head, auto, tail], queueIndex: 0 });
    const incoming = makeTrack({ id: 'new' });
    usePlayerStore.getState().enqueue([incoming], true);
    // Insert lands between `head` (the currently-playing one) and the first
    // auto-added track, so the auto-added group stays at the tail.
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(['head', 'new', 'auto', 'tail']);
  });

  it('appends at the end when there are no auto-added tracks after the cursor', () => {
    const head = makeTrack({ id: 'head' });
    const mid  = makeTrack({ id: 'mid' });
    usePlayerStore.setState({ queue: [head, mid], queueIndex: 0 });
    usePlayerStore.getState().enqueue([makeTrack({ id: 'tail' })], true);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(['head', 'mid', 'tail']);
  });

  it('ignores auto-added separators that already passed (behind the cursor)', () => {
    const past = makeTrack({ id: 'past', autoAdded: true });
    const current = makeTrack({ id: 'current' });
    usePlayerStore.setState({ queue: [past, current], queueIndex: 1 });
    usePlayerStore.getState().enqueue([makeTrack({ id: 'new' })], true);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(['past', 'current', 'new']);
  });
});

describe('enqueueAt', () => {
  it('inserts at the given index', () => {
    const queue = makeTracks(3);
    usePlayerStore.setState({ queue, queueIndex: 0 });
    const ins = makeTrack({ id: 'ins' });
    usePlayerStore.getState().enqueueAt([ins], 2, true);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([queue[0].id, queue[1].id, 'ins', queue[2].id]);
  });

  it('shifts queueIndex forward when inserting at or before the cursor', () => {
    const queue = makeTracks(3);
    usePlayerStore.setState({ queue, queueIndex: 2 });
    usePlayerStore.getState().enqueueAt([makeTrack({ id: 'a' }), makeTrack({ id: 'b' })], 1, true);
    // Two tracks inserted at idx 1 → cursor (was 2) moves to 4.
    expect(usePlayerStore.getState().queueIndex).toBe(4);
  });

  it('keeps queueIndex when inserting after the cursor', () => {
    const queue = makeTracks(3);
    usePlayerStore.setState({ queue, queueIndex: 1 });
    usePlayerStore.getState().enqueueAt([makeTrack({ id: 'a' })], 3, true);
    expect(usePlayerStore.getState().queueIndex).toBe(1);
  });

  it('clamps a negative insertIndex to 0', () => {
    const queue = makeTracks(2);
    usePlayerStore.setState({ queue, queueIndex: 0 });
    usePlayerStore.getState().enqueueAt([makeTrack({ id: 'front' })], -5, true);
    expect(usePlayerStore.getState().queue[0].id).toBe('front');
  });

  it('clamps an over-large insertIndex to the queue length', () => {
    const queue = makeTracks(2);
    usePlayerStore.setState({ queue, queueIndex: 0 });
    usePlayerStore.getState().enqueueAt([makeTrack({ id: 'back' })], 99, true);
    const q = usePlayerStore.getState().queue;
    expect(q[q.length - 1].id).toBe('back');
  });
});

describe('playNext', () => {
  it('tags inserted tracks with playNextAdded', () => {
    const queue = makeTracks(2);
    usePlayerStore.setState({ queue, queueIndex: 0, currentTrack: queue[0] });
    usePlayerStore.getState().playNext([makeTrack({ id: 'pn' })]);
    const inserted = usePlayerStore.getState().queue.find(t => t.id === 'pn');
    expect(inserted?.playNextAdded).toBe(true);
  });

  it('inserts immediately after the current track', () => {
    const a = makeTrack({ id: 'a' });
    const b = makeTrack({ id: 'b' });
    usePlayerStore.setState({ queue: [a, b], queueIndex: 0, currentTrack: a });
    usePlayerStore.getState().playNext([makeTrack({ id: 'pn' })]);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(['a', 'pn', 'b']);
  });

  it('returns early on an empty input list', () => {
    const queue = makeTracks(2);
    usePlayerStore.setState({ queue, queueIndex: 0, currentTrack: queue[0] });
    usePlayerStore.getState().playNext([]);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual(queue.map(t => t.id));
  });
});

describe('clearQueue', () => {
  it('empties the queue and resets playback bookkeeping', () => {
    const tracks = makeTracks(3);
    usePlayerStore.setState({
      queue: tracks,
      queueIndex: 1,
      currentTrack: tracks[1],
      isPlaying: true,
      progress: 0.5,
      currentTime: 42,
      buffered: 0.8,
    });
    usePlayerStore.getState().clearQueue();
    const s = usePlayerStore.getState();
    expect(s.queue).toEqual([]);
    expect(s.queueIndex).toBe(0);
    expect(s.currentTrack).toBeNull();
    expect(s.isPlaying).toBe(false);
    expect(s.progress).toBe(0);
    expect(s.currentTime).toBe(0);
    expect(s.buffered).toBe(0);
  });

  it('calls audio_stop on the engine', () => {
    const stop = vi.fn(() => undefined);
    onInvoke('audio_stop', stop);
    usePlayerStore.setState({ queue: makeTracks(2), queueIndex: 0 });
    usePlayerStore.getState().clearQueue();
    expect(stop).toHaveBeenCalled();
  });
});

describe('reorderQueue', () => {
  it('moves a track from startIndex to endIndex', () => {
    const [a, b, c, d] = makeTracks(4);
    usePlayerStore.setState({ queue: [a, b, c, d], queueIndex: 0 });
    usePlayerStore.getState().reorderQueue(1, 3); // b → after d
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([a.id, c.id, d.id, b.id]);
  });

  it('preserves queueIndex by following the current track id, not the slot', () => {
    const [a, b, c] = makeTracks(3);
    usePlayerStore.setState({ queue: [a, b, c], queueIndex: 1, currentTrack: b });
    usePlayerStore.getState().reorderQueue(1, 2); // b moves to the end
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([a.id, c.id, b.id]);
    expect(usePlayerStore.getState().queueIndex).toBe(2); // followed `b`
  });

  it('keeps queueIndex when the current track is unaffected by the move', () => {
    const [a, b, c] = makeTracks(3);
    usePlayerStore.setState({ queue: [a, b, c], queueIndex: 1, currentTrack: b });
    usePlayerStore.getState().reorderQueue(0, 2); // a moves to the end
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([b.id, c.id, a.id]);
    expect(usePlayerStore.getState().queueIndex).toBe(0); // followed `b`
  });
});

describe('removeTrack', () => {
  it('removes the track at the given index', () => {
    const tracks = makeTracks(3);
    usePlayerStore.setState({ queue: tracks, queueIndex: 0 });
    usePlayerStore.getState().removeTrack(1);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([tracks[0].id, tracks[2].id]);
  });

  it('clamps queueIndex when the removal makes the queue shorter than the cursor', () => {
    const tracks = makeTracks(3);
    usePlayerStore.setState({ queue: tracks, queueIndex: 2 });
    usePlayerStore.getState().removeTrack(2);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([tracks[0].id, tracks[1].id]);
    expect(usePlayerStore.getState().queueIndex).toBe(1);
  });

  it('keeps queueIndex when removing a track after the cursor', () => {
    const tracks = makeTracks(4);
    usePlayerStore.setState({ queue: tracks, queueIndex: 1 });
    usePlayerStore.getState().removeTrack(3);
    expect(usePlayerStore.getState().queueIndex).toBe(1);
  });
});

describe('undo / redo', () => {
  it('returns false on undo when the history is empty', () => {
    expect(usePlayerStore.getState().undoLastQueueEdit()).toBe(false);
  });

  it('returns false on redo when the redo stack is empty', () => {
    expect(usePlayerStore.getState().redoLastQueueEdit()).toBe(false);
  });

  it('rolls back the most recent destructive edit', () => {
    const seed = makeTracks(2);
    usePlayerStore.setState({ queue: seed, queueIndex: 0, currentTrack: seed[0] });
    usePlayerStore.getState().enqueue([makeTrack({ id: 'add' })], true);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([seed[0].id, seed[1].id, 'add']);

    const undone = usePlayerStore.getState().undoLastQueueEdit();
    expect(undone).toBe(true);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([seed[0].id, seed[1].id]);
  });

  it('replays the undone edit via redo', () => {
    const seed = makeTracks(2);
    usePlayerStore.setState({ queue: seed, queueIndex: 0, currentTrack: seed[0] });
    usePlayerStore.getState().removeTrack(1);
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([seed[0].id]);

    usePlayerStore.getState().undoLastQueueEdit();
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([seed[0].id, seed[1].id]);

    usePlayerStore.getState().redoLastQueueEdit();
    expect(usePlayerStore.getState().queue.map(t => t.id)).toEqual([seed[0].id]);
  });

  it('a new edit drops any pending redo (Word-style history)', () => {
    const seed = makeTracks(3);
    usePlayerStore.setState({ queue: seed, queueIndex: 0, currentTrack: seed[0] });

    usePlayerStore.getState().removeTrack(2);          // edit A: [s0, s1]
    usePlayerStore.getState().undoLastQueueEdit();      //          [s0, s1, s2]
    expect(usePlayerStore.getState().queue).toHaveLength(3);

    usePlayerStore.getState().removeTrack(1);          // edit B drops the pending redo

    expect(usePlayerStore.getState().redoLastQueueEdit()).toBe(false);
  });
});
