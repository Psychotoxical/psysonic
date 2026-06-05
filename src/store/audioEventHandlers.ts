import { reportNowPlaying, scrobbleSong } from '../api/subsonicScrobble';
import type { Track } from './playerStoreTypes';
import { resolveQueueTrack } from '../utils/library/queueTrackView';
import { invoke } from '@tauri-apps/api/core';
import { lastfmGetTrackLoved, lastfmScrobble, lastfmUpdateNowPlaying } from '../api/lastfm';
import { setDeferHotCachePrefetch } from '../utils/cache/hotCacheGate';
import { notifyLibraryPlaybackHint } from './libraryPlaybackHint';
import {
  playListenSessionFinalize,
  playListenSessionOnProgress,
  playListenSessionOnTrackSwitched,
  playListenSessionOpen,
} from './playListenSession';
import { getPerfProbeFlags } from '../utils/perf/perfFlags';
import { bumpPerfCounter } from '../utils/perf/perfTelemetry';
import {
  getPlaybackCacheServerKey,
  getPlaybackIndexKey,
  getPlaybackServerId,
} from '../utils/playback/playbackServer';
import { resolvePlaybackUrl } from '../utils/playback/resolvePlaybackUrl';
import { resolveReplayGainDb } from '../utils/audio/resolveReplayGainDb';
import { showToast } from '../utils/ui/toast';
import { useAuthStore } from './authStore';
import { getPlayGeneration, setIsAudioPaused } from './engineState';
import {
  clearPreloadingIds,
  getBytePreloadingId,
  getGaplessPreloadingId,
  getLastGaplessSwitchTime,
  markGaplessSwitch,
  setBytePreloadingId,
  setGaplessPreloadingId,
} from './gaplessPreloadState';
import { touchHotCacheOnPlayback } from './hotCacheTouch';
import {
  isReplayGainActive,
  loudnessGainDbForEngineBind,
} from './loudnessGainCache';
import { refreshLoudnessForTrack } from './loudnessRefresh';
import { deriveNormalizationSnapshot } from './normalizationSnapshot';
import { emitNormalizationDebug } from './normalizationDebug';
import {
  emitPlaybackProgress,
  getPlaybackProgressSnapshot,
} from './playbackProgress';
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
} from './playbackThrottles';
import {
  playbackSourceHintForResolvedUrl,
} from './playbackUrlRouting';
import { usePlayerStore } from './playerStore';
import { promoteCompletedStreamToHotCache } from './promoteStreamCache';
import {
  flushQueueSyncToServer,
  getLastQueueHeartbeatAt,
  syncQueueToServer,
} from './queueSync';
import { isSeekDebouncePending } from './seekDebounce';
import {
  SEEK_FALLBACK_VISUAL_GUARD_MS,
  getSeekFallbackVisualTarget,
  setSeekFallbackVisualTarget,
} from './seekFallbackState';
import {
  SEEK_TARGET_GUARD_TIMEOUT_MS,
  clearSeekTarget,
  getSeekTarget,
  getSeekTargetSetAt,
} from './seekTargetState';
import { refreshWaveformForTrack } from './waveformRefresh';

/** Rust-side `audio:normalization-state` event payload. */
export type NormalizationStatePayload = {
  engine: 'off' | 'replaygain' | 'loudness' | string;
  currentGainDb: number | null;
  targetLufs: number;
};

