import { invoke } from '@tauri-apps/api/core';
import { setIsAudioPaused } from './engineState';
import type { PlayerState } from './playerStoreTypes';
import { flushQueueSyncToServer } from './queueSync';
import { markPlaybackIdle } from './queuePlaybackIdle';
import { playListenSessionFinalize, playListenSessionOnPause } from './playListenSession';
import { playbackReportPaused, playbackReportStopped } from './playbackReportSession';
import { pauseRadio, stopRadio } from './radioPlayer';
import { clearAllPlaybackScheduleTimers } from './scheduleTimers';
import { clearSeekDebounce } from './seekDebounce';
import { clearSeekFallbackRetry } from './seekFallbackState';
import { clearSeekTarget } from './seekTargetState';
import { tryAcquireTogglePlayLock } from './togglePlayLock';
import { refreshWaveformForTrack } from './waveformRefresh';
import { clearAutodjTransitionUi } from './autodjTransitionUi';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Light transport actions — everything except `resume` (own module,
 * see `resumeAction.ts`) and scheduled timers (`scheduleActions.ts`).
 * `togglePlay` is guarded so a double media-key tap can't race
 * pause + resume into a stuck state. `resetAudioPause` flips the
 * engine-paused flag without touching the UI `isPlaying`, used by
 * `audio:ended` paths.
 */
export function createTransportLightActions(set: SetState, get: GetState): Pick<
  PlayerState,
  'stop' | 'pause' | 'resetAudioPause' | 'togglePlay'
> {
  return {
    stop: () => {
      void playListenSessionFinalize('stop');
      clearAutodjTransitionUi();
      // Report stopped before the position is reset below so the server drops the
      // now-playing entry at the right point (playbackReport extension).
      void playbackReportStopped();
      clearAllPlaybackScheduleTimers();
      const wasRadio = !!get().currentRadio;
      if (wasRadio) {
        stopRadio();
      } else {
        invoke('audio_stop').catch(console.error);
      }
      setIsAudioPaused(false);
      clearSeekFallbackRetry();
      clearSeekDebounce(); clearSeekTarget();
      // Stop keeps `currentTrack` (the bar still shows the stopped song), so its
      // waveform stays valid. Radio has no analysis waveform — drop the bins.
      const keptTrackId = wasRadio ? null : get().currentTrack?.id ?? null;
      set({
        isPlaying: false,
        progress: 0,
        buffered: 0,
        currentTime: 0,
        currentRadio: null,
        ...(keptTrackId ? {} : { waveformBins: null }),
        normalizationNowDb: null,
        normalizationTargetLufs: null,
        normalizationEngineLive: 'off',
        currentPlaybackSource: null,
        enginePreloadedTrackId: null,
        scheduledPauseAtMs: null,
        scheduledPauseStartMs: null,
        scheduledResumeAtMs: null,
        scheduledResumeStartMs: null,
      });
      // Re-hydrate from the analysis DB in case the bins were never loaded or
      // only partially filled while the (now stopped) track was playing.
      if (keptTrackId) void refreshWaveformForTrack(keptTrackId);
      markPlaybackIdle();
    },

    pause: () => {
      clearAllPlaybackScheduleTimers();
      playListenSessionOnPause();
      if (get().currentRadio) {
        pauseRadio();
      } else {
        invoke('audio_pause').catch(console.error);
        setIsAudioPaused(true);
        playbackReportPaused(get().currentTime);
        // Flush position so a quick close after pause still leaves the
        // server with the right resume point for other devices.
        const s = get();
        if (s.currentTrack) {
          void flushQueueSyncToServer(s.queueItems, s.currentTrack, s.currentTime);
        }
      }
      set({ isPlaying: false, scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });
      markPlaybackIdle();
    },

    resetAudioPause: () => {
      setIsAudioPaused(false);
    },

    togglePlay: () => {
      if (!tryAcquireTogglePlayLock()) return;
      const { isPlaying } = get();
      if (isPlaying) get().pause();
      else get().resume();
    },
  };
}
