import { getPlayQueue } from '../api/subsonicPlayQueue';
import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n';
import { songToTrack } from '../utils/songToTrack';
import { showToast } from '../utils/toast';
import { useAuthStore } from './authStore';
import {
  bumpPlayGeneration,
  setIsAudioPaused,
} from './engineState';
import { clearPreloadingIds } from './gaplessPreloadState';
import { reseedLoudnessForTrackId } from './loudnessReseed';
import { getPlaybackProgressSnapshot } from './playbackProgress';
import { shouldRebindPlaybackToHotCache } from './playbackUrlRouting';
import type { PlayerState, Track } from './playerStoreTypes';
import { pushQueueUndoFromGetter } from './queueUndo';
import { syncQueueToServer } from './queueSync';
import {
  clearRadioReconnectTimer,
  playRadioStream,
  setRadioVolume,
} from './radioPlayer';
import { clearAllPlaybackScheduleTimers } from './scheduleTimers';
import { clearSeekDebounce } from './seekDebounce';
import {
  clearSeekFallbackRetry,
  setSeekFallbackVisualTarget,
} from './seekFallbackState';
import { clearSeekTarget } from './seekTargetState';
import { refreshWaveformForTrack } from './waveformRefresh';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Heterogeneous "misc" cluster — seven small-to-medium actions that
 * don't fit the more focused factories (transport / queue / Last.fm /
 * UI state):
 *
 *  - `playRadio` — switches the player into HTML5 radio mode (Rust
 *    engine stopped, queue cleared, ICY stream resolved + played).
 *  - `previous` — Subsonic-style back: restart current track if past
 *    3 s, otherwise jump to the previous queue index.
 *  - `setVolume` — clamps + propagates to Rust engine and radio sink.
 *  - `setProgress` — pure UI state update used by progress polling.
 *  - `initializeFromServerQueue` — startup queue restore from
 *    Navidrome's `getPlayQueue` endpoint.
 *  - `reanalyzeLoudnessForTrack` — toast + reseed the loudness cache
 *    for a single track.
 *  - `reseedQueueForInstantMix` — replaces the queue with a single
 *    track when "Instant Mix" is triggered on the currently-playing
 *    song.
 */
export function createMiscActions(set: SetState, get: GetState): Pick<
  PlayerState,
  | 'playRadio'
  | 'previous'
  | 'setVolume'
  | 'setProgress'
  | 'initializeFromServerQueue'
  | 'reanalyzeLoudnessForTrack'
  | 'reseedQueueForInstantMix'
> {
  return {
    playRadio: async (station) => {
      const { volume } = get();
      bumpPlayGeneration();
      clearAllPlaybackScheduleTimers();
      set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });
      setIsAudioPaused(false);
      clearRadioReconnectTimer();
      clearPreloadingIds();
      clearSeekFallbackRetry();
      clearSeekDebounce(); clearSeekTarget();
      // Stop Rust engine in case a regular track was playing.
      invoke('audio_stop').catch(() => {});
      // Resolve PLS/M3U playlist URLs to the actual stream URL before handing
      // to HTML5 <audio> — the browser cannot play playlist files directly.
      const streamUrl = await invoke<string>('resolve_stream_url', { url: station.streamUrl })
        .catch(() => station.streamUrl);
      const { replayGainFallbackDb } = useAuthStore.getState();
      const fallbackFactor = replayGainFallbackDb !== 0 ? Math.pow(10, replayGainFallbackDb / 20) : 1;
      playRadioStream(streamUrl, Math.min(1, volume * fallbackFactor)).catch((err: unknown) => {
        console.error('[psysonic] radio HTML5 play failed:', err);
        showToast('Radio stream error', 3000, 'error');
        set({ isPlaying: false, currentRadio: null });
      });
      set({
        currentRadio: station,
        currentTrack: null,
        waveformBins: null,
        normalizationNowDb: null,
        normalizationTargetLufs: null,
        normalizationEngineLive: 'off',
        currentPlaybackSource: null,
        queue: [],
        queueIndex: 0,
        isPlaying: true,
        progress: 0,
        currentTime: 0,
        buffered: 0,
        scrobbled: true, // no scrobbling for radio
      });
    },

    previous: () => {
      const { queue, queueIndex, currentTrack } = get();
      const currentTime = getPlaybackProgressSnapshot().currentTime;
      if (currentTime > 3) {
        // Restart current track from the beginning.
        const authState = useAuthStore.getState();
        const sid = authState.activeServerId ?? '';
        if (currentTrack && shouldRebindPlaybackToHotCache(currentTrack.id, sid)) {
          setSeekFallbackVisualTarget({ trackId: currentTrack.id, seconds: 0, setAtMs: Date.now() });
          get().playTrack(currentTrack, queue, true);
          return;
        }
        invoke('audio_seek', { seconds: 0 }).catch(console.error);
        set({ progress: 0, currentTime: 0 });
        return;
      }
      const prevIdx = queueIndex - 1;
      if (prevIdx >= 0) get().playTrack(queue[prevIdx], queue, true, false, prevIdx);
    },

    setVolume: (v) => {
      const clamped = Math.max(0, Math.min(1, v));
      invoke('audio_set_volume', { volume: clamped }).catch(console.error);
      setRadioVolume(clamped);
      set({ volume: clamped });
    },

    setProgress: (t, duration) => {
      set({ currentTime: t, progress: duration > 0 ? t / duration : 0 });
    },

    initializeFromServerQueue: async () => {
      try {
        const q = await getPlayQueue();
        if (q.songs.length > 0) {
          const mappedTracks: Track[] = q.songs.map(songToTrack);

          let currentTrack = mappedTracks[0];
          let queueIndex = 0;

          if (q.current) {
            const idx = mappedTracks.findIndex(t => t.id === q.current);
            if (idx >= 0) { currentTrack = mappedTracks[idx]; queueIndex = idx; }
          }

          // Prefer the server position if available; otherwise keep the
          // localStorage-persisted currentTime (more reliable than server
          // queue position, which may not flush before app close).
          const serverTime = q.position ? q.position / 1000 : 0;
          const localTime = get().currentTime;
          set({
            queue: mappedTracks,
            queueIndex,
            currentTrack,
            currentTime: serverTime > 0 ? serverTime : localTime,
          });
          void refreshWaveformForTrack(currentTrack.id);
        }
      } catch (e) {
        console.error('Failed to initialize queue from server', e);
      }
    },

    reanalyzeLoudnessForTrack: async (trackId: string) => {
      try {
        showToast(i18n.t('queue.recalculatingLoudnessWaveform'), 2000, 'info');
      } catch {
        // no-op
      }
      await reseedLoudnessForTrackId(trackId);
    },

    reseedQueueForInstantMix: (track) => {
      const s = get();
      if (s.currentTrack?.id !== track.id) {
        get().playTrack(track, [track]);
        return;
      }
      pushQueueUndoFromGetter(get);
      const wasPlaying = s.isPlaying;
      set({
        queue: [track],
        queueIndex: 0,
        currentTrack: track,
      });
      syncQueueToServer([track], track, s.currentTime);
      if (!wasPlaying) get().resume();
    },
  };
}