export function handleAudioPlaying(duration: number): void {
  setDeferHotCachePrefetch(false);
  resetProgressEmitThrottles();
  usePlayerStore.setState({ isPlaying: true, isPlaybackBuffering: false });
  notifyLibraryPlaybackHint('playing');
  const track = usePlayerStore.getState().currentTrack;
  if (track) {
    void playListenSessionOpen(track, getPlaybackServerId(), duration);
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
    }
  }

  const store = usePlayerStore.getState();
  const track = store.currentTrack;
  if (!track) return;
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
    }
  }

  // Scrobble at 50%: Last.fm + Navidrome (updates play_date / recently played)
  if (progress >= 0.5 && !store.scrobbled) {
    usePlayerStore.setState({ scrobbled: true });
    scrobbleSong(track.id, Date.now(), getPlaybackServerId());
    const { scrobblingEnabled, lastfmSessionKey } = useAuthStore.getState();
    if (scrobblingEnabled && lastfmSessionKey) {
      lastfmScrobble(track, Date.now(), lastfmSessionKey);
    }
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
    hotCacheEnabled,
    crossfadeEnabled,
    crossfadeSecs,
  } = useAuthStore.getState();
  const remaining = dur - current_time;

  const shouldChainGapless = gaplessEnabled && remaining < 30 && remaining > 0;
  // Crossfade needs the next track bytes ready before the fade window.
  const crossfadeWindowSecs = Math.max(8, Math.min(30, crossfadeSecs + 6));
  const shouldBytePreloadForCrossfade =
    !hotCacheEnabled && !gaplessEnabled && crossfadeEnabled && remaining < crossfadeWindowSecs && remaining > 0;

  if (shouldChainGapless || shouldBytePreloadForCrossfade || gaplessEnabled) {
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
    if (!nextTrack || nextTrack.id === track.id) return;

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

    const serverId = getPlaybackCacheServerKey();
    const analysisServerId = getPlaybackIndexKey();
    const nextUrl = resolvePlaybackUrl(nextTrack.id, serverId);

    // Byte pre-download — gapless backup or crossfade; runs early so bytes are ready by chain time.
    if (
      (shouldBytePreloadForCrossfade || shouldBytePreloadForGaplessBackup)
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
          shouldBytePreloadForCrossfade,
          shouldBytePreloadForGaplessBackup,
          remaining,
          gaplessEnabled,
        });
      }
      invoke('audio_preload', {
        url: nextUrl,
        durationHint: nextTrack.duration,
        analysisTrackId: nextTrack.id,
        serverId: analysisServerId || null,
      }).catch(() => {});
    }

    // Gapless chain — decode + chain into Sink 30s before track boundary.
    if (shouldChainGapless && nextTrack.id !== getGaplessPreloadingId()) {
      setGaplessPreloadingId(nextTrack.id);
      // Ensure loudness gain is already cached for the chained request payload.
      void refreshLoudnessForTrack(nextTrack.id, { syncPlayingEngine: false });
      const authState = useAuthStore.getState();
      // Auto-mode neighbours for the *next* track: current track on its left,
      // queueItems[nextIdx+1] on its right (resolved; placeholder on a cold miss
      // — only its replaygain tags matter, which a placeholder lacks → fallback).
      const nextNeighbourRef = nextIdx + 1 < queueItems.length
        ? queueItems[nextIdx + 1]
        : (repeatMode === 'all' && queueItems.length > 0 ? queueItems[0] : null);
      const nextNeighbour = nextNeighbourRef ? resolveQueueTrack(nextNeighbourRef) : null;
      const replayGainDb = resolveReplayGainDb(
        nextTrack, track, nextNeighbour,
        isReplayGainActive(), authState.replayGainMode,
      );
      const replayGainPeak = isReplayGainActive()
        ? (nextTrack.replayGainPeak ?? null)
        : null;
      invoke('audio_chain_preload', {
        url: nextUrl,
        volume: store.volume,
        durationHint: nextTrack.duration,
        replayGainDb,
        replayGainPeak,
        loudnessGainDb: loudnessGainDbForEngineBind(nextTrack.id),
        preGainDb: authState.replayGainPreGainDb,
        fallbackDb: authState.replayGainFallbackDb,
        hiResEnabled: authState.enableHiRes,
        analysisTrackId: nextTrack.id,
        serverId: analysisServerId || null,
      }).catch(() => {});
    }
  }
}

