import { getSong } from '../api/subsonicLibrary';
import { invoke } from '@tauri-apps/api/core';
import { estimateLivePosition } from '../api/orbit';
import { setDeferHotCachePrefetch } from '../utils/hotCacheGate';
import { resolvePlaybackUrl } from '../utils/resolvePlaybackUrl';
import { resolveReplayGainDb } from '../utils/resolveReplayGainDb';
import { songToTrack } from '../utils/songToTrack';
import { useAuthStore } from './authStore';
import {
  bumpPlayGeneration,
  getIsAudioPaused,
  getPlayGeneration,
  setIsAudioPaused,
} from './engineState';
import { touchHotCacheOnPlayback } from './hotCacheTouch';
import {
  isReplayGainActive,
  loudnessGainDbForEngineBind,
} from './loudnessGainCache';
import { useOrbitStore } from './orbitStore';
import {
  playbackSourceHintForResolvedUrl,
  recordEnginePlayUrl,
} from './playbackUrlRouting';
import type { PlayerState } from './playerStoreTypes';
import { promoteCompletedStreamToHotCache } from './promoteStreamCache';
import { syncQueueToServer } from './queueSync';
import { resumeRadio } from './radioPlayer';
import { clearAllPlaybackScheduleTimers } from './scheduleTimers';

type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Resume playback from a paused state. Three mutually-exclusive
 * branches:
 *
 * 1. **Orbit guest** — catches the local player up to the host's live
 *    position. The user hit pause at some earlier point; resuming
 *    shouldn't drop them back at a stale local position while the
 *    host is already two songs ahead. Same-track → seek + un-pause;
 *    different-track → `playTrack` with a deferred seek.
 *
 * 2. **Radio** — HTML5 audio resume; no Rust engine involved.
 *
 * 3. **Regular track** — two sub-branches keyed off `getIsAudioPaused`:
 *    - **Warm**: engine still has the stream loaded but paused;
 *      `audio_resume` is enough.
 *    - **Cold**: engine has no loaded stream (app relaunch, or track
 *      ended and user hit play again). Promote any
 *      `stream_completed_cache` to hot disk, refetch the song from
 *      Navidrome for fresh ReplayGain metadata, call `audio_play`,
 *      then seek to the persisted `currentTime`. A `getSong` failure
 *      falls back to the in-memory `currentTrack`.
 */
