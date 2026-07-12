/**
 * Gapless queue advance: Rust already switched the audio source — update JS
 * store + side-effects without calling `playTrack` / `audio_play`.
 */
import { getMusicNetworkRuntimeOrNull } from '@/music-network';
import {
  playbackReportStart,
} from '@/features/playback/store/playbackReportSession';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import {
  clearPreloadingIds,
  getLastGaplessSwitchTime,
  markGaplessSwitch,
} from '@/features/playback/store/gaplessPreloadState';
import { touchHotCacheOnPlayback } from '@/features/playback/store/hotCacheTouch';
import { refreshLoudnessForTrack } from '@/features/playback/store/loudnessRefresh';
import { deriveNormalizationSnapshot } from '@/features/playback/store/normalizationSnapshot';
import { emitNormalizationDebug } from '@/features/playback/store/normalizationDebug';
import {
  emitPlaybackProgress,
} from '@/features/playback/store/playbackProgress';
import {
  resetProgressEmitThrottles,
} from '@/features/playback/store/playbackThrottles';
import {
  playbackSourceHintForResolvedUrl,
} from '@/features/playback/store/playbackUrlRouting';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { playListenSessionOnTrackSwitched } from '@/features/playback/store/playListenSession';
import { appendTimelineLeaveTrack } from '@/features/playback/store/timelineSessionHistory';
import {
  playbackCacheKeyForRef,
  playbackProfileIdForTrack,
} from '@/features/playback/utils/playback/playbackServer';
import { resolvePlaybackUrlForTrack } from '@/features/playback/utils/playback/resolvePlaybackUrl';
import { refreshWaveformForTrack } from '@/features/playback/store/waveformRefresh';
import { syncQueueToServer } from '@/features/playback/store/queueSync';
import { useAuthStore } from '@/store/authStore';
import { setIsAudioPaused } from '@/features/playback/store/engineState';
import {
  getLastEngineProgressSec,
  noteEngineProgressForGapless,
  resetGaplessProgressTracking,
} from '@/features/playback/store/gaplessProgressTracking';
import { isSeekDebouncePending } from '@/features/playback/store/seekDebounce';
import { getSeekTarget } from '@/features/playback/store/seekTargetState';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';

export type GaplessQueueAdvanceResult = {
  advanced: boolean;
  nextTrack: Track | null;
  newIndex: number;
};

/** Resolve the queue successor for a gapless engine transition. */
export function resolveGaplessSuccessor(
  queueItems: QueueItemRef[],
  queueIndex: number,
  repeatMode: 'off' | 'one' | 'all',
  currentTrack: Track | null,
): { nextTrack: Track | null; newIndex: number } {
  const nextIdx = queueIndex + 1;
  if (repeatMode === 'one' && currentTrack) {
    return { nextTrack: currentTrack, newIndex: queueIndex };
  }
  if (nextIdx < queueItems.length) {
    return {
      nextTrack: resolveQueueTrack(queueItems[nextIdx]),
      newIndex: nextIdx,
    };
  }
  if (repeatMode === 'all' && queueItems.length > 0) {
    return {
      nextTrack: resolveQueueTrack(queueItems[0]),
      newIndex: 0,
    };
  }
  return { nextTrack: null, newIndex: queueIndex };
}

function applyGaplessSuccessorUi(
  store: ReturnType<typeof usePlayerStore.getState>,
  nextTrack: Track,
  newIndex: number,
  source: 'track-switched' | 'progress-reconcile',
): void {
  const switchRef = store.queueItems[newIndex];
  const switchServerId = playbackCacheKeyForRef(switchRef);
  const switchResolvedUrl = resolvePlaybackUrlForTrack(nextTrack, switchServerId);
  const switchPlaybackSource = playbackSourceHintForResolvedUrl(
    nextTrack.id,
    switchServerId,
    switchResolvedUrl,
  );

  const switchPrev = store.currentTrack;
  const switchNextNextRef = newIndex + 1 < store.queueItems.length
    ? store.queueItems[newIndex + 1]
    : null;
  const switchNeighbourWindow: Track[] = [
    switchPrev ?? nextTrack,
    nextTrack,
    ...(switchNextNextRef ? [resolveQueueTrack(switchNextNextRef)] : []),
  ];

  resetProgressEmitThrottles();
  resetGaplessProgressTracking();
  usePlayerStore.setState({
    currentTrack: nextTrack,
    waveformBins: null,
    ...deriveNormalizationSnapshot(nextTrack, switchNeighbourWindow, 1),
    normalizationDbgSource: source,
    normalizationDbgTrackId: nextTrack.id,
    queueIndex: newIndex,
    isPlaying: true,
    isPlaybackBuffering: switchPlaybackSource === 'stream',
    progress: 0,
    currentTime: 0,
    buffered: 0,
    scrobbled: false,
    networkLoved: false,
    currentPlaybackSource: switchPlaybackSource,
  });
  emitPlaybackProgress({
    currentTime: 0,
    progress: 0,
    buffered: 0,
    buffering: switchPlaybackSource === 'stream',
  });

  emitNormalizationDebug(source, {
    trackId: nextTrack.id,
    queueIndex: newIndex,
    engineRequested: useAuthStore.getState().normalizationEngine,
  });
  void refreshWaveformForTrack(nextTrack.id);
  void refreshLoudnessForTrack(nextTrack.id);
  usePlayerStore.getState().updateReplayGainForCurrentTrack();

  playbackReportStart(nextTrack.id, playbackProfileIdForTrack(nextTrack, switchRef));
  const runtime = getMusicNetworkRuntimeOrNull();
  void runtime?.dispatchNowPlaying({
    title: nextTrack.title,
    artist: nextTrack.artist,
    album: nextTrack.album,
    duration: nextTrack.duration,
    timestamp: Date.now(),
  });
  if (runtime?.getEnrichmentPrimaryId()) {
    void runtime
      .isTrackLoved({ title: nextTrack.title, artist: nextTrack.artist })
      .then(loved => {
        usePlayerStore.getState().setNetworkLoved(loved);
      });
  }
  syncQueueToServer(store.queueItems, nextTrack, 0);
  touchHotCacheOnPlayback(nextTrack.id, switchServerId);
}

