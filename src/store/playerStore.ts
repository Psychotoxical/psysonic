import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createSafeJSONStorage } from './safeStorage';
import { emitPlaybackProgress } from './playbackProgress';
import type { PlayerState, QueueItemRef, Track } from './playerStoreTypes';
import { toQueueItemRefs } from '../utils/library/queueItemRef';
import { canonicalQueueServerKey } from '../utils/server/serverIndexKey';
import { readInitialQueueVisibility } from './queueVisibilityStorage';
import { createLastfmActions } from './lastfmActions';
import { createMiscActions } from './miscActions';
import { runNext } from './nextAction';
import { runPlayTrack } from './playTrackAction';
import { runResume } from './resumeAction';
import { runSeek } from './seekAction';
import { runUpdateReplayGainForCurrentTrack } from './updateReplayGainAction';
import { createQueueMutationActions } from './queueMutationActions';
import { createScheduleActions } from './scheduleActions';
import { createTransportLightActions } from './transportLightActions';
import { createUiStateActions } from './uiStateActions';
import { createUndoRedoActions } from './undoRedoActions';

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => {

      return {
      currentTrack: null,
      waveformBins: null,
      normalizationNowDb: null,
      normalizationTargetLufs: null,
      normalizationEngineLive: 'off',
      normalizationDbgSource: null,
      normalizationDbgTrackId: null,
      normalizationDbgCacheGainDb: null,
      normalizationDbgCacheTargetLufs: null,
      normalizationDbgCacheUpdatedAt: null,
      normalizationDbgLastEventAt: null,
      currentRadio: null,
      currentPlaybackSource: null,
      enginePreloadedTrackId: null,
      // Thin-state: the queue is a list of refs; full Tracks resolve on demand
      // through the resolver. `currentTrack` stays a full resolved singleton.
      queueItems: [],
      queueServerId: null,
      queueIndex: 0,
      isPlaying: false,
      isPlaybackBuffering: false,
      progress: 0,
      buffered: 0,
      currentTime: 0,
      volume: 0.8,
      scrobbled: false,
      lastfmLoved: false,
      lastfmLovedCache: {},
      starredOverrides: {},
      userRatingOverrides: {},
      isQueueVisible: readInitialQueueVisibility(),
      isFullscreenOpen: false,
      scheduledPauseAtMs: null,
      scheduledPauseStartMs: null,
      scheduledResumeAtMs: null,
      scheduledResumeStartMs: null,
      repeatMode: 'off',
      contextMenu: { isOpen: false, x: 0, y: 0, item: null, type: null },
      songInfoModal: { isOpen: false, songId: null },

      ...createUiStateActions(set),
      ...createLastfmActions(set, get),
      ...createQueueMutationActions(set, get),
      ...createTransportLightActions(set, get),
      ...createUndoRedoActions(set, get),
      ...createMiscActions(set, get),
      ...createScheduleActions(set, get),

      playTrack: (track, queue, manual = true, _orbitConfirmed = false, targetQueueIndex) =>
        runPlayTrack(set, get, track, queue, manual, _orbitConfirmed, targetQueueIndex),
      resume: () => runResume(set, get),
      next: (manual = true) => runNext(set, get, manual),
      seek: (progress) => runSeek(set, get, progress),
      updateReplayGainForCurrentTrack: () => runUpdateReplayGainForCurrentTrack(set, get),
    };
    },
    {
      name: 'psysonic-player',
      // Quota-safe: a failed persist write (huge queue > localStorage quota)
      // must never throw, or it aborts the `set()` it fires from — that is what
      // killed `playTrack` before `audio_play`. See safeStorage.ts.
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        volume: state.volume,
        repeatMode: state.repeatMode,
        currentTrack: state.currentTrack,
        queueServerId: state.queueServerId,
        // Thin-state: persist the whole ordered ref list (tiny) — no windowed
        // fat `queue: Track[]` anymore. `queueItemsIndex` doubles as the
        // restore-pending sentinel a fresh rehydrate carries back, telling
        // `hydrateQueueFromIndex` the refs still need a full resolve.
        queueItems: state.queueItems,
        queueItemsIndex: state.queueIndex,
        isQueueVisible: state.isQueueVisible,
        // currentTime is intentionally NOT persisted here.
        // handleAudioProgress fires every 100ms and each setState with a
        // persisted field triggers a full JSON serialisation to localStorage.
        // Resume position is recovered from Subsonic savePlayQueue (5s debounce).
        lastfmLovedCache: state.lastfmLovedCache,
      }),
      // Rebuild `queueItems` from ANY older persisted blob shape so an upgrade
      // restores the queue. Order of preference: an existing `queueItems` ref
      // list → the legacy `queueRefs` string list → a windowed `queue: Track[]`
      // (the pre-thin-state shape). Sets the restore-pending sentinel and drops
      // the obsolete fat `queue` key from the persisted object.
      merge: (persisted, current) => {
        const blob = (persisted ?? {}) as Record<string, unknown>;
        const rawServerId = (blob.queueServerId as string | null | undefined) ?? null;
        // B1: queue server identity is canonical (index key) on every write path.
        // Migrate persisted blobs forward here once on rehydrate so the live
        // store never has to handle a mix of UUID and index-key refs.
        const canonicalSid = rawServerId ? canonicalQueueServerKey(rawServerId) : null;

        let queueItems: QueueItemRef[] | undefined;
        if (Array.isArray(blob.queueItems) && blob.queueItems.length > 0) {
          queueItems = (blob.queueItems as QueueItemRef[]).map(ref => ({
            ...ref,
            serverId: canonicalQueueServerKey(ref.serverId),
          }));
        } else if (Array.isArray(blob.queueRefs) && blob.queueRefs.length > 0) {
          queueItems = (blob.queueRefs as string[]).map(trackId => ({
            serverId: canonicalSid ?? '',
            trackId,
          }));
        } else if (Array.isArray(blob.queue) && blob.queue.length > 0) {
          queueItems = toQueueItemRefs(canonicalSid ?? '', blob.queue as Track[]);
        }

        // Restore-pending sentinel: prefer the persisted one; else the legacy
        // index; else 0 when we recovered a non-empty queue from an old blob.
        let queueItemsIndex: number | undefined;
        if (typeof blob.queueItemsIndex === 'number') {
          queueItemsIndex = blob.queueItemsIndex;
        } else if (typeof blob.queueRefsIndex === 'number') {
          queueItemsIndex = blob.queueRefsIndex;
        } else if (queueItems && queueItems.length > 0) {
          queueItemsIndex = typeof blob.queueIndex === 'number' ? blob.queueIndex : 0;
        }

        // Drop the obsolete windowed fat-array key — `queueItems` is canonical.
        delete blob.queue;
        // Persist the canonical form back onto the merged blob so subsequent
        // reads of state.queueServerId always see the index key.
        if (canonicalSid !== null) {
          blob.queueServerId = canonicalSid;
        }

        return {
          ...current,
          ...blob,
          queueItems: queueItems ?? current.queueItems,
          ...(queueItemsIndex !== undefined ? { queueItemsIndex } : {}),
        } as PlayerState;
      },
    }
  )
);

usePlayerStore.subscribe((state, prev) => {
  if (
    state.currentTime === prev.currentTime &&
    state.progress === prev.progress &&
    state.buffered === prev.buffered
  ) return;
  emitPlaybackProgress({
    currentTime: state.currentTime,
    progress: state.progress,
    buffered: state.buffered,
  });
});
