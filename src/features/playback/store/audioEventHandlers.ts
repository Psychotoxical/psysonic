import { scrobbleSong } from '@/lib/api/subsonicScrobble';
import {
  playbackReportPlaying,
  playbackReportStopped,
} from '@/features/playback/store/playbackReportSession';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import { audioPreload, audioSetAutodjSuppress } from '@/lib/api/audio';
import { getMusicNetworkRuntimeOrNull } from '@/music-network';
import { setDeferHotCachePrefetch } from '@/lib/cache/hotCacheGate';
import { notifyLibraryPlaybackHint } from '@/features/playback/store/libraryPlaybackHint';
import {
  playListenSessionFinalize,
  playListenSessionOnProgress,
  playListenSessionOpen,
} from '@/features/playback/store/playListenSession';
import { appendTimelineLeaveTrack } from '@/features/playback/store/timelineSessionHistory';
import { getPerfProbeFlags } from '@/lib/perf/perfFlags';
import { bumpPerfCounter } from '@/lib/perf/perfTelemetry';
import {
  getPlaybackCacheServerKey,
  getPlaybackIndexKey,
  playbackCacheKeyForRef,
  playbackProfileIdForRef,
  playbackProfileIdForTrack,
} from '@/features/playback/utils/playback/playbackServer';
import { resolvePlaybackUrlForTrack } from '@/features/playback/utils/playback/resolvePlaybackUrl';
import { requestGaplessChainPreload } from '@/features/playback/store/gaplessChainPreload';
import {
  applyGaplessQueueAdvance,
  maybeReconcileGaplessFromProgress,
} from '@/features/playback/store/gaplessQueueAdvance';
import { noteEngineProgressForGapless } from '@/features/playback/store/gaplessProgressTracking';
import { showToast } from '@/lib/dom/toast';
import { useAuthStore } from '@/store/authStore';
import { getPlayGeneration, setIsAudioPaused } from '@/features/playback/store/engineState';
import {
  clearPreloadingIds,
  getBytePreloadingId,
  getGaplessPreloadingId,
  getLastGaplessSwitchTime,
  markGaplessSwitch,
  setBytePreloadingId,
} from '@/features/playback/store/gaplessPreloadState';
import { refreshLoudnessForTrack } from '@/features/playback/store/loudnessRefresh';
import {
  emitPlaybackProgress,
  getPlaybackProgressSnapshot,
} from '@/features/playback/store/playbackProgress';
import {
  LIVE_PROGRESS_EMIT_MIN_DELTA_SEC,
  LIVE_PROGRESS_EMIT_MIN_MS,
  STORE_PROGRESS_COMMIT_MIN_DELTA_SEC,
  STORE_PROGRESS_COMMIT_MIN_MS,
  getLastLiveProgressEmitAt,
  getLastStoreProgressCommitAt,
  markLiveProgressEmit,
  markStoreProgressCommit,
  resetProgressEmitThrottles,
} from '@/features/playback/store/playbackThrottles';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { promoteCompletedStreamToHotCache } from '@/features/playback/store/promoteStreamCache';
import {
  getLastQueueHeartbeatAt,
  flushQueueSyncToServer,
} from '@/features/playback/store/queueSync';
import { clearQueueNaturallyEnded } from '@/features/playback/store/queuePlaybackIdle';
import { isSeekDebouncePending } from '@/features/playback/store/seekDebounce';
import {
  SEEK_FALLBACK_VISUAL_GUARD_MS,
  getSeekFallbackVisualTarget,
  setSeekFallbackVisualTarget,
} from '@/features/playback/store/seekFallbackState';
import {
  SEEK_TARGET_GUARD_TIMEOUT_MS,
  clearSeekTarget,
  getSeekTarget,
  getSeekTargetSetAt,
} from '@/features/playback/store/seekTargetState';
import { analyzeBoundary, computeWaveformSilence } from '@/lib/waveform/waveformSilence';
import { autodjMaxOverlapCapSec } from '@/lib/audio/autodjOverlapCap';
import {
  autodjJsTriggerAtSec,
  clampCrossfadeSecs,
  computeAutodjJsOverlap,
  nextQueueRefForTransition,
  shouldJsDriveAutodjTransition,
} from '@/features/playback/utils/playback/autodjAutoAdvance';
import { isInterruptHandoffPending } from '@/features/playback/utils/playback/autodjInterruptPrep';
import { isCrossfadeNextReady, maybeCrossfadeBytePreload } from '@/features/playback/store/crossfadePreload';
import { armCrossfadeDynamicOverlap, getCrossfadeTransition } from '@/features/playback/store/crossfadeTrimCache';
import { armAutodjMixing } from '@/features/playback/store/autodjTransitionUi';

