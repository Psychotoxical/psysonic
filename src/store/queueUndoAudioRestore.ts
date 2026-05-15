import type { Track } from './playerStoreTypes';
import { invoke } from '@tauri-apps/api/core';
import { setDeferHotCachePrefetch } from '../utils/cache/hotCacheGate';
import { getPlaybackServerId } from '../utils/playback/playbackServer';
import { resolvePlaybackUrl } from '../utils/playback/resolvePlaybackUrl';
import { resolveReplayGainDb } from '../utils/audio/resolveReplayGainDb';
import { useAuthStore } from './authStore';
import { getPlayGeneration, setIsAudioPaused } from './engineState';
import { touchHotCacheOnPlayback } from './hotCacheTouch';
import { isReplayGainActive, loudnessGainDbForEngineBind } from './loudnessGainCache';
import { playbackSourceHintForResolvedUrl, recordEnginePlayUrl } from './playbackUrlRouting';
import { usePlayerStore } from './playerStore';
/**
 * Reload the Rust audio engine to match a queue-undo snapshot. Zustand
 * alone can rewrite the queue + currentTrack, but the engine is still
 * playing whatever cold-started before the undo — so we need a full
 * `audio_play` (+ optional `audio_seek` to the snapshot position) to
 * line the audible playback back up with the restored UI state.
 *
 * Captures the play-generation at start so a later concurrent `playTrack`
 * (e.g. user clicks another track) invalidates the seek/pause follow-up
 * without clobbering the new engine state.
 */
export function queueUndoRestoreAudioEngine(opts: {
  generation: number;
  track: Track;
  queue: Track[];
  queueIndex: number;
  atSeconds: number;
  wantPlaying: boolean;
}): void {
  const { generation, track, queue, queueIndex, atSeconds, wantPlaying } = opts;
  const authState = useAuthStore.getState();
  const vol = usePlayerStore.getState().volume;
  const coldPrev = queueIndex > 0 ? queue[queueIndex - 1] : null;
  const coldNext = queueIndex + 1 < queue.length ? queue[queueIndex + 1] : null;
  const replayGainDb = resolveReplayGainDb(
    track, coldPrev, coldNext,
    isReplayGainActive(), authState.replayGainMode,
  );
  const replayGainPeak = isReplayGainActive() ? (track.replayGainPeak ?? null) : null;
  const playbackSid = getPlaybackServerId();
  const url = resolvePlaybackUrl(track.id, playbackSid);
  recordEnginePlayUrl(track.id, url);
  usePlayerStore.setState({
    currentPlaybackSource: playbackSourceHintForResolvedUrl(track.id, playbackSid, url),
  });
  const keepPreloadHint = usePlayerStore.getState().enginePreloadedTrackId === track.id;
  setDeferHotCachePrefetch(true);
  invoke('audio_play', {
    url,
    volume: vol,
    durationHint: track.duration,
    replayGainDb,
    replayGainPeak,
    loudnessGainDb: loudnessGainDbForEngineBind(track.id),
    preGainDb: authState.replayGainPreGainDb,
    fallbackDb: authState.replayGainFallbackDb,
    manual: false,
    hiResEnabled: authState.enableHiRes,
    analysisTrackId: track.id,
    streamFormatSuffix: track.suffix ?? null,
  })
    .then(() => {
      if (getPlayGeneration() !== generation) return;
      if (keepPreloadHint) {
        usePlayerStore.setState({ enginePreloadedTrackId: null });
      }
      const dur = track.duration && track.duration > 0 ? track.duration : null;
      const seekTo = Math.max(0, atSeconds);
      const canSeek = seekTo > 0.05 && (dur == null || seekTo < dur - 0.05);
      const afterSeek = () => {
        if (getPlayGeneration() !== generation) return;
        if (!wantPlaying) {
          invoke('audio_pause').catch(console.error);
          setIsAudioPaused(true);
          usePlayerStore.setState({ isPlaying: false });
        } else {
          setIsAudioPaused(false);
        }
      };
      if (canSeek) {
        void invoke('audio_seek', { seconds: seekTo }).then(afterSeek).catch(afterSeek);
      } else {
        afterSeek();
      }
    })
    .catch((err: unknown) => {
      if (getPlayGeneration() !== generation) return;
      console.error('[psysonic] queue-undo audio_play failed:', err);
      usePlayerStore.setState({ isPlaying: false });
    })
    .finally(() => {
      setDeferHotCachePrefetch(false);
    });
  touchHotCacheOnPlayback(track.id, getPlaybackServerId());
}
