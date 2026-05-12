/**
 * Module-scoped queue undo / redo stack. The interesting behaviours are
 * (a) max-size enforcement, (b) the redo stack being wiped on a fresh undo
 * push, and (c) the scroll-top reader / consumer pair that QueuePanel uses
 * to restore list scroll position after an undo/redo commit.
 */
import type { PlayerState, Track } from './playerStoreTypes';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  QUEUE_UNDO_MAX,
  _resetQueueUndoStacksForTest,
  consumePendingQueueListScrollTop,
  popQueueRedoSnapshot,
  popQueueUndoSnapshot,
  pushQueueRedoSnapshot,
  pushQueueUndoFromGetter,
  pushQueueUndoSnapshot,
  queueUndoSnapshotFromState,
  registerQueueListScrollTopReader,
  setPendingQueueListScrollTop,
} from './queueUndo';

function track(id: string): Track {
  return { id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100 };
}

function state(queue: Track[], overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    queue,
    queueIndex: 0,
    currentTrack: queue[0] ?? null,
    currentTime: 0,
    progress: 0,
    isPlaying: false,
    ...overrides,
  } as PlayerState;
}

beforeEach(() => {
  _resetQueueUndoStacksForTest();
  registerQueueListScrollTopReader(null);
  // Drain any leftover pending scroll-top
  consumePendingQueueListScrollTop();
});

describe('queueUndoSnapshotFromState', () => {
  it('deep-clones queue tracks and currentTrack', () => {
    const original = state([track('a'), track('b')]);
    const snap = queueUndoSnapshotFromState(original);
    expect(snap.queue).not.toBe(original.queue);
    expect(snap.queue[0]).not.toBe(original.queue[0]);
    expect(snap.currentTrack).not.toBe(original.currentTrack);
    expect(snap.queue.map(t => t.id)).toEqual(['a', 'b']);
  });

  it('preserves currentTrack=null', () => {
    const snap = queueUndoSnapshotFromState(state([]));
    expect(snap.currentTrack).toBeNull();
  });

  it('includes queueListScrollTop only when a reader is registered', () => {
    expect(queueUndoSnapshotFromState(state([track('a')])).queueListScrollTop).toBeUndefined();
    registerQueueListScrollTopReader(() => 240);
    expect(queueUndoSnapshotFromState(state([track('a')])).queueListScrollTop).toBe(240);
  });
});

describe('pushQueueUndoFromGetter', () => {
  it('captures the current state on top of the undo stack', () => {
    pushQueueUndoFromGetter(() => state([track('a')]));
    const snap = popQueueUndoSnapshot();
    expect(snap?.queue[0].id).toBe('a');
  });

  it('wipes the redo stack — a fresh action invalidates redo history', () => {
    pushQueueRedoSnapshot(queueUndoSnapshotFromState(state([track('z')])));
    pushQueueUndoFromGetter(() => state([track('a')]));
    expect(popQueueRedoSnapshot()).toBeUndefined();
  });

  it(`caps the undo stack at QUEUE_UNDO_MAX (=${QUEUE_UNDO_MAX})`, () => {
    for (let i = 0; i < QUEUE_UNDO_MAX + 5; i++) {
      pushQueueUndoFromGetter(() => state([track(`t${i}`)]));
    }
    let depth = 0;
    while (popQueueUndoSnapshot()) depth++;
    expect(depth).toBe(QUEUE_UNDO_MAX);
  });
});

describe('pushQueueUndoSnapshot / pushQueueRedoSnapshot', () => {
  it('respect QUEUE_UNDO_MAX when pushing prebuilt snapshots', () => {
    const snap = queueUndoSnapshotFromState(state([track('a')]));
    for (let i = 0; i < QUEUE_UNDO_MAX + 3; i++) pushQueueRedoSnapshot(snap);
    let depth = 0;
    while (popQueueRedoSnapshot()) depth++;
    expect(depth).toBe(QUEUE_UNDO_MAX);
  });

  it('undo-snapshot push keeps order LIFO', () => {
    pushQueueUndoSnapshot(queueUndoSnapshotFromState(state([track('first')])));
    pushQueueUndoSnapshot(queueUndoSnapshotFromState(state([track('second')])));
    expect(popQueueUndoSnapshot()?.queue[0].id).toBe('second');
    expect(popQueueUndoSnapshot()?.queue[0].id).toBe('first');
  });
});

describe('_resetQueueUndoStacksForTest', () => {
  it('clears both stacks', () => {
    pushQueueUndoFromGetter(() => state([track('a')]));
    pushQueueRedoSnapshot(queueUndoSnapshotFromState(state([track('b')])));
    _resetQueueUndoStacksForTest();
    expect(popQueueUndoSnapshot()).toBeUndefined();
    expect(popQueueRedoSnapshot()).toBeUndefined();
  });
});

describe('pending queue-list scroll-top', () => {
  it('returns undefined when nothing was set', () => {
    expect(consumePendingQueueListScrollTop()).toBeUndefined();
  });

  it('round-trips a stored value once and then drains', () => {
    setPendingQueueListScrollTop(512);
    expect(consumePendingQueueListScrollTop()).toBe(512);
    expect(consumePendingQueueListScrollTop()).toBeUndefined();
  });
});
