/**
 * Module-scoped queue undo / redo stack. The interesting behaviours are
 * (a) max-size enforcement, (b) the redo stack being wiped on a fresh undo
 * push, and (c) the scroll-top reader / consumer pair that QueuePanel uses
 * to restore list scroll position after an undo/redo commit.
 */
import type { Track } from '@/lib/media/trackTypes';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';
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
} from '@/features/playback/store/queueUndo';

function track(id: string): Track {
  return { id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100 };
}

// Thin-state: the snapshot reads `queueItems`; the `tracks` arg is a convenience
// for tests — it's lowered to refs (with the currentTrack defaulting to the head).
function state(tracks: Track[], overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    queueItems: toQueueItemRefs('', tracks),
    queueIndex: 0,
    currentTrack: tracks[0] ?? null,
    currentTime: 0,
    progress: 0,
    isPlaying: false,
    queueServerId: null,
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
  it('captures the queue as thin refs and clones currentTrack', () => {
    const original = state([track('a'), track('b')]);
    const snap = queueUndoSnapshotFromState(original);
    expect(snap.currentTrack).not.toBe(original.currentTrack);
    expect(snap.queueItems.map(r => r.trackId)).toEqual(['a', 'b']);
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
    expect(snap?.queueItems[0].trackId).toBe('a');
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
    expect(popQueueUndoSnapshot()?.queueItems[0].trackId).toBe('second');
    expect(popQueueUndoSnapshot()?.queueItems[0].trackId).toBe('first');
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
