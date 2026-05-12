import { invoke } from '@tauri-apps/api/core';
import { setIsAudioPaused } from './engineState';
import type { PlayerState } from './playerStoreTypes';
import { flushQueueSyncToServer } from './queueSync';
import { pauseRadio, stopRadio } from './radioPlayer';
import { clearAllPlaybackScheduleTimers } from './scheduleTimers';
import { clearSeekDebounce } from './seekDebounce';
import { clearSeekFallbackRetry } from './seekFallbackState';
import { clearSeekTarget } from './seekTargetState';
import { tryAcquireTogglePlayLock } from './togglePlayLock';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Light transport actions factored out of the playerStore `create()`
 * body — everything except `resume` (~165 LOC, separate PR) and the
 * scheduled pause/resume timer setters.
 *
 *  - `stop` — full reset: stops audio/radio, clears timers + seek + visual
 *    state, blanks playback metadata.
 *  - `pause` — pauses audio (or radio), flushes queue position so other
 *    devices can pick up the resume point.
 *  - `resetAudioPause` — flips the engine-paused flag without touching
 *    the UI `isPlaying` state. Used by `audio:ended` paths.
 *  - `togglePlay` — guarded toggle so a double media-key tap can't race
 *    pause + resume into a stuck state.
 */
export function createTransportLightActions(set: SetState, get: GetState): Pick<
  PlayerState,
  'stop' | 'pause' | 'resetAudioPause' | 'togglePlay'
> {
  return {
    stop: () => {
      clearAllPlaybackScheduleTimers();
      if (get().currentRadio) {
        stopRadio();
      } else {
        invoke('audio_stop').catch(console.error);
      }
      setIsAudioPaused(false);
      clearSeekFallbackRetry();
      clearSeekDebounce(); clearSeekTarget();
      set({
        isPlaying: false,
        progress: 0,
        buffered: 0,
        currentTime: 0,
        currentRadio: null,
        waveformBins: null,
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
    },

    pause: () => {
      clearAllPlaybackScheduleTimers();
      if (get().currentRadio) {
        pauseRadio();
      } else {
        invoke('audio_pause').catch(console.error);
        setIsAudioPaused(true);
        // Flush position so a quick close after pause still leaves the
        // server with the right resume point for other devices.
        const s = get();
        if (s.currentTrack) {
          void flushQueueSyncToServer(s.queue, s.currentTrack, s.currentTime);
        }
      }
      set({ isPlaying: false, scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });
    },

    resetAudioPause: () => {
      setIsAudioPaused(false);
    },

    togglePlay: () => {
      if (!tryAcquireTogglePlayLock()) return;
      const { isPlaying } = get();
      isPlaying ? get().pause() : get().resume();
    },
  };
}