export function handleAudioEnded(): void {
  notifyLibraryPlaybackHint('idle');

  if (Date.now() - getLastGaplessSwitchTime() < 600) {
    return;
  }

  void playListenSessionFinalize('ended');

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
export function handleAudioTrackSwitched(_duration: number): void {
  markGaplessSwitch();
  clearPreloadingIds(); // allow preloading for the track after this one
  setIsAudioPaused(false);

  const store = usePlayerStore.getState();
  if (store.currentTrack?.id) {
    useAuthStore.getState().clearSkipStarManualCountForTrack(store.currentTrack.id);
  }
  const { queueItems, queueIndex, repeatMode } = store;
  const nextIdx = queueIndex + 1;
  let nextTrack: Track | null = null;
  let newIndex = queueIndex;

  if (repeatMode === 'one' && store.currentTrack) {
    nextTrack = store.currentTrack;
    // queueIndex stays the same
  } else if (nextIdx < queueItems.length) {
    // The Rust engine already chained this source sample-accurately, so it must
    // have been preloaded — meaning the resolver had it cached. resolveQueueTrack
    // returns the full Track from cache (placeholder only on an unexpected miss).
    nextTrack = resolveQueueTrack(queueItems[nextIdx]);
    newIndex = nextIdx;
  } else if (repeatMode === 'all' && queueItems.length > 0) {
    nextTrack = resolveQueueTrack(queueItems[0]);
    newIndex = 0;
  }

  if (!nextTrack) return;

  void playListenSessionOnTrackSwitched(nextTrack);

  const switchServerId = getPlaybackCacheServerKey();
  const switchResolvedUrl = resolvePlaybackUrl(nextTrack.id, switchServerId);
  const switchPlaybackSource = playbackSourceHintForResolvedUrl(nextTrack.id, switchServerId, switchResolvedUrl);

  // Neighbour window for normalization (replaygain album-mode reads prev/next).
  // current track on the left, the track after `nextTrack` on the right.
  const switchPrev = store.currentTrack;
  const switchNextNextRef = newIndex + 1 < queueItems.length ? queueItems[newIndex + 1] : null;
  const switchNeighbourWindow: Track[] = [
    switchPrev ?? nextTrack,
    nextTrack,
    ...(switchNextNextRef ? [resolveQueueTrack(switchNextNextRef)] : []),
  ];

  usePlayerStore.setState({
    currentTrack: nextTrack,
    waveformBins: null,
    ...deriveNormalizationSnapshot(nextTrack, switchNeighbourWindow, 1),
    normalizationDbgSource: 'track-switched',
    normalizationDbgTrackId: nextTrack.id,
    queueIndex: newIndex,
    isPlaying: true,
    isPlaybackBuffering: switchPlaybackSource === 'stream',
    progress: 0,
    currentTime: 0,
    buffered: 0,
    scrobbled: false,
    lastfmLoved: false,
    currentPlaybackSource: switchPlaybackSource,
  });
  emitNormalizationDebug('track-switched', {
    trackId: nextTrack.id,
    queueIndex: newIndex,
    engineRequested: useAuthStore.getState().normalizationEngine,
  });
  void refreshWaveformForTrack(nextTrack.id);
  void refreshLoudnessForTrack(nextTrack.id);
  usePlayerStore.getState().updateReplayGainForCurrentTrack();

  // Report Now Playing to Navidrome + Last.fm
  const { nowPlayingEnabled, scrobblingEnabled, lastfmSessionKey } = useAuthStore.getState();
  if (nowPlayingEnabled) reportNowPlaying(nextTrack.id, getPlaybackServerId());
  if (lastfmSessionKey) {
    if (scrobblingEnabled) lastfmUpdateNowPlaying(nextTrack, lastfmSessionKey);
    lastfmGetTrackLoved(nextTrack.title, nextTrack.artist, lastfmSessionKey).then(loved => {
      const cacheKey = `${nextTrack!.title}::${nextTrack!.artist}`;
      usePlayerStore.setState(s => ({
        lastfmLoved: loved,
        lastfmLovedCache: { ...s.lastfmLovedCache, [cacheKey]: loved },
      }));
    });
  }
  syncQueueToServer(queueItems, nextTrack, 0);
  touchHotCacheOnPlayback(nextTrack.id, getPlaybackCacheServerKey());
}

export function handleAudioError(message: string): void {
  console.error('[psysonic] Audio error from backend:', message);
  setIsAudioPaused(false);

  const detail = message.length > 80 ? message.slice(0, 80) + '…' : message;
  showToast(`Couldn't play track — skipping. ${detail}`, 8000, 'error');

  const gen = getPlayGeneration();
  usePlayerStore.setState({ isPlaying: false, isPlaybackBuffering: false });
  setTimeout(() => {
    if (getPlayGeneration() !== gen) return;
    usePlayerStore.getState().next(false);
  }, 1500);
}
