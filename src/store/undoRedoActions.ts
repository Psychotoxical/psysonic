import { applyQueueHistorySnapshot } from './applyQueueHistorySnapshot';
import type { PlayerState } from './playerStoreTypes';
import {
  popQueueRedoSnapshot,
  popQueueUndoSnapshot,
  pushQueueRedoSnapshot,
  pushQueueUndoSnapshot,
  queueUndoSnapshotFromState,
} from './queueUndo';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Undo / redo wrappers for queue edits. Both pop the matching history
 * snapshot, push the *prior* state onto the opposite stack so the next
 * call reverses direction, and delegate the actual state reconciliation
 * to `applyQueueHistorySnapshot`.
 */
export function createUndoRedoActions(set: SetState, get: GetState): Pick<
  PlayerState,
  'undoLastQueueEdit' | 'redoLastQueueEdit'
> {
  return {
    undoLastQueueEdit: () => {
      const prior = get();
      const snap = popQueueUndoSnapshot();
      if (!snap) return false;
      pushQueueRedoSnapshot(queueUndoSnapshotFromState(prior));
      return applyQueueHistorySnapshot(snap, prior, set, get);
    },

    redoLastQueueEdit: () => {
      const prior = get();
      const snap = popQueueRedoSnapshot();
      if (!snap) return false;
      pushQueueUndoSnapshot(queueUndoSnapshotFromState(prior));
      return applyQueueHistorySnapshot(snap, prior, set, get);
    },
  };
}