export function runResume(set: SetState, get: GetState): void {
  clearAllPlaybackScheduleTimers();
  set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });

  // Orbit guest: resume means "catch up to the host's live stream".
  // The user hit pause at some earlier point; resuming shouldn't drop
  // them back at the stale local position while the host is already
  // two songs ahead. Covers PlayerBar, media keys, MPRIS — everything
  // that funnels through resume().
  const orbit = useOrbitStore.getState();
  const hostState = orbit.state;
  if (orbit.role === 'guest' && hostState?.isPlaying && hostState.currentTrack) {
    const trackId = hostState.currentTrack.trackId;
    const targetMs = estimateLivePosition(hostState, Date.now());
    const targetSec = Math.max(0, targetMs / 1000);
    const localTrackId = get().currentTrack?.id;
    void (async () => {
      try {
        const song = await getSong(trackId);
        if (!song) return;
        const track = songToTrack(song);
        const fraction = Math.max(0, Math.min(0.99, targetSec / Math.max(1, track.duration)));
        if (localTrackId === trackId) {
          // Same track: seek + un-pause via the Rust engine directly.
          // Bypasses this resume() branch re-entry via the early return below.
          get().seek(fraction);
          if (getIsAudioPaused()) {
            invoke('audio_resume').catch(console.error);
            setIsAudioPaused(false);
            set({ isPlaying: true });
          } else {
            set({ isPlaying: true });
          }
        } else {
          // Host has a different track — load it (`_orbitConfirmed=true`
          // skips the bulk gate; single-track play isn't a bulk replace
          // anyway). Seek after a short defer once the engine loads.
          get().playTrack(track, [track], false, true);
          window.setTimeout(() => {
            if (get().currentTrack?.id === trackId) get().seek(fraction);
          }, 400);
        }
      } catch { /* silent */ }
    })();
    return;
  }

  if (get().currentRadio) {
    resumeRadio().catch(console.error);
    set({ isPlaying: true });
    return;
  }
  const { currentTrack, queue, queueIndex, currentTime } = get();
  if (!currentTrack) return;
  const coldPrev = queueIndex > 0 ? queue[queueIndex - 1] : null;
  const coldNext = queueIndex + 1 < queue.length ? queue[queueIndex + 1] : null;

  if (getIsAudioPaused()) {
    // Rust engine has audio loaded but paused — just resume it.
    invoke('audio_resume').catch(console.error);
    setIsAudioPaused(false);
    set({ isPlaying: true });
    touchHotCacheOnPlayback(currentTrack.id, useAuthStore.getState().activeServerId ?? '');
  } else {
    // Engine has no loaded paused stream (app relaunch, or track ended and user
    // hits play — `isAudioPaused` is false after `audio:ended`). Flush any
    // `stream_completed_cache` from the prior play to hot disk before resolving URL.
    const gen = bumpPlayGeneration();
    const vol = get().volume;
    set({ isPlaying: true });

    void (async () => {
      const authHot = useAuthStore.getState();
      const resumePromoteSid = authHot.activeServerId;
      if (authHot.hotCacheEnabled && resumePromoteSid) {
        await promoteCompletedStreamToHotCache(
          currentTrack,
          resumePromoteSid,
          authHot.hotCacheDownloadDir || null,
        );
      }
      if (getPlayGeneration() !== gen) return;

      // Fetch fresh track data from server to get replay gain metadata
      getSong(currentTrack.id).then(freshSong => {
        if (getPlayGeneration() !== gen) return;
        const trackToPlay = freshSong ? songToTrack(freshSong) : currentTrack;
        // Update store with fresh track data if available
        if (freshSong) set({ currentTrack: trackToPlay });
        const authStateCold = useAuthStore.getState();
        const replayGainDbCold = resolveReplayGainDb(
          trackToPlay, coldPrev, coldNext,
          isReplayGainActive(), authStateCold.replayGainMode,
        );
        const replayGainPeakCold = isReplayGainActive() ? (trackToPlay.replayGainPeak ?? null) : null;
        const coldServerId = useAuthStore.getState().activeServerId ?? '';
        setDeferHotCachePrefetch(true);
        const coldUrl = resolvePlaybackUrl(trackToPlay.id, coldServerId);
        set({ currentPlaybackSource: playbackSourceHintForResolvedUrl(trackToPlay.id, coldServerId, coldUrl) });
        recordEnginePlayUrl(trackToPlay.id, coldUrl);
        touchHotCacheOnPlayback(trackToPlay.id, coldServerId);
        invoke('audio_play', {
          url: coldUrl,
          volume: vol,
          durationHint: trackToPlay.duration,
          replayGainDb: replayGainDbCold,
          replayGainPeak: replayGainPeakCold,
          loudnessGainDb: loudnessGainDbForEngineBind(trackToPlay.id),
          preGainDb: authStateCold.replayGainPreGainDb,
          fallbackDb: authStateCold.replayGainFallbackDb,
          manual: false,
          hiResEnabled: useAuthStore.getState().enableHiRes,
          analysisTrackId: trackToPlay.id,
          streamFormatSuffix: trackToPlay.suffix ?? null,
        }).then(() => {
          if (getPlayGeneration() === gen && currentTime > 1) {
            invoke('audio_seek', { seconds: currentTime }).catch(console.error);
          }
        }).catch((err: unknown) => {
          if (getPlayGeneration() !== gen) return;
          setDeferHotCachePrefetch(false);
          console.error('[psysonic] audio_play (cold resume) failed:', err);
          set({ isPlaying: false });
        });
        syncQueueToServer(queue, trackToPlay, currentTime);
      }).catch(() => {
        if (getPlayGeneration() !== gen) return;
        // Fallback to currentTrack if fetch fails
        const authStateCold = useAuthStore.getState();
        const replayGainDbCold = resolveReplayGainDb(
          currentTrack, coldPrev, coldNext,
          isReplayGainActive(), authStateCold.replayGainMode,
        );
        const replayGainPeakCold = isReplayGainActive() ? (currentTrack.replayGainPeak ?? null) : null;
        const coldServerId = useAuthStore.getState().activeServerId ?? '';
        setDeferHotCachePrefetch(true);
        const coldUrl = resolvePlaybackUrl(currentTrack.id, coldServerId);
        set({ currentPlaybackSource: playbackSourceHintForResolvedUrl(currentTrack.id, coldServerId, coldUrl) });
        recordEnginePlayUrl(currentTrack.id, coldUrl);
        touchHotCacheOnPlayback(currentTrack.id, coldServerId);
        invoke('audio_play', {
          url: coldUrl,
          volume: vol,
          durationHint: currentTrack.duration,
          replayGainDb: replayGainDbCold,
          replayGainPeak: replayGainPeakCold,
          loudnessGainDb: loudnessGainDbForEngineBind(currentTrack.id),
          preGainDb: authStateCold.replayGainPreGainDb,
          fallbackDb: authStateCold.replayGainFallbackDb,
          manual: false,
          hiResEnabled: useAuthStore.getState().enableHiRes,
          analysisTrackId: currentTrack.id,
          streamFormatSuffix: currentTrack.suffix ?? null,
        }).catch((err: unknown) => {
          if (getPlayGeneration() !== gen) return;
          setDeferHotCachePrefetch(false);
          console.error('[psysonic] audio_play (cold resume) failed:', err);
          set({ isPlaying: false });
        });
        syncQueueToServer(queue, currentTrack, currentTime);
      });
    })();
  }
}
