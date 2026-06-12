import type { QueueItemRef, Track } from './playerStoreTypes';
import { getQueueTracksView } from '../utils/library/queueTrackView';
import { scheduleHotCachePrefetchForTrack } from '../hotCachePrefetch';
import { getPlaybackCacheServerKey } from '../utils/playback/playbackServer';
import { useAuthStore } from './authStore';
import { bumpPlayGeneration, getPlayGeneration } from './engineState';
import { engineLoadTrackAtPosition } from './engineLoadTrackAtPosition';
import { emitPlaybackProgress } from './playbackProgress';
import { promoteCompletedStreamToHotCache } from './promoteStreamCache';
import { usePlayerStore } from './playerStore';
import { setSeekFallbackVisualTarget } from './seekFallbackState';

/** Push restored position into the store + progress channel so the seekbar paints immediately. */
export function applyRestoredPlaybackVisual(track: Track, atSeconds: number): void {
  const dur = track.duration > 0 ? track.duration : 0;
  const seconds = Math.max(0, atSeconds);
  const progress = dur > 0 ? Math.min(1, seconds / dur) : 0;
  usePlayerStore.setState({ currentTime: seconds, progress, buffered: 0 });
  emitPlaybackProgress({
    currentTime: seconds,
    progress,
    buffered: 0,
    buffering: false,
  });
  if (seconds > 0.05) {
    setSeekFallbackVisualTarget({
      trackId: track.id,
      seconds,
      setAtMs: Date.now(),
    });
  }
}

/**
 * After `getPlayQueue` restores a paused session: show the saved seek position,
 * prefetch bytes for the current track, and load the engine paused at that spot
 * so the next Play is a warm `audio_resume`.
 */
export function preparePausedRestoreOnStartup(
  track: Track,
  queueItems: QueueItemRef[],
  queueIndex: number,
  atSeconds: number,
): void {
  const player = usePlayerStore.getState();
  if (player.isPlaying || player.currentRadio) return;

  applyRestoredPlaybackVisual(track, atSeconds);
  scheduleHotCachePrefetchForTrack(track, getPlaybackCacheServerKey());

  const generation = bumpPlayGeneration();
  void (async () => {
    const auth = useAuthStore.getState();
    const promoteSid = getPlaybackCacheServerKey();
    if (auth.hotCacheEnabled && promoteSid) {
      await promoteCompletedStreamToHotCache(
        track,
        promoteSid,
        auth.hotCacheDownloadDir || null,
      );
    }
    if (getPlayGeneration() !== generation) return;
    if (usePlayerStore.getState().isPlaying) return;

    const queue = getQueueTracksView(queueItems, [track]);
    engineLoadTrackAtPosition({
      generation,
      track,
      queue,
      queueIndex,
      atSeconds,
      wantPlaying: false,
    });
  })();
}