// Silence-aware crossfade (A-tail): guards the early advance to once per play
// generation so a single playback instance triggers at most one trim-advance
// (re-arms automatically on the next play / repeat-all loop, never loops on a
// backward seek within the same playback).
let crossfadeTrimAdvanceGen = -1;
let autodjEngineMixArmGen = -1;

// AutoDJ: mirror of the engine's `autodj_suppress_autocrossfade` flag so we only
// invoke the setter on change. When a content fade is pending for the upcoming
// transition we suppress the engine's autonomous crossfade timer and let the JS
// A-tail advance drive it (gated on the next track being playable) — otherwise
// the engine would start a still-buffering next track and fade over it (a jump).
let autodjSuppressSent: boolean | null = null;
function syncAutodjSuppress(want: boolean): void {
  if (autodjSuppressSent === want) return;
  autodjSuppressSent = want;
  audioSetAutodjSuppress({ enabled: want }).catch(() => {});
}

/** Rust-side `audio:normalization-state` event payload. */
export type NormalizationStatePayload = {
  engine: 'off' | 'replaygain' | 'loudness' | string;
  currentGainDb: number | null;
  targetLufs: number;
};

export function handleAudioPlaying(duration: number): void {
  clearQueueNaturallyEnded();
  setDeferHotCachePrefetch(false);
  resetProgressEmitThrottles();
  usePlayerStore.setState({ isPlaying: true, isPlaybackBuffering: false });
  notifyLibraryPlaybackHint('playing');
  const { currentTrack: track, queueItems, queueIndex } = usePlayerStore.getState();
  if (track) {
    const ref = queueItems[queueIndex];
    void playListenSessionOpen(track, playbackProfileIdForTrack(track, ref), duration);
    // Engine-confirmed play (initial start + resume) — keep live now-playing in
    // the `playing` state for servers with the playbackReport extension.
    playbackReportPlaying();
  }
}

