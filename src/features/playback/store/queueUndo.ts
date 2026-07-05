import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
/** Hard cap on undo/redo depth — keeps memory bounded for very long sessions. */
export const QUEUE_UNDO_MAX = 32;

export type QueueUndoSnapshot = {
  /** Thin queue refs (thin-state phase 4) — not hydrated `Track[]`, so 32
   *  snapshots of a 50k queue cost refs, not 32×50k full tracks. Rebuilt to a
   *  display `Track[]` through the resolver on restore. */
  queueItems: QueueItemRef[];
  queueIndex: number;
  /** Kept full — one resolved playing track, restored to the engine on undo. */
  currentTrack: Track | null;
  /** Seconds — captured with the snapshot (older entries may omit). */
  currentTime?: number;
  progress?: number;
  isPlaying?: boolean;
  /** Main queue panel list `scrollTop` when the snapshot was taken. */
  queueListScrollTop?: number;
  /** Canonical playback-server identity at snapshot time. Restore uses this
   *  for any ref it has to prepend (e.g. a still-playing track absent from the
   *  snapshot's queue) so a mid-restore server switch can't bind the prepended
   *  ref to the wrong server (B1/H3). Older in-memory entries may omit it;
   *  callers fall back to the live `queueServerId` in that case. */
  queueServerId?: string | null;
};

const queueUndoStack: QueueUndoSnapshot[] = [];
const queueRedoStack: QueueUndoSnapshot[] = [];

/** Test-only: clears module-scoped undo/redo stacks so each test starts clean. */
export function _resetQueueUndoStacksForTest(): void {
  queueUndoStack.length = 0;
  queueRedoStack.length = 0;
}

/** QueuePanel registers a reader so undo snapshots capture list scroll position. */
let queueListScrollTopReader: (() => number | undefined) | null = null;

export function registerQueueListScrollTopReader(reader: (() => number | undefined) | null): void {
  queueListScrollTopReader = reader;
}

function readQueueListScrollTopForUndo(): number | undefined {
  return queueListScrollTopReader?.() ?? undefined;
}

/** Set in applyQueueHistorySnapshot; QueuePanel consumes in useLayoutEffect after commit. */
let pendingQueueListScrollTop: number | undefined;

export function setPendingQueueListScrollTop(value: number): void {
  pendingQueueListScrollTop = value;
}

export function consumePendingQueueListScrollTop(): number | undefined {
  const v = pendingQueueListScrollTop;
  pendingQueueListScrollTop = undefined;
  return v;
}

export function queueUndoSnapshotFromState(s: PlayerState): QueueUndoSnapshot {
  const scrollTop = readQueueListScrollTopForUndo();
  return {
    // Thin refs straight off the canonical list — 32 snapshots cost refs, not
    // 32×50k full tracks (the undo "hidden multiplier" the thin-state plan kills).
    queueItems: [...s.queueItems],
    queueIndex: s.queueIndex,
    currentTrack: s.currentTrack ? { ...s.currentTrack } : null,
    currentTime: s.currentTime,
    progress: s.progress,
    isPlaying: s.isPlaying,
    queueServerId: s.queueServerId,
    ...(scrollTop !== undefined ? { queueListScrollTop: scrollTop } : {}),
  };
}

/**
 * Snapshot the current state onto the undo stack and clear the redo stack —
 * standard "new action invalidates redo history" behaviour. Called from every
 * mutating queue action.
 */
export function pushQueueUndoFromGetter(get: () => PlayerState): void {
  queueRedoStack.length = 0;
  queueUndoStack.push(queueUndoSnapshotFromState(get()));
  while (queueUndoStack.length > QUEUE_UNDO_MAX) queueUndoStack.shift();
}

export function popQueueUndoSnapshot(): QueueUndoSnapshot | undefined {
  return queueUndoStack.pop();
}

export function popQueueRedoSnapshot(): QueueUndoSnapshot | undefined {
  return queueRedoStack.pop();
}

/** Push a prebuilt snapshot onto the redo stack — used after an undo step. */
export function pushQueueRedoSnapshot(snap: QueueUndoSnapshot): void {
  queueRedoStack.push(snap);
  while (queueRedoStack.length > QUEUE_UNDO_MAX) queueRedoStack.shift();
}

/** Push a prebuilt snapshot onto the undo stack — used after a redo step. */
export function pushQueueUndoSnapshot(snap: QueueUndoSnapshot): void {
  queueUndoStack.push(snap);
  while (queueUndoStack.length > QUEUE_UNDO_MAX) queueUndoStack.shift();
}
