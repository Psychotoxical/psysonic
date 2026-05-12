import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { resolveReplayGainDb } from '../utils/resolveReplayGainDb';
import { shuffleArray } from '../utils/shuffleArray';
import { songToTrack } from '../utils/songToTrack';
import {
  emitPlaybackProgress,
  getPlaybackProgressSnapshot,
  subscribePlaybackProgress,
  type PlaybackProgressSnapshot,
} from './playbackProgress';
import { flushPlayQueuePosition } from './queueSync';
import { initAudioListeners } from './initAudioListeners';
import { installQueueUndoHotkey } from './queueUndoHotkey';
import { readInitialQueueVisibility } from './queueVisibilityStorage';

// Re-export so MainApp + the 3 playerStore characterization tests keep
// their existing `from './playerStore'` imports.
export { initAudioListeners };

// Re-export so bootstrap.ts + bootstrap.test keep their existing
// `from './playerStore'` imports.
export { installQueueUndoHotkey };

// Re-export so TauriEventBridge + persistence test keep their existing
// `from './playerStore'` imports.
export { flushPlayQueuePosition };

// Re-export the playback-progress public surface so existing call sites
// (PlayerBar, FullscreenPlayer, WaveformSeek, LyricsPane, MobilePlayerView,
// TauriEventBridge, plus the progress characterization test) keep their
// `from './playerStore'` imports working.
export {
  getPlaybackProgressSnapshot,
  subscribePlaybackProgress,
  type PlaybackProgressSnapshot,
};
import {
  _resetQueueUndoStacksForTest,
  consumePendingQueueListScrollTop,
  pushQueueUndoFromGetter,
  registerQueueListScrollTopReader,
} from './queueUndo';

// Re-export for backward compatibility with the ~30 call sites that still
// import these helpers from playerStore. Phase E (store splits) will migrate
// the imports to '../utils/*' directly and drop these re-exports.
export { resolveReplayGainDb, shuffleArray, songToTrack };

// Re-export the queue-undo public API so existing callers (QueuePanel,
// test/helpers/storeReset) keep their `from './playerStore'` imports.
export {
  _resetQueueUndoStacksForTest,
  consumePendingQueueListScrollTop,
  registerQueueListScrollTopReader,
};

import type { PlayerState, Track } from './playerStoreTypes';
export type { PlayerState, Track };
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


// ─── Module-level playback primitives ─────────────────────────────────────────


// ─── Store ────────────────────────────────────────────────────────────────────

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

      // ── playTrack ────────────────────────────────────────────────────────────
      playTrack: (track, queue, manual = true, _orbitConfirmed = false, targetQueueIndex) =>
        runPlayTrack(set, get, track, queue, manual, _orbitConfirmed, targetQueueIndex),

      // ── resume ───────────────────────────────────────────────────────────────
      resume: () => runResume(set, get),

      // ── next ────────────────────────────────────────────────────────────────
      next: (manual = true) => runNext(set, get, manual),


      // ── seek ─────────────────────────────────────────────────────────────────
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