/**
 * Advance the queue UI to match a gapless engine transition. Returns whether
 * the store was updated (false when there is no successor or already advanced).
 */
export function applyGaplessQueueAdvance(opts?: {
  /** When set, patch duration on the successor if the resolver snapshot is thin. */
  engineDurationHint?: number;
  source?: 'track-switched' | 'progress-reconcile';
}): GaplessQueueAdvanceResult {
  const source = opts?.source ?? 'track-switched';
  const store = usePlayerStore.getState();
  const { queueItems, queueIndex, repeatMode, currentTrack, currentRadio } = store;
  if (currentRadio) {
    return { advanced: false, nextTrack: null, newIndex: queueIndex };
  }

  const { nextTrack: resolved, newIndex } = resolveGaplessSuccessor(
    queueItems,
    queueIndex,
    repeatMode,
    currentTrack,
  );
  if (!resolved) {
    return { advanced: false, nextTrack: null, newIndex: queueIndex };
  }

  const hint = opts?.engineDurationHint;
  const nextTrack = hint != null && hint > 0 && resolved.duration <= 0
    ? { ...resolved, duration: hint }
    : resolved;

  if (currentTrack && repeatMode !== 'one' && currentTrack.id === nextTrack.id && queueIndex === newIndex) {
    return { advanced: false, nextTrack, newIndex };
  }

  if (currentTrack && !currentRadio) {
    appendTimelineLeaveTrack(currentTrack, queueItems, queueIndex);
  }
  void playListenSessionOnTrackSwitched(nextTrack);
  applyGaplessSuccessorUi(store, nextTrack, newIndex, source);
  return { advanced: true, nextTrack, newIndex };
}

/**
 * When gapless is on and the engine position jumps backward mid-playback, the
 * Rust side likely switched sources without delivering `audio:track_switched`.
 */
export function maybeReconcileGaplessFromProgress(
  currentTime: number,
  engineDuration: number,
): void {
  if (!useAuthStore.getState().gaplessEnabled) return;
  if (isSeekDebouncePending() || getSeekTarget() !== null) return;
  const store = usePlayerStore.getState();
  if (!store.isPlaying || store.currentRadio || !store.currentTrack) return;
  if (Date.now() - getLastGaplessSwitchTime() < 400) return;

  const prevSec = getLastEngineProgressSec();
  // Gapless transitions restart near 0 — mid-track regressions are usually
  // buffering/seek glitches, not a decoder boundary without track_switched.
  const nearStart = currentTime < 8;
  const regressed = nearStart && currentTime + 1.5 < prevSec && prevSec > 8;
  if (!regressed) {
    noteEngineProgressForGapless(currentTime);
    return;
  }

  const { nextTrack, newIndex } = resolveGaplessSuccessor(
    store.queueItems,
    store.queueIndex,
    store.repeatMode,
    store.currentTrack,
  );
  if (!nextTrack || nextTrack.id === store.currentTrack.id) return;
  const slotRef = store.queueItems[store.queueIndex];
  if (!slotRef || slotRef.trackId !== store.currentTrack.id) return;
  if (store.repeatMode !== 'one' && newIndex <= store.queueIndex) return;

  applyGaplessQueueAdvance({
    engineDurationHint: engineDuration,
    source: 'progress-reconcile',
  });
  markGaplessSwitch();
  clearPreloadingIds();
  setIsAudioPaused(false);
  noteEngineProgressForGapless(currentTime);
}
