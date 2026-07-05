import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { getQueueTracksView } from '@/features/playback/store/queueTrackView';
import { scheduleHotCachePrefetchForTrack } from '@/hotCachePrefetch';
import { getPlaybackCacheServerKey, playbackCacheKeyForTrack } from '@/features/playback/utils/playback/playbackServer';
import { prepareTrackForEngineBind } from '@/features/playback/utils/audio/prepareTrackForEngineBind';
import { useAuthStore } from '@/store/authStore';
import { bumpPlayGeneration, getPlayGeneration } from '@/features/playback/store/engineState';
import { engineLoadTrackAtPosition } from '@/features/playback/store/engineLoadTrackAtPosition';
import { emitPlaybackProgress } from '@/features/playback/store/playbackProgress';
import { promoteCompletedStreamToHotCache } from '@/features/playback/store/promoteStreamCache';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { setSeekFallbackVisualTarget } from '@/features/playback/store/seekFallbackState';

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

    const metadataSid =
      playbackCacheKeyForTrack(track)
      || getPlaybackCacheServerKey()
      || '';
    const trackForEngine = metadataSid
      ? await prepareTrackForEngineBind(track, metadataSid)
      : track;
    if (getPlayGeneration() !== generation) return;
    if (usePlayerStore.getState().isPlaying) return;

    const queue = getQueueTracksView(queueItems, [trackForEngine]);
    engineLoadTrackAtPosition({
      generation,
      track: trackForEngine,
      queue,
      queueIndex,
      atSeconds,
      wantPlaying: false,
    });
  })();
}