export function handleAudioProgress(
  current_time: number,
  duration: number,
  buffering = false,
): void {
  bumpPerfCounter('audioProgressEvents');
  const perfFlags = getPerfProbeFlags();
  const progressUiDisabled = perfFlags.disablePlayerProgressUi;
  // While a seek is pending, the store already holds the optimistic target
  // position.  Accepting stale progress from the Rust engine would briefly
  // snap the waveform back to the old position before the seek completes.
  if (isSeekDebouncePending()) return;
  // After the debounce fires, Rust may still emit 1–2 ticks with the old
  // position before the seek takes effect.  Block until current_time is
  // within 2 s of the requested target, then clear the guard.
  const activeSeekTarget = getSeekTarget();
  if (activeSeekTarget !== null) {
    if (Math.abs(current_time - activeSeekTarget) > 2.0) {
      // If a seek command hangs while streaming is stalled, do not freeze UI.
      if (Date.now() - getSeekTargetSetAt() <= SEEK_TARGET_GUARD_TIMEOUT_MS) return;
      clearSeekTarget();
    } else {
      clearSeekTarget();
      noteEngineProgressForGapless(current_time);
    }
  }

  const store = usePlayerStore.getState();
  const track = store.currentTrack;
  if (!track) return;
  if (!buffering) {
    maybeReconcileGaplessFromProgress(current_time, duration);
  }
  if (!store.currentRadio && store.isPlaybackBuffering !== buffering) {
    usePlayerStore.setState({ isPlaybackBuffering: buffering });
  }
  // Some backends can emit stale progress ticks shortly after pause/stop.
  // Ignoring them avoids reactivating UI redraw loops while transport is idle.
  const transportActive = store.isPlaying || store.currentRadio != null;
  let visualTarget = getSeekFallbackVisualTarget();
  if (!transportActive && !visualTarget) return;
  if (visualTarget && visualTarget.trackId !== track.id) {
    setSeekFallbackVisualTarget(null);
    visualTarget = null;
  }
  let displayTime = buffering ? 0 : current_time;
  if (visualTarget && visualTarget.trackId === track.id) {
    const nearTarget = Math.abs(current_time - visualTarget.seconds) <= 2.0;
    if (nearTarget) {
      setSeekFallbackVisualTarget(null);
      visualTarget = null;
    } else if (Date.now() - visualTarget.setAtMs <= SEEK_FALLBACK_VISUAL_GUARD_MS) {
      // Keep UI at the requested position while backend catches up.
      displayTime = visualTarget.seconds;
    } else {
      setSeekFallbackVisualTarget(null);
      visualTarget = null;
    }
  }
  const dur = duration > 0 ? duration : track.duration;
  if (dur <= 0) return;
  if (!buffering) {
    noteEngineProgressForGapless(current_time);
  }
  const progress = displayTime / dur;
  playListenSessionOnProgress(current_time, buffering, dur).catch(() => {});
  if (!progressUiDisabled) {
    const nowLive = Date.now();
    const live = getPlaybackProgressSnapshot();
    const liveTimeDelta = Math.abs(live.currentTime - displayTime);
    if (
      nowLive - getLastLiveProgressEmitAt() >= LIVE_PROGRESS_EMIT_MIN_MS ||
      liveTimeDelta >= LIVE_PROGRESS_EMIT_MIN_DELTA_SEC ||
      visualTarget != null
    ) {
      emitPlaybackProgress({
        currentTime: displayTime,
        progress: buffering ? 0 : progress,
        buffered: 0,
        buffering,
      });
      markLiveProgressEmit(nowLive);
    }
  }
  // Heartbeat: push current position to the server every 15 s while playing so
  // cross-device resume works even on a hard close — pause() and the close
  // handler flush on top of this for clean shutdowns.
  if (store.isPlaying && !store.currentRadio) {
    const now = Date.now();
    if (now - getLastQueueHeartbeatAt() >= 15_000) {
      void flushQueueSyncToServer(store.queueItems, track, displayTime);
      // Same 15 s cadence keeps the server's now-playing position fresh so it
      // can extrapolate accurately between reports (playbackReport extension).
      playbackReportPlaying(displayTime);
    }
  }

  // Scrobble at 50%: Music Network + Navidrome (updates play_date / recently played)
  if (progress >= 0.5 && !store.scrobbled) {
    usePlayerStore.setState({ scrobbled: true });
    scrobbleSong(
      track.id,
      Date.now(),
      playbackProfileIdForTrack(track, store.queueItems[store.queueIndex]),
    );
    void getMusicNetworkRuntimeOrNull()?.dispatchScrobble({
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      timestamp: Date.now(),
    });
  }
  if (progressUiDisabled) return;
  // Critical architectural guard: avoid high-frequency writes to the persisted
  // Zustand store (each write serializes queue state). Keep only coarse commits.
  const nowCommit = Date.now();
  const commitDelta = Math.abs(store.currentTime - displayTime);
  const shouldCommitStore =
    visualTarget != null ||
    nowCommit - getLastStoreProgressCommitAt() >= STORE_PROGRESS_COMMIT_MIN_MS ||
    commitDelta >= STORE_PROGRESS_COMMIT_MIN_DELTA_SEC;
  if (shouldCommitStore) {
    usePlayerStore.setState({ currentTime: displayTime, progress, buffered: 0 });
    markStoreProgressCommit(nowCommit);
  }

  // Pre-buffer / pre-chain next track for gapless and crossfade.
  const {
    gaplessEnabled,
    crossfadeEnabled,
    crossfadeSecs,
    crossfadeTrimSilence,
  } = useAuthStore.getState();
  const remaining = dur - current_time;

  // Silence-aware crossfade — current track's trailing silence, derived once
  // from its cached waveform. Drives both the early A-tail advance AND a wider
  // pre-buffer window (the early advance must not outrun the next track's
  // download, or its stream starts late and the fade has nothing to overlap).
  const trimActive =
    crossfadeEnabled && crossfadeTrimSilence && !gaplessEnabled && !store.currentRadio;
  const curTrailSilenceSec = trimActive
    ? computeWaveformSilence(store.waveformBins, dur).trailSilenceSec
    : 0;

  // A-tail: start the next track early so the fade overlaps *audible* tail/head.
  // Overlap is content-driven ("by fact"); loud→loud always uses the standard
  // ~2 s JS blend (not the engine crossfadeSecs slider). When JS drives we
  // suppress the engine's autonomous crossfade timer so B is readiness-gated.
  let autodjSuppressWant = false;
  const nextRef = trimActive && store.isPlaying && store.repeatMode !== 'one'
    ? nextQueueRefForTransition(store.queueItems, store.queueIndex, store.repeatMode)
    : null;
  const nextTrackId = nextRef ? resolveQueueTrack(nextRef)?.id : undefined;
  if (trimActive && store.isPlaying && store.repeatMode !== 'one') {
    if (nextTrackId) {
      const cf = clampCrossfadeSecs(crossfadeSecs);
      const plan = getCrossfadeTransition(nextTrackId);
      let contentOverlap: number;
      // Scenario A: does A carry its own recorded fade-out? If so we let it ride
      // at full engine gain (no double fade) and bring B up underneath.
      let aRidesOwnFade: boolean;
      if (plan && plan.overlapSec > 0) {
        contentOverlap = plan.overlapSec;
        aRidesOwnFade = plan.outgoingFadeSec <= 0.001;
      } else {
        // No next-track envelope (cold plan) → judge A from its own waveform.
        const aShape = analyzeBoundary(store.waveformBins, dur);
        contentOverlap = aShape.outroFadeSec;
        aRidesOwnFade = aShape.outroFadeSec >= 1.0;
      }
      if (shouldJsDriveAutodjTransition(curTrailSilenceSec, contentOverlap, cf, aRidesOwnFade)) {
        autodjSuppressWant = true;
        const maxCapSec = autodjMaxOverlapCapSec(useAuthStore.getState());
        const { overlapSec, outgoingFadeSec } = computeAutodjJsOverlap(contentOverlap, aRidesOwnFade, maxCapSec);
        const triggerAt = autodjJsTriggerAtSec(dur, curTrailSilenceSec, overlapSec);
        const gen = getPlayGeneration();
        // Readiness gate: only advance when B's audio is actually available (RAM
        // preload slot or local on disk). A cold stream can't sustain a stable
        // fade, so we leave the gen guard unset and re-check on later ticks — if
        // B readies before A ends we fade then; if never, A plays out (engine
        // timer suppressed) and the source-exhaustion end gives a clean cut.
        if (
          current_time >= triggerAt
          && crossfadeTrimAdvanceGen !== gen
          && isCrossfadeNextReady(
            nextTrackId,
            playbackProfileIdForRef(nextRef),
            playbackCacheKeyForRef(nextRef),
          )
        ) {
          crossfadeTrimAdvanceGen = gen;
          armCrossfadeDynamicOverlap(nextTrackId, overlapSec, outgoingFadeSec);
          armAutodjMixing(overlapSec);
          store.next(false);
          return;
        }
      }
    } else {
      // Queue tail with no successor — play A through its real ending; suppress
      // the engine's early crossfade timer so `audio:ended` fires on exhaustion.
      autodjSuppressWant = true;
    }
  }
  syncAutodjSuppress(autodjSuppressWant);

  if (trimActive && store.isPlaying && !autodjSuppressWant && nextTrackId) {
    const cf = clampCrossfadeSecs(crossfadeSecs);
    if (remaining > 0 && remaining <= cf) {
      const gen = getPlayGeneration();
      if (autodjEngineMixArmGen !== gen) {
        autodjEngineMixArmGen = gen;
        armAutodjMixing(cf);
      }
    }
  }

  // Crossfade pre-buffer (next-track byte download + leading-silence probe).
  // Self-gating; also invoked right after a seek into the window (see seekAction).
  maybeCrossfadeBytePreload(current_time, dur);

  const shouldChainGapless = gaplessEnabled && remaining < 30 && remaining > 0;

  if (gaplessEnabled) {
    const { queueItems, queueIndex, repeatMode } = store;
    const nextIdx = queueIndex + 1;
    // Next track for preload/chain. The resolver bridge keeps the window around
    // queueIndex warm, so the next ref is cache-hot; resolveQueueTrack falls
    // back to a placeholder (correct trackId, so URL building still works) on a
    // cold miss. current track = `track` (full) — never resolved.
    const nextRef = repeatMode === 'one'
      ? null
      : (nextIdx < queueItems.length ? queueItems[nextIdx] : (repeatMode === 'all' ? queueItems[0] : null));
    const nextTrack = repeatMode === 'one'
      ? track
      : (nextRef ? resolveQueueTrack(nextRef) : null);

    if (nextTrack && nextTrack.id !== track.id) {
      // Gapless backup: keep next-track bytes ready even if chain/decode misses
      // the boundary. Start earlier for larger files / slower conservative link.
      const estBytes = (() => {
        if (typeof nextTrack.size === 'number' && Number.isFinite(nextTrack.size) && nextTrack.size > 0) {
          return nextTrack.size;
        }
        const kbps = typeof nextTrack.bitRate === 'number' && Number.isFinite(nextTrack.bitRate) && nextTrack.bitRate > 0
          ? nextTrack.bitRate
          : 320;
        return Math.max(256 * 1024, Math.ceil((nextTrack.duration || 240) * kbps * 1000 / 8));
      })();
      const conservativeBytesPerSec = 300 * 1024; // ~2.4 Mbps effective throughput
      const estDownloadSecs = estBytes / conservativeBytesPerSec;
      const gaplessBackupWindowSecs = Math.max(15, Math.min(60, Math.ceil(estDownloadSecs * 1.4 + 8)));
      const shouldBytePreloadForGaplessBackup =
        gaplessEnabled && remaining < gaplessBackupWindowSecs && remaining > 0;

      const serverId = nextRef ? playbackCacheKeyForRef(nextRef) : getPlaybackCacheServerKey();
      const analysisServerId = nextRef
        ? playbackCacheKeyForRef(nextRef)
        : getPlaybackIndexKey();
      const nextUrl = resolvePlaybackUrlForTrack(nextTrack, serverId);

      // Byte pre-download — gapless backup; runs early so bytes are ready by chain time.
      if (
        shouldBytePreloadForGaplessBackup
        && nextTrack.id !== getBytePreloadingId()
      ) {
        setBytePreloadingId(nextTrack.id);
        // Loudness cache only — do not call refreshWaveformForTrack(next): it writes global
        // waveformBins and would replace the current track's seekbar while still playing it.
        void refreshLoudnessForTrack(nextTrack.id, { syncPlayingEngine: false });
        if (import.meta.env.DEV) {
          console.info('[psysonic][preload-request]', {
            nextTrackId: nextTrack.id,
            nextUrl,
            shouldBytePreloadForGaplessBackup,
            remaining,
            gaplessEnabled,
          });
        }
        audioPreload({
          url: nextUrl,
          durationHint: nextTrack.duration,
          analysisTrackId: nextTrack.id,
          serverId: analysisServerId || null,
        }).catch(() => {});
      }

      // Gapless chain — decode + chain into Sink 30s before track boundary.
      if (shouldChainGapless && nextTrack.id !== getGaplessPreloadingId()) {
        requestGaplessChainPreload({
          currentTrack: track,
          nextTrack,
          nextRef,
          nextIdx,
          queueItems,
          repeatMode,
          volume: store.volume,
        });
      }
    }
  }
}

