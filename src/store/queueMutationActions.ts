import { invoke } from '@tauri-apps/api/core';
import { orbitBulkGuard } from '../utils/orbitBulkGuard';
import { useAuthStore } from './authStore';
import { setIsAudioPaused } from './engineState';
import { prefetchLoudnessForEnqueuedTracks } from './loudnessPrefetch';
import type { PlayerState, Track } from './playerStoreTypes';
import { pushQueueUndoFromGetter } from './queueUndo';
import { syncQueueToServer } from './queueSync';
import {
  addRadioSessionSeen,
  clearRadioSessionSeenIds,
  deleteRadioSessionSeen,
  getCurrentRadioArtistId,
  hasRadioSessionSeen,
  setCurrentRadioArtistId,
} from './radioSessionState';
import { clearSeekDebounce } from './seekDebounce';
import { clearSeekFallbackRetry } from './seekFallbackState';
import { clearSeekTarget } from './seekTargetState';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Queue-mutation actions factored out of the playerStore `create()` body.
 * All eleven members of the cluster: insertion (`enqueue`, `enqueueAt`,
 * `playNext`, `enqueueRadio`, `setRadioArtistId`), pruning (`clearQueue`,
 * `pruneUpcomingToCurrent`, `removeTrack`), and rearrangement
 * (`reorderQueue`, `shuffleQueue`, `shuffleUpcomingQueue`). All but
 * `setRadioArtistId` push a queue-undo snapshot and call
 * `syncQueueToServer` so the Navidrome `savePlayQueue` stays in sync.
 */
export function createQueueMutationActions(set: SetState, get: GetState): Pick<
  PlayerState,
  | 'enqueue'
  | 'enqueueAt'
  | 'playNext'
  | 'enqueueRadio'
  | 'setRadioArtistId'
  | 'pruneUpcomingToCurrent'
  | 'clearQueue'
  | 'reorderQueue'
  | 'shuffleQueue'
  | 'shuffleUpcomingQueue'
  | 'removeTrack'
