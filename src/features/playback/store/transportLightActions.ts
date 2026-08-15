import { audioPause, audioStop } from '@/lib/api/audio';
import { setIsAudioPaused } from '@/features/playback/store/engineState';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import { flushQueueSyncToServer } from '@/features/playback/store/queueSync';
import { markPlaybackIdle } from '@/features/playback/store/queuePlaybackIdle';
import { playListenSessionFinalize, playListenSessionOnPause } from '@/features/playback/store/playListenSession';
import { playbackReportPaused, playbackReportStopped } from '@/features/playback/store/playbackReportSession';
import { pauseRadio, stopRadio } from '@/features/playback/store/radioPlayer';
import { clearAllPlaybackScheduleTimers } from '@/features/playback/store/scheduleTimers';
import { clearSeekDebounce } from '@/features/playback/store/seekDebounce';
import { clearSeekFallbackRetry } from '@/features/playback/store/seekFallbackState';
import { clearSeekTarget } from '@/features/playback/store/seekTargetState';
import { tryAcquireTogglePlayLock } from '@/features/playback/store/togglePlayLock';
import { refreshWaveformForTrack } from '@/features/playback/store/waveformRefresh';
import { clearAutodjTransitionUi } from '@/features/playback/store/autodjTransitionUi';
import { analysisTrackRefForTrack } from '@/features/playback/store/analysisTrackRef';
import { useAuthStore } from '@/store/authStore';
import { sanitizePauseResumeFadeSecs } from '@/lib/audio/pauseResumeFade';

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
        audioStop().catch(console.error);
      }
      setIsAudioPaused(false);
      clearSeekFallbackRetry();
      clearSeekDebounce(); clearSeekTarget();
      // Stop keeps `currentTrack` (the bar still shows the stopped song), so its
      // waveform stays valid. Radio has no analysis waveform — drop the bins.
      const beforeStop = get();
      const keptTrack = wasRadio ? null : beforeStop.currentTrack;
      const keptRef = keptTrack
        ? analysisTrackRefForTrack(keptTrack, beforeStop.queueItems[beforeStop.queueIndex])
        : null;
      set({
        isPlaying: false,
        progress: 0,
        buffered: 0,
        currentTime: 0,
        currentRadio: null,
        ...(keptRef ? {} : { waveformBins: null }),
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
      if (keptRef) void refreshWaveformForTrack(keptRef);
      markPlaybackIdle();
    },

    pause: () => {
      clearAllPlaybackScheduleTimers();
      playListenSessionOnPause();
      const auth = useAuthStore.getState();
      const fadeSecs = auth.pauseResumeFadeEnabled
        ? sanitizePauseResumeFadeSecs(auth.pauseResumeFadeSecs)
        : null;
      if (get().currentRadio) {
        pauseRadio(fadeSecs ?? 0);
      } else {
        audioPause({ fadeSecs }).catch(console.error);
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