export function handleAudioEnded(): void {
  notifyLibraryPlaybackHint('idle');

  if (Date.now() - getLastGaplessSwitchTime() < 600) {
    return;
  }

  if (isInterruptHandoffPending()) {
    return;
  }

  void playListenSessionFinalize('ended');
  // Track finished — clear live now-playing. A follow-on track (next / repeat)
  // opens a fresh session via playbackReportStart.
  void playbackReportStopped();

  const storeBeforeAdvance = usePlayerStore.getState();
  if (storeBeforeAdvance.currentTrack && !storeBeforeAdvance.currentRadio) {
    appendTimelineLeaveTrack(
      storeBeforeAdvance.currentTrack,
      storeBeforeAdvance.queueItems,
      storeBeforeAdvance.queueIndex,
    );
  }

  // Radio stream disconnected — just stop; don't advance queue.
  if (usePlayerStore.getState().currentRadio) {
    setIsAudioPaused(false);
    usePlayerStore.setState({ isPlaying: false, currentRadio: null, progress: 0, currentTime: 0 });
    return;
  }

  const { repeatMode, currentTrack, queueIndex } = usePlayerStore.getState();
  setIsAudioPaused(false);
  usePlayerStore.setState({
    isPlaying: false,
    isPlaybackBuffering: false,
    progress: 0,
    currentTime: 0,
    buffered: 0,
  });
  setTimeout(() => {
    void (async () => {
      if (repeatMode === 'one' && currentTrack) {
        const authState = useAuthStore.getState();
        const repeatPromoteSid = getPlaybackCacheServerKey();
        if (authState.hotCacheEnabled && repeatPromoteSid) {
          // Same-track repeat never hit `playTrack`'s prev→promote path; flush
          // Rust `stream_completed_cache` to disk so `resolvePlaybackUrl` uses local.
          await promoteCompletedStreamToHotCache(
            currentTrack,
            repeatPromoteSid,
            authState.hotCacheDownloadDir || null,
          );
        }
        // Pin to the current slot — the track may appear elsewhere in the queue.
        // No-arg queue: playTrack keeps the canonical refs and just re-binds.
        usePlayerStore.getState().playTrack(currentTrack, undefined, false, false, queueIndex);
      } else {
        usePlayerStore.getState().next(false);
      }
    })();
  }, 150);
}

/**
 * Handle gapless auto-advance: the Rust engine has already switched to the
 * next source sample-accurately. We just need to update the UI state without
 * touching the audio stream (no playTrack() call!).
 */
export function handleAudioTrackSwitched(duration: number): void {
  markGaplessSwitch();
  clearPreloadingIds();
  setIsAudioPaused(false);

  const store = usePlayerStore.getState();
  if (store.currentTrack?.id) {
    useAuthStore.getState().clearSkipStarManualCountForTrack(store.currentTrack.id);
  }

  applyGaplessQueueAdvance({
    engineDurationHint: duration,
    source: 'track-switched',
  });
}

export function handleAudioError(message: string): void {
  console.error('[psysonic] Audio error from backend:', message);
  setIsAudioPaused(false);
  void playbackReportStopped();

  const detail = message.length > 80 ? message.slice(0, 80) + '…' : message;
  showToast(`Couldn't play track — skipping. ${detail}`, 8000, 'error');

  const gen = getPlayGeneration();
  usePlayerStore.setState({ isPlaying: false, isPlaybackBuffering: false });
  setTimeout(() => {
    if (getPlayGeneration() !== gen) return;
    usePlayerStore.getState().next(false);
  }, 1500);
}
