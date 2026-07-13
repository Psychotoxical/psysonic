import { commands } from '@/generated/bindings';
import { applyServerPlayQueue } from '@/features/playback/store/applyServerPlayQueue';
import { audioSeek, audioSetVolume, audioStop } from '@/lib/api/audio';
import i18n from '@/lib/i18n';
import { showToast } from '@/lib/dom/toast';
import { useAuthStore } from '@/store/authStore';
import {
  bumpPlayGeneration,
  setIsAudioPaused,
} from '@/features/playback/store/engineState';
import { clearPreloadingIds } from '@/features/playback/store/gaplessPreloadState';
import { reseedLoudnessForTrackId } from '@/features/playback/store/loudnessReseed';
import { getPlaybackProgressSnapshot } from '@/features/playback/store/playbackProgress';
import { shouldRebindPlaybackToHotCache } from '@/features/playback/store/playbackUrlRouting';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';
import { pushQueueUndoFromGetter } from '@/features/playback/store/queueUndo';
import { syncUserQueueMutationToServer } from '@/features/playback/store/queueSync';
import {
  clearRadioReconnectTimer,
  playRadioStream,
  prepareRadioPlaybackFromUserGesture,
  setRadioVolume,
} from '@/features/playback/store/radioPlayer';
import { clearAllPlaybackScheduleTimers } from '@/features/playback/store/scheduleTimers';
import { clearSeekDebounce } from '@/features/playback/store/seekDebounce';
import {
  clearSeekFallbackRetry,
  setSeekFallbackVisualTarget,
} from '@/features/playback/store/seekFallbackState';
import { clearSeekTarget } from '@/features/playback/store/seekTargetState';

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
      prepareRadioPlaybackFromUserGesture();
      bumpPlayGeneration();
      clearAllPlaybackScheduleTimers();
      set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });
      setIsAudioPaused(false);
      clearRadioReconnectTimer();
      clearPreloadingIds();
      clearSeekFallbackRetry();
      clearSeekDebounce(); clearSeekTarget();
      // Stop Rust engine in case a regular track was playing.
      audioStop().catch(() => {});
      // Resolve PLS/M3U playlist URLs to the actual stream URL before handing
      // to HTML5 <audio> — the browser cannot play playlist files directly.
      const streamUrl = await commands.resolveStreamUrl(station.streamUrl)
        .catch(() => station.streamUrl);
      const { replayGainFallbackDb } = useAuthStore.getState();
      const fallbackFactor = replayGainFallbackDb !== 0 ? Math.pow(10, replayGainFallbackDb / 20) : 1;
      try {
        await playRadioStream(streamUrl, Math.min(1, volume * fallbackFactor));
      } catch (err: unknown) {
        console.error('[psysonic] radio HTML5 play failed:', err);
        showToast('Radio stream error', 3000, 'error');
        set({ isPlaying: false, currentRadio: null });
        return;
      }
      set({
        currentRadio: station,
        currentTrack: null,
        waveformBins: null,
        normalizationNowDb: null,
        normalizationTargetLufs: null,
        normalizationEngineLive: 'off',
        currentPlaybackSource: null,
        queueItems: [],
        queueIndex: 0,
        isPlaying: true,
        progress: 0,
        currentTime: 0,
        buffered: 0,
        scrobbled: true, // no scrobbling for radio
      });
    },

    previous: () => {
      const { queueItems, queueIndex, currentTrack } = get();
      const currentTime = getPlaybackProgressSnapshot().currentTime;
      if (currentTime > 3) {
        // Restart current track from the beginning.
        const authState = useAuthStore.getState();
        const sid = authState.activeServerId ?? '';
        if (currentTrack && shouldRebindPlaybackToHotCache(currentTrack.id, sid)) {
          setSeekFallbackVisualTarget({ trackId: currentTrack.id, seconds: 0, setAtMs: Date.now() });
          // No-arg queue: keep the canonical refs, restart in place.
          get().playTrack(currentTrack, undefined, true);
          return;
        }
        audioSeek({ seconds: 0 }).catch(console.error);
        set({ progress: 0, currentTime: 0 });
        return;
      }
      const prevIdx = queueIndex - 1;
      if (prevIdx >= 0 && queueItems[prevIdx]) {
        // Resolve the previous ref (resolver cache → placeholder); pass undefined
        // for the queue arg so playTrack just moves the index.
        get().playTrack(resolveQueueTrack(queueItems[prevIdx]), undefined, true, false, prevIdx);
      }
    },

    setVolume: (v) => {
      const clamped = Math.max(0, Math.min(1, v));
      audioSetVolume({ volume: clamped }).catch(console.error);
      setRadioVolume(clamped);
      set({ volume: clamped });
    },

    setProgress: (t, duration) => {
      set({ currentTime: t, progress: duration > 0 ? t / duration : 0 });
    },

    initializeFromServerQueue: async () => {
      const activeId = useAuthStore.getState().activeServerId;
      if (!activeId) return;
      await applyServerPlayQueue(activeId, { mode: 'startup' });
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
      const sid = s.queueServerId ?? '';
      if (sid) seedQueueResolver(sid, [track]);
      const newItems = toQueueItemRefs(sid, [track]);
      set({
        queueItems: newItems,
        queueIndex: 0,
        currentTrack: track,
      });
      syncUserQueueMutationToServer(newItems, track, s.currentTime);
      if (!wasPlaying) get().resume();
    },
  };
}
