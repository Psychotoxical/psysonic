import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { emitPlaybackProgress } from './playbackProgress';
import type { PlayerState } from './playerStoreTypes';
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
      queue: [],
      queueIndex: 0,
      isPlaying: false,
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
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        volume: state.volume,
        repeatMode: state.repeatMode,
        currentTrack: state.currentTrack,
        queue: state.queue,
        queueIndex: state.queueIndex,
        isQueueVisible: state.isQueueVisible,
        // currentTime is intentionally NOT persisted here.
        // handleAudioProgress fires every 100ms and each setState with a
        // persisted field triggers a full JSON serialisation of the queue to
        // localStorage.  After ~10 minutes of Artist Radio the queue grows to
        // 50+ tracks; 6 000+ synchronous SQLite writes cause WKWebView's
        // storage process to crash on macOS → black screen + audio stop.
        // Resume position is recovered from Subsonic savePlayQueue (5s debounce).
        lastfmLovedCache: state.lastfmLovedCache,
      }),
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

