import { audioStop } from '@/lib/api/audio';
import { orbitBulkGuard } from '@/store/orbitRuntime';
import { useAuthStore } from '@/store/authStore';
import { setIsAudioPaused } from '@/features/playback/store/engineState';
import { prefetchLoudnessForEnqueuedTracks } from '@/features/playback/store/loudnessPrefetch';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';
import { pushQueueUndoFromGetter } from '@/features/playback/store/queueUndo';
import { syncUserQueueMutationToServer } from '@/features/playback/store/queueSync';
import {
  addRadioSessionSeen,
  clearRadioSessionSeenIds,
  deleteRadioSessionSeen,
  getCurrentRadioArtistId,
  hasRadioSessionSeen,
  setCurrentRadioArtistId,
} from '@/features/playback/store/radioSessionState';
import { clearSeekDebounce } from '@/features/playback/store/seekDebounce';
import { clearSeekFallbackRetry } from '@/features/playback/store/seekFallbackState';
import { clearSeekTarget } from '@/features/playback/store/seekTargetState';
import { playListenSessionFinalize } from '@/features/playback/store/playListenSession';
import {
  clearQueueServerForPlayback,
  ensureQueueServerPinned,
} from '@/features/playback/utils/playback/playbackServer';
import { clearTimelineSessionHistory } from '@/features/playback/store/timelineSessionHistory';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * The canonical working ref list for a mutation (thin-state). Mutations
 * splice/filter/reorder a copy of these refs and write the result back into
 * `queueItems` — the queue source of truth. Returns a fresh array each call so
 * in-place splices don't mutate the live state array.
 */
const itemsOf = (state: PlayerState): QueueItemRef[] => [...state.queueItems];

/** Seed the resolver cache with tracks entering the queue, so they resolve
 *  without a network round-trip once `queue: Track[]` is dropped (seed-before-
 *  splice). No-op without a real playback server (e.g. unit tests). */
function seedIncoming(state: PlayerState, tracks: Track[]): void {
  for (const t of tracks) {
    const serverId = t.serverId ?? state.queueServerId ?? '';
    if (serverId) seedQueueResolver(serverId, [t]);
  }
}