> {
  return {
    enqueue: (tracks, _orbitConfirmed = false) => {
      if (!_orbitConfirmed && tracks.length > 1) {
        void orbitBulkGuard(tracks.length).then(ok => {
          if (ok) get().enqueue(tracks, true);
        });
        return;
      }
      pushQueueUndoFromGetter(get);
      set(state => {
        // Insert before the first upcoming auto-added track so the
        // "Added automatically" separator always stays at the boundary.
        const firstAutoIdx = state.queue.findIndex(
          (t, i) => t.autoAdded && i > state.queueIndex
        );
        const newQueue = firstAutoIdx === -1
          ? [...state.queue, ...tracks]
          : [
              ...state.queue.slice(0, firstAutoIdx),
              ...tracks,
              ...state.queue.slice(firstAutoIdx),
            ];
        syncQueueToServer(newQueue, state.currentTrack, state.currentTime);
        prefetchLoudnessForEnqueuedTracks(newQueue, state.queueIndex);
        return { queue: newQueue };
      });
    },

    setRadioArtistId: (artistId) => {
      if (artistId !== getCurrentRadioArtistId()) {
        clearRadioSessionSeenIds();
      }
      setCurrentRadioArtistId(artistId);
    },

    enqueueRadio: (tracks, artistId) => {
      if (artistId !== undefined) {
        if (artistId !== getCurrentRadioArtistId()) {
          clearRadioSessionSeenIds();
        }
        setCurrentRadioArtistId(artistId);
      }
      pushQueueUndoFromGetter(get);
      set(state => {
        // Drop all upcoming (not yet played) radio tracks — clicking "Start Radio"
        // again replaces the pending radio batch instead of stacking on top.
        const beforeAndCurrent = state.queue.slice(0, state.queueIndex + 1);
        const upcoming = state.queue.slice(state.queueIndex + 1).filter(t => !t.radioAdded);
        // Tracks about to leave the queue here. Callers like ContextMenu.startRadio
        // pass the previous pending radio back in `tracks` to merge with new
        // similars — the seen-set must not block those re-introductions.
        const droppedRadioIds = state.queue
          .slice(state.queueIndex + 1)
          .filter(t => t.radioAdded)
          .map(t => t.id);
        for (const id of droppedRadioIds) deleteRadioSessionSeen(id);
        // Capture surviving queue ids in the seen-set so the next radio top-up
        // can dedupe against the seed track + already-queued non-radio items.
        for (const t of beforeAndCurrent) addRadioSessionSeen(t.id);
        for (const t of upcoming) addRadioSessionSeen(t.id);
        // Drop incoming tracks already seen earlier this session AND
        // intra-batch duplicates (top + similar Last.fm responses commonly
        // overlap). The seen-set is mutated inside the loop so a repeated
        // id later in `tracks` is rejected by the same pass that admitted
        // the first occurrence (issue #500).
        const dedupedTracks: Track[] = [];
        for (const t of tracks) {
          if (hasRadioSessionSeen(t.id)) continue;
          addRadioSessionSeen(t.id);
          dedupedTracks.push(t);
        }
        // Insert new radio tracks before any autoAdded tracks in the upcoming section.
        const firstAutoIdx = upcoming.findIndex(t => t.autoAdded);
        const merged = firstAutoIdx === -1
          ? [...upcoming, ...dedupedTracks]
          : [
              ...upcoming.slice(0, firstAutoIdx),
              ...dedupedTracks,
              ...upcoming.slice(firstAutoIdx),
            ];
        const newQueue = [...beforeAndCurrent, ...merged];
        syncQueueToServer(newQueue, state.currentTrack, state.currentTime);
        return { queue: newQueue };
      });
    },

    enqueueAt: (tracks, insertIndex, _orbitConfirmed = false) => {
      if (!_orbitConfirmed && tracks.length > 1) {
        void orbitBulkGuard(tracks.length).then(ok => {
          if (ok) get().enqueueAt(tracks, insertIndex, true);
        });
        return;
      }
      pushQueueUndoFromGetter(get);
      set(state => {
        const idx = Math.max(0, Math.min(insertIndex, state.queue.length));
        const newQueue = [
          ...state.queue.slice(0, idx),
          ...tracks,
          ...state.queue.slice(idx),
        ];
        const newQueueIndex = idx <= state.queueIndex
          ? state.queueIndex + tracks.length
          : state.queueIndex;
        syncQueueToServer(newQueue, state.currentTrack, state.currentTime);
        prefetchLoudnessForEnqueuedTracks(newQueue, newQueueIndex);
        return { queue: newQueue, queueIndex: newQueueIndex };
      });
    },

    playNext: (tracks) => {
      if (tracks.length === 0) return;
      const state = get();
      const tagged = tracks.map(t => ({ ...t, playNextAdded: true as const }));
      if (!state.currentTrack) {
        state.playTrack(tagged[0], tagged);
        return;
      }
      const baseIdx = state.queueIndex + 1;
      let insertIdx = baseIdx;
      if (useAuthStore.getState().preservePlayNextOrder) {
        const q = state.queue;
        while (insertIdx < q.length && q[insertIdx].playNextAdded) insertIdx++;
      }
      get().enqueueAt(tagged, insertIdx);
    },

    pruneUpcomingToCurrent: () => {
      const s = get();
      if (s.currentRadio) return;
      if (!s.currentTrack) {
        if (s.queue.length === 0) return;
        pushQueueUndoFromGetter(get);
        set({ queue: [], queueIndex: 0 });
        syncQueueToServer([], null, 0);
        return;
      }
      pushQueueUndoFromGetter(get);
      const at = s.queue.findIndex(t => t.id === s.currentTrack!.id);
      const newQueue: Track[] =
        at >= 0
          ? s.queue.slice(0, at + 1)
          : [s.currentTrack!];
      const newIndex = at >= 0 ? at : 0;
      set({ queue: newQueue, queueIndex: newIndex });
      syncQueueToServer(newQueue, s.currentTrack, s.currentTime);
    },

    clearQueue: () => {
      invoke('audio_stop').catch(console.error);
      setIsAudioPaused(false);
      clearSeekFallbackRetry();
      clearSeekDebounce(); clearSeekTarget();
      clearRadioSessionSeenIds();
      setCurrentRadioArtistId(null);
      set({ queue: [], queueIndex: 0, currentTrack: null, isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
      syncQueueToServer([], null, 0);
    },

    reorderQueue: (startIndex, endIndex) => {
      pushQueueUndoFromGetter(get);
      const { queue, queueIndex, currentTrack } = get();
      const result = Array.from(queue);
      const [removed] = result.splice(startIndex, 1);
      result.splice(endIndex, 0, removed);
      let newIndex = queueIndex;
      if (currentTrack) newIndex = result.findIndex(t => t.id === currentTrack.id);
      set({ queue: result, queueIndex: Math.max(0, newIndex) });
      syncQueueToServer(result, currentTrack, get().currentTime);
    },

    shuffleQueue: () => {
      const { queue, currentTrack } = get();
      if (queue.length < 2) return;
      pushQueueUndoFromGetter(get);
      const currentIdx = currentTrack ? queue.findIndex(t => t.id === currentTrack.id) : -1;
      const others = queue.filter((_, i) => i !== currentIdx);
      for (let i = others.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [others[i], others[j]] = [others[j], others[i]];
      }
      const result = currentIdx >= 0
        ? [queue[currentIdx], ...others]
        : others;
      const newIndex = currentIdx >= 0 ? 0 : -1;
      set({ queue: result, queueIndex: Math.max(0, newIndex) });
      syncQueueToServer(result, currentTrack, get().currentTime);
    },

    shuffleUpcomingQueue: () => {
      const { queue, queueIndex, currentTrack } = get();
      const upcomingStart = queueIndex + 1;
      const upcomingCount = queue.length - upcomingStart;
      if (upcomingCount < 2) return;
      pushQueueUndoFromGetter(get);
      const head     = queue.slice(0, upcomingStart);
      const upcoming = queue.slice(upcomingStart);
      for (let i = upcoming.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
      }
      const result = [...head, ...upcoming];
      set({ queue: result });
      syncQueueToServer(result, currentTrack, get().currentTime);
    },

    removeTrack: (index) => {
      pushQueueUndoFromGetter(get);
      const { queue, queueIndex } = get();
      const newQueue = [...queue];
      newQueue.splice(index, 1);
      set({ queue: newQueue, queueIndex: Math.min(queueIndex, newQueue.length - 1) });
      syncQueueToServer(newQueue, get().currentTrack, get().currentTime);
    },
  };
}
