import type { Track } from './playerStoreTypes';
import { invoke } from '@tauri-apps/api/core';
import { setDeferHotCachePrefetch } from '../utils/cache/hotCacheGate';
import {
  getPlaybackIndexKey,
  playbackCacheKeyForTrack,
} from '../utils/playback/playbackServer';
import { resolvePlaybackUrl } from '../utils/playback/resolvePlaybackUrl';
import { resolveReplayGainDb } from '../utils/audio/resolveReplayGainDb';
import { audioPlayHiResBlendArgs } from '../utils/audio/hiResCrossfadeResample';
import { useAuthStore } from './authStore';
import { getPlayGeneration, setIsAudioPaused } from './engineState';
import { touchHotCacheOnPlayback } from './hotCacheTouch';
import { isReplayGainActive, loudnessGainDbForEngineBind } from './loudnessGainCache';
import { playbackSourceHintForResolvedUrl, recordEnginePlayUrl } from './playbackUrlRouting';
import { usePlayerStore } from './playerStore';

/**
 * Load a track into the Rust engine at `atSeconds`, optionally leaving transport
 * playing or paused. Shared by queue-undo restore and cold-start paused prepare.
 */
export function engineLoadTrackAtPosition(opts: {
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
  const playbackCacheSid = playbackCacheKeyForTrack(track);
  const playbackIndexKey = playbackCacheKeyForTrack(track) || getPlaybackIndexKey();
  const url = resolvePlaybackUrl(track.id, playbackCacheSid);
  recordEnginePlayUrl(track.id, url);
  usePlayerStore.setState({
    currentPlaybackSource: playbackSourceHintForResolvedUrl(track.id, playbackCacheSid, url),
  });
  const keepPreloadHint = usePlayerStore.getState().enginePreloadedTrackId === track.id;
  const startPaused = !wantPlaying;
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
    ...audioPlayHiResBlendArgs(authState),
    analysisTrackId: track.id,
    serverId: playbackIndexKey || null,
    streamFormatSuffix: track.suffix ?? null,
    startPaused,
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
          if (!startPaused) {
            invoke('audio_pause').catch(console.error);
          }
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
      console.error('[psysonic] engineLoadTrackAtPosition failed:', err);
      usePlayerStore.setState({ isPlaying: false });
    })
    .finally(() => {
      setDeferHotCachePrefetch(false);
    });
  touchHotCacheOnPlayback(track.id, playbackCacheSid);
}