/**
 * Eleven queue-mutation actions. Shared invariant: every action except
 * `setRadioArtistId` pushes a queue-undo snapshot and calls
 * `syncUserQueueMutationToServer` so the Navidrome `savePlayQueue` stays in sync.
 * Exceptions: `enqueue`'s optional third argument **`skipQueueUndo`** and
 * **`pruneUpcomingToCurrent(true)`** — Lucky Mix pushes one snapshot up-front.
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
    enqueue: (tracks, _orbitConfirmed = false, skipQueueUndo = false) => {
      if (!_orbitConfirmed && tracks.length > 1) {
        void orbitBulkGuard(tracks.length).then(ok => {
          if (ok) get().enqueue(tracks, true, skipQueueUndo);
        });
        return;
      }
      if (!skipQueueUndo) pushQueueUndoFromGetter(get);
      ensureQueueServerPinned(tracks);
      set(state => {
        seedIncoming(state, tracks);
        const items = itemsOf(state);
        const incoming = toQueueItemRefs(state.queueServerId ?? '', tracks);
        // Insert before the first upcoming auto-added track so the
        // "Added automatically" separator always stays at the boundary.
        const firstAutoIdx = items.findIndex((r, i) => r.autoAdded && i > state.queueIndex);
        const newItems = firstAutoIdx === -1
          ? [...items, ...incoming]
          : [...items.slice(0, firstAutoIdx), ...incoming, ...items.slice(firstAutoIdx)];
        syncUserQueueMutationToServer(newItems, state.currentTrack, state.currentTime);
        prefetchLoudnessForEnqueuedTracks(newItems, state.queueIndex);
        return { queueItems: newItems };
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
      ensureQueueServerPinned();
      set(state => {
        const items = itemsOf(state);
        // Drop all upcoming (not yet played) radio tracks — clicking "Start Radio"
        // again replaces the pending radio batch instead of stacking on top.
        const beforeAndCurrent = items.slice(0, state.queueIndex + 1);
        const upcoming = items.slice(state.queueIndex + 1).filter(r => !r.radioAdded);
        // Tracks about to leave the queue here. Callers like ContextMenu.startRadio
        // pass the previous pending radio back in `tracks` to merge with new
        // similars — the seen-set must not block those re-introductions.
        const droppedRadioIds = items
          .slice(state.queueIndex + 1)
          .filter(r => r.radioAdded)
          .map(r => r.trackId);
        for (const id of droppedRadioIds) deleteRadioSessionSeen(id);
        // Capture surviving queue ids in the seen-set so the next radio top-up
        // can dedupe against the seed track + already-queued non-radio items.
        for (const r of beforeAndCurrent) addRadioSessionSeen(r.trackId);
        for (const r of upcoming) addRadioSessionSeen(r.trackId);
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
        seedIncoming(state, dedupedTracks);
        const incoming = toQueueItemRefs(state.queueServerId ?? '', dedupedTracks);
        // Insert new radio tracks before any autoAdded tracks in the upcoming section.
        const firstAutoIdx = upcoming.findIndex(r => r.autoAdded);
        const mergedItems = firstAutoIdx === -1
          ? [...upcoming, ...incoming]
          : [...upcoming.slice(0, firstAutoIdx), ...incoming, ...upcoming.slice(firstAutoIdx)];
        const newItems = [...beforeAndCurrent, ...mergedItems];
        syncUserQueueMutationToServer(newItems, state.currentTrack, state.currentTime);
        return { queueItems: newItems };
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
      ensureQueueServerPinned(tracks);
      set(state => {
        seedIncoming(state, tracks);
        const items = itemsOf(state);
        const idx = Math.max(0, Math.min(insertIndex, items.length));
        const incoming = toQueueItemRefs(state.queueServerId ?? '', tracks);
        const newItems = [...items.slice(0, idx), ...incoming, ...items.slice(idx)];
        const newQueueIndex = idx <= state.queueIndex
          ? state.queueIndex + tracks.length
          : state.queueIndex;
        syncUserQueueMutationToServer(newItems, state.currentTrack, state.currentTime);
        prefetchLoudnessForEnqueuedTracks(newItems, newQueueIndex);
        return { queueItems: newItems, queueIndex: newQueueIndex };
      });
    },

    playNext: (tracks) => {
      if (tracks.length === 0) return;
      ensureQueueServerPinned(tracks);
      const state = get();
      const tagged = tracks.map(t => ({ ...t, playNextAdded: true as const }));
      if (!state.currentTrack) {
        state.playTrack(tagged[0], tagged);
        return;
      }
      const baseIdx = state.queueIndex + 1;
      let insertIdx = baseIdx;
      if (useAuthStore.getState().preservePlayNextOrder) {
        const items = itemsOf(state);
        while (insertIdx < items.length && items[insertIdx].playNextAdded) insertIdx++;
      }
      get().enqueueAt(tagged, insertIdx);
    },

    pruneUpcomingToCurrent: (skipQueueUndo = false) => {
      const s = get();
      if (s.currentRadio) return;
      if (!s.currentTrack) {
        if (s.queueItems.length === 0) return;
        if (!skipQueueUndo) pushQueueUndoFromGetter(get);
        set({ queueItems: [], queueIndex: 0 });
        syncUserQueueMutationToServer([], null, 0);
        return;
      }
      if (!skipQueueUndo) pushQueueUndoFromGetter(get);
      // Seed the resolver with the currently playing track so its ref always
      // resolves even when it had not been in the cache window before.
      seedIncoming(s, [s.currentTrack]);
      const items = itemsOf(s);
      const at = items.findIndex(r => r.trackId === s.currentTrack!.id);
      const newItems = at >= 0
        ? items.slice(0, at + 1)
        : toQueueItemRefs(s.queueServerId ?? '', [s.currentTrack!]);
      const newIndex = at >= 0 ? at : 0;
      set({ queueItems: newItems, queueIndex: newIndex });
      syncUserQueueMutationToServer(newItems, s.currentTrack, s.currentTime);
    },

    clearQueue: () => {
      void playListenSessionFinalize('stop');
      audioStop().catch(console.error);
      setIsAudioPaused(false);
      clearSeekFallbackRetry();
      clearSeekDebounce(); clearSeekTarget();
      clearRadioSessionSeenIds();
      setCurrentRadioArtistId(null);
      clearTimelineSessionHistory();
      clearQueueServerForPlayback();
      set({ queueItems: [], queueIndex: 0, currentTrack: null, isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
      syncUserQueueMutationToServer([], null, 0);
    },

    reorderQueue: (startIndex, endIndex) => {
      pushQueueUndoFromGetter(get);
      const state = get();
      const { queueIndex, currentTrack } = state;
      const result = itemsOf(state);
      const [removed] = result.splice(startIndex, 1);
      result.splice(endIndex, 0, removed);
      let newIndex = queueIndex;
      if (currentTrack) newIndex = result.findIndex(r => r.trackId === currentTrack.id);
      set({ queueItems: result, queueIndex: Math.max(0, newIndex) });
      syncUserQueueMutationToServer(result, currentTrack, get().currentTime);
    },

    shuffleQueue: () => {
      const state = get();
      const { currentTrack } = state;
      if (state.queueItems.length < 2) return;
      pushQueueUndoFromGetter(get);
      const items = itemsOf(state);
      const currentIdx = currentTrack ? items.findIndex(r => r.trackId === currentTrack.id) : -1;
      const others = items.filter((_, i) => i !== currentIdx);
      for (let i = others.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [others[i], others[j]] = [others[j], others[i]];
      }
      const result = currentIdx >= 0
        ? [items[currentIdx], ...others]
        : others;
      const newIndex = currentIdx >= 0 ? 0 : -1;
      set({ queueItems: result, queueIndex: Math.max(0, newIndex) });
      syncUserQueueMutationToServer(result, currentTrack, get().currentTime);
    },

    shuffleUpcomingQueue: () => {
      const state = get();
      const { queueIndex, currentTrack } = state;
      const upcomingStart = queueIndex + 1;
      const upcomingCount = state.queueItems.length - upcomingStart;
      if (upcomingCount < 2) return;
      pushQueueUndoFromGetter(get);
      const items = itemsOf(state);
      const head     = items.slice(0, upcomingStart);
      const upcoming = items.slice(upcomingStart);
      for (let i = upcoming.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
      }
      const result = [...head, ...upcoming];
      set({ queueItems: result });
      syncUserQueueMutationToServer(result, currentTrack, get().currentTime);
    },

    removeTrack: (index) => {
      pushQueueUndoFromGetter(get);
      const state = get();
      const { queueIndex } = state;
      const newItems = itemsOf(state);
      newItems.splice(index, 1);
      set({
        queueItems: newItems,
        queueIndex: Math.min(queueIndex, newItems.length - 1),
      });
      syncUserQueueMutationToServer(newItems, get().currentTrack, get().currentTime);
    },
  };
}
