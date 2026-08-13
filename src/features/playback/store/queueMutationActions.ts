import { orbitAllowsTrackServer, orbitBulkGuard, orbitSnapshot } from '@/store/orbitRuntime';
import { useAuthStore } from '@/store/authStore';
import { prefetchLoudnessForEnqueuedTracks } from '@/features/playback/store/loudnessPrefetch';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';
import { pushQueueUndoFromGetter } from '@/features/playback/store/queueUndo';
import {
  syncAutomaticQueueMutationToServers,
  syncUserQueueClearToServers,
  syncUserQueueMutationToServer,
} from '@/features/playback/store/queueSync';
import {
  addRadioSessionSeen,
  clearRadioSessionSeenIds,
  deleteRadioSessionSeen,
  getCurrentRadioArtistId,
  getCurrentRadioServerId,
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
import { profileIdFromQueueRef } from '@/lib/media/trackServerScope';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { clearTimelineSessionHistory } from '@/features/playback/store/timelineSessionHistory';
import {
  getShuffleOriginalOrder,
  restoreOriginalOrder,
  setShuffleOriginalOrder,
  shuffled,
} from '@/features/playback/store/shuffleModeActions';
import { persistShuffleModeSnapshot } from '@/features/playback/store/shuffleModeStorage';
import {
  queueItemIdentityKey,
  queueItemRefMatchesTrack,
  sameQueueItemRef,
} from '@/features/playback/utils/playback/queueIdentity';
import { canonicalQueueServerKey } from '@/lib/server/serverIndexKey';
import i18n from '@/lib/i18n';
import { showToast } from '@/lib/dom/toast';

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
 * Queue-mutation actions. Explicit queue edits normally push an undo snapshot
 * and sync Navidrome's `savePlayQueue`. Lifecycle mutations are exceptions:
 * `clearQueue` and `retainQueueForServer` are not undoable, while
 * `enqueue(..., skipQueueUndo)` and `pruneUpcomingToCurrent(true)` rely on a
 * caller-owned snapshot.
 */
export function createQueueMutationActions(set: SetState, get: GetState): Pick<
  PlayerState,
  | 'enqueue'
  | 'enqueueAt'
  | 'playNext'
  | 'enqueueRadio'
  | 'setRadioArtistId'
  | 'pruneUpcomingToCurrent'
  | 'retainQueueForServer'
  | 'clearQueue'
  | 'reorderQueue'
  | 'shuffleQueue'
  | 'shuffleUpcomingQueue'
  | 'toggleShuffleMode'
  | 'removeTrack'
  | 'replaceQueueItemSource'
> {
  return {
    replaceQueueItemSource: (index, expected, replacement, userInitiated = true) => {
      const state = get();
      const current = state.queueItems[index];
      if (!current || !sameQueueItemRef(current, expected)) return false;

      pushQueueUndoFromGetter(get);
      const nextItems = [...state.queueItems];
      nextItems[index] = { ...replacement };
      set({ queueItems: nextItems });
      const sync = userInitiated
        ? syncUserQueueMutationToServer
        : syncAutomaticQueueMutationToServers;
      sync(state.queueItems, nextItems, state.currentTrack, state.currentTime);
      return true;
    },

    /**
     * Persistent shuffle: reorders the queue itself and remembers the order it
     * came from, so switching it off restores that order. Rationale for
     * reordering rather than keeping a hidden play order: see shuffleModeActions.
     */
    toggleShuffleMode: () => {
      const state = get();
      const { currentTrack, queueIndex } = state;
      const items = itemsOf(state);
      const enabling = !state.shuffleMode;

      // The flag flips even on an empty queue — the user is setting a mode, and
      // it has to hold for whatever they play next.
      if (items.length === 0) {
        setShuffleOriginalOrder([]);
        persistShuffleModeSnapshot({ enabled: enabling, originalOrder: [] });
        set({ shuffleMode: enabling });
        return;
      }

      pushQueueUndoFromGetter(get);

      let result: QueueItemRef[];
      const currentRef = items[queueIndex];
      if (enabling) {
        setShuffleOriginalOrder(items.map(queueItemIdentityKey));
        // Everything up to and including the current track stays put: the playing
        // track must not move, and already-played rows are history.
        result = [...items.slice(0, queueIndex + 1), ...shuffled(items.slice(queueIndex + 1))];
      } else {
        result = restoreOriginalOrder(items, getShuffleOriginalOrder());
        setShuffleOriginalOrder([]);
      }

      persistShuffleModeSnapshot({ enabled: enabling, originalOrder: getShuffleOriginalOrder() });

      const newIndex = currentTrack
        ? Math.max(0, currentRef ? result.indexOf(currentRef) : result.findIndex(ref => queueItemRefMatchesTrack(ref, currentTrack)))
        : 0;
      set({ shuffleMode: enabling, queueItems: result, queueIndex: newIndex });
      syncUserQueueMutationToServer(items, result, currentTrack, get().currentTime);
    },

    enqueue: (tracks, _orbitConfirmed = false, skipQueueUndo = false) => {
      if (orbitSnapshot().role === 'host') {
        const allowed = tracks.filter(track => orbitAllowsTrackServer(track.serverId));
        if (allowed.length !== tracks.length) {
          showToast(i18n.t('queue.crossServerEnqueueBlocked'), 4000, 'error');
        }
        tracks = allowed;
        if (tracks.length === 0) return;
      }
      if (!_orbitConfirmed && tracks.length > 1) {
        void orbitBulkGuard(tracks.length).then(ok => {
          if (ok) get().enqueue(tracks, true, skipQueueUndo);
        });
        return;
      }
      const stateBeforeEnqueue = get();
      const shouldMountFirstTrack = stateBeforeEnqueue.queueItems.length === 0
        && !stateBeforeEnqueue.currentTrack
        && !stateBeforeEnqueue.currentRadio
        && tracks.length > 0;
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
        syncUserQueueMutationToServer(items, newItems, state.currentTrack, state.currentTime);
        prefetchLoudnessForEnqueuedTracks(newItems, state.queueIndex);
        return { queueItems: newItems };
      });
      if (shouldMountFirstTrack) {
        get().playTrack(tracks[0], undefined, true, true, 0, true);
      }
    },

    setRadioArtistId: (artistId, serverId) => {
      const ownerServerId = serverId ?? useAuthStore.getState().activeServerId ?? null;
      if (artistId !== getCurrentRadioArtistId() || ownerServerId !== getCurrentRadioServerId()) {
        clearRadioSessionSeenIds();
      }
      setCurrentRadioArtistId(artistId, ownerServerId);
    },

    enqueueRadio: (tracks, artistId, serverId) => {
      if (orbitSnapshot().role === 'host') {
        const allowed = tracks.filter(track => orbitAllowsTrackServer(track.serverId));
        if (allowed.length !== tracks.length) {
          showToast(i18n.t('queue.crossServerEnqueueBlocked'), 4000, 'error');
        }
        tracks = allowed;
        if (tracks.length === 0) return;
      }
      if (artistId !== undefined) {
        const ownerServerId = serverId
          ?? tracks.find(track => track.serverId)?.serverId
          ?? useAuthStore.getState().activeServerId
          ?? null;
        if (artistId !== getCurrentRadioArtistId() || ownerServerId !== getCurrentRadioServerId()) {
          clearRadioSessionSeenIds();
        }
        setCurrentRadioArtistId(artistId, ownerServerId);
      }
      pushQueueUndoFromGetter(get);
      ensureQueueServerPinned(tracks);
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
          .map(queueItemIdentityKey);
        for (const id of droppedRadioIds) deleteRadioSessionSeen(id);
        // Capture surviving queue ids in the seen-set so the next radio top-up
        // can dedupe against the seed track + already-queued non-radio items.
        for (const r of beforeAndCurrent) addRadioSessionSeen(queueItemIdentityKey(r));
        for (const r of upcoming) addRadioSessionSeen(queueItemIdentityKey(r));
        // Drop incoming tracks already seen earlier this session AND
        // intra-batch duplicates (top + similar Last.fm responses commonly
        // overlap). The seen-set is mutated inside the loop so a repeated
        // id later in `tracks` is rejected by the same pass that admitted
        // the first occurrence (issue #500).
        const dedupedTracks: Track[] = [];
        for (const t of tracks) {
          const serverId = canonicalQueueServerKey(t.serverId ?? state.queueServerId ?? '');
          const identity = queueItemIdentityKey({ serverId, trackId: t.id });
          if (hasRadioSessionSeen(identity)) continue;
          addRadioSessionSeen(identity);
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
        syncUserQueueMutationToServer(items, newItems, state.currentTrack, state.currentTime);
        return { queueItems: newItems };
      });
    },

    enqueueAt: (tracks, insertIndex, _orbitConfirmed = false) => {
      if (orbitSnapshot().role === 'host') {
        const allowed = tracks.filter(track => orbitAllowsTrackServer(track.serverId));
        if (allowed.length !== tracks.length) {
          showToast(i18n.t('queue.crossServerEnqueueBlocked'), 4000, 'error');
        }
        tracks = allowed;
        if (tracks.length === 0) return;
      }
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
        syncUserQueueMutationToServer(items, newItems, state.currentTrack, state.currentTime);
        prefetchLoudnessForEnqueuedTracks(newItems, newQueueIndex);
        return { queueItems: newItems, queueIndex: newQueueIndex };
      });
    },

    playNext: (tracks) => {
      if (orbitSnapshot().role === 'host') {
        const allowed = tracks.filter(track => orbitAllowsTrackServer(track.serverId));
        if (allowed.length !== tracks.length) {
          showToast(i18n.t('queue.crossServerEnqueueBlocked'), 4000, 'error');
        }
        tracks = allowed;
      }
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
        const previousItems = itemsOf(s);
        set({ queueItems: [], queueIndex: 0 });
        syncUserQueueClearToServers(previousItems);
        return;
      }
      if (!skipQueueUndo) pushQueueUndoFromGetter(get);
      // Seed the resolver with the currently playing track so its ref always
      // resolves even when it had not been in the cache window before.
      seedIncoming(s, [s.currentTrack]);
      const items = itemsOf(s);
      const indexedRef = items[s.queueIndex];
      const at = queueItemRefMatchesTrack(indexedRef, s.currentTrack)
        ? s.queueIndex
        : items.findIndex(ref => queueItemRefMatchesTrack(ref, s.currentTrack));
      const newItems = at >= 0
        ? items.slice(0, at + 1)
        : toQueueItemRefs(s.queueServerId ?? '', [s.currentTrack!]);
      const newIndex = at >= 0 ? at : 0;
      set({ queueItems: newItems, queueIndex: newIndex });
      syncUserQueueMutationToServer(items, newItems, s.currentTrack, s.currentTime);
    },

    retainQueueForServer: (serverId) => {
      const state = get();
      const previousItems = itemsOf(state);
      const targetProfileId = resolveServerIdForIndexKey(serverId) || serverId;
      const fallbackProfileId = resolveServerIdForIndexKey(state.queueServerId ?? '')
        || state.queueServerId
        || useAuthStore.getState().activeServerId
        || '';
      const nextItems = previousItems.filter(ref => (
        (profileIdFromQueueRef(ref) || fallbackProfileId) === targetProfileId
      ));
      const nextQueueIndex = state.currentTrack
        ? nextItems.findIndex(ref => queueItemRefMatchesTrack(ref, state.currentTrack!))
        : -1;
      const keepsCurrentTrack = nextQueueIndex >= 0 && !state.currentRadio;
      const mustStop = Boolean(state.currentRadio || (state.currentTrack && !keepsCurrentTrack));

      if (mustStop) get().stop();

      const queueServerId = canonicalQueueServerKey(serverId) || serverId;
      set({
        queueItems: nextItems,
        queueIndex: keepsCurrentTrack ? nextQueueIndex : 0,
        queueServerId,
        navidromePublicSharePageUrl: null,
        ...(!keepsCurrentTrack && state.currentTrack ? {
          currentTrack: null,
          waveformBins: null,
          isPlaying: false,
          progress: 0,
          buffered: 0,
          currentTime: 0,
        } : {}),
      });
      syncUserQueueMutationToServer(
        previousItems,
        nextItems,
        keepsCurrentTrack ? state.currentTrack : null,
        keepsCurrentTrack ? state.currentTime : 0,
      );
    },

    clearQueue: () => {
      const previousItems = itemsOf(get());
      get().stop();
      // `stop()` owns the actual lifecycle close; this remains a harmless no-op
      // after it and preserves the established playback-store dependency shape.
      void playListenSessionFinalize('stop');
      clearSeekFallbackRetry();
      clearSeekDebounce(); clearSeekTarget();
      clearRadioSessionSeenIds();
      setCurrentRadioArtistId(null);
      clearTimelineSessionHistory();
      clearQueueServerForPlayback();
      set({
        queueItems: [],
        queueIndex: 0,
        currentTrack: null,
        navidromePublicSharePageUrl: null,
        isPlaying: false,
        progress: 0,
        buffered: 0,
        currentTime: 0,
      });
      syncUserQueueClearToServers(previousItems);
    },

    reorderQueue: (startIndex, endIndex) => {
      pushQueueUndoFromGetter(get);
      const state = get();
      const { queueIndex, currentTrack } = state;
      const previousItems = itemsOf(state);
      const currentRef = previousItems[queueIndex];
      const result = [...previousItems];
      const [removed] = result.splice(startIndex, 1);
      result.splice(endIndex, 0, removed);
      let newIndex = queueIndex;
      if (currentTrack) {
        newIndex = currentRef
          ? result.indexOf(currentRef)
          : result.findIndex(ref => queueItemRefMatchesTrack(ref, currentTrack));
      }
      set({ queueItems: result, queueIndex: Math.max(0, newIndex) });
      syncUserQueueMutationToServer(previousItems, result, currentTrack, get().currentTime);
    },

    shuffleQueue: () => {
      const state = get();
      const { currentTrack } = state;
      if (state.queueItems.length < 2) return;
      pushQueueUndoFromGetter(get);
      const items = itemsOf(state);
      const currentIdx = currentTrack && queueItemRefMatchesTrack(items[state.queueIndex], currentTrack)
        ? state.queueIndex
        : currentTrack ? items.findIndex(ref => queueItemRefMatchesTrack(ref, currentTrack)) : -1;
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
      syncUserQueueMutationToServer(items, result, currentTrack, get().currentTime);
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
      syncUserQueueMutationToServer(items, result, currentTrack, get().currentTime);
    },

    removeTrack: (index) => {
      pushQueueUndoFromGetter(get);
      const state = get();
      const { queueIndex } = state;
      const previousItems = itemsOf(state);
      const newItems = [...previousItems];
      newItems.splice(index, 1);
      set({
        queueItems: newItems,
        queueIndex: Math.min(queueIndex, newItems.length - 1),
      });
      syncUserQueueMutationToServer(previousItems, newItems, get().currentTrack, get().currentTime);
    },
  };
}
