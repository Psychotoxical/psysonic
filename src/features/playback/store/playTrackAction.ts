import { playbackReportStart, playbackReportStopped } from '@/features/playback/store/playbackReportSession';
import { invoke } from '@tauri-apps/api/core';
import { audioSeek } from '@/lib/api/audio';
import { getMusicNetworkRuntimeOrNull } from '@/music-network';
import { setDeferHotCachePrefetch } from '@/lib/cache/hotCacheGate';
import { orbitBulkGuard, orbitSnapshot } from '@/store/orbitRuntime';
import { sameQueueTrackId } from '@/features/playback/utils/playback/queueIdentity';
import {
  computeAutodjManualBlendPlan,
  shouldAutodjInterruptBlend,
} from '@/features/playback/utils/playback/autodjManualBlend';
import type { CrossfadeTransitionPlan } from '@/lib/waveform/waveformSilence';
import {
  armInterruptHandoff,
  clearInterruptHandoff,
  runInterruptBlendPrep,
  shouldDeferInterruptHandoffUi,
} from '@/features/playback/utils/playback/autodjInterruptPrep';
import { isCrossfadeNextReady } from '@/features/playback/store/crossfadePreload';
import { STANDARD_BLEND_SEC } from '@/lib/waveform/waveformSilence';
import { armAutodjMixing, clearAutodjTransitionUi } from '@/features/playback/store/autodjTransitionUi';
import {
  bindQueueServerForTracks,
  getPlaybackCacheServerKey,
  getPlaybackIndexKey,
  playbackCacheKeyForTrack,
  playbackProfileIdForTrack,
  shouldBindQueueServerForPlay,
} from '@/features/playback/utils/playback/playbackServer';
import { stampTrackServerId, stampTrackServerIds } from '@/lib/media/trackServerScope';
import {
  findLocalPlaybackUrl,
  hasLocalPersistentPlaybackBytes,
} from '@/store/localPlaybackResolve';
import { resolvePlaybackUrl } from '@/features/playback/utils/playback/resolvePlaybackUrl';
import { resolveReplayGainDb } from '@/features/playback/utils/audio/resolveReplayGainDb';
import { enrichTrackPlaybackMetadata } from '@/features/playback/utils/audio/enrichTrackReplayGainMetadata';
import { audioPlayHiResBlendArgs } from '@/lib/audio/hiResCrossfadeResample';
import { useAuthStore } from '@/store/authStore';
import { consumeCrossfadeDynamicOverlap, getCrossfadeTransition, peekArmedCrossfadeDynamicOverlap } from '@/features/playback/store/crossfadeTrimCache';
import {
  bumpPlayGeneration,
  getPlayGeneration,
  setIsAudioPaused,
} from '@/features/playback/store/engineState';
import { clearPreloadingIds,
  getLastGaplessSwitchTime,
} from '@/features/playback/store/gaplessPreloadState';
import { resetGaplessProgressTracking } from '@/features/playback/store/gaplessProgressTracking';
import { touchHotCacheOnPlayback } from '@/features/playback/store/hotCacheTouch';
import {
  isReplayGainActive,
  loudnessGainDbForEngineBind,
} from '@/features/playback/store/loudnessGainCache';
import { refreshLoudnessForTrack } from '@/features/playback/store/loudnessRefresh';
import { fetchWaveformBins, refreshWaveformForTrack } from '@/features/playback/store/waveformRefresh';
import { deriveNormalizationSnapshot } from '@/features/playback/store/normalizationSnapshot';
import {
  playbackSourceHintForResolvedUrl,
  recordEnginePlayUrl,
} from '@/features/playback/store/playbackUrlRouting';
import type { Track } from '@/lib/media/trackTypes';
import type { PlayerState } from '@/features/playback/store/playerStoreTypes';
import { toQueueItemRefs } from '@/features/playback/store/queueItemRef';
import { getQueueTracksView, resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import { seedQueueResolver } from '@/features/playback/store/queueTrackResolver';
import { promoteCompletedStreamToHotCache } from '@/features/playback/store/promoteStreamCache';
import { pushQueueOnPlaybackStart } from '@/features/playback/store/queueSync';
import { playListenSessionFinalize } from '@/features/playback/store/playListenSession';
import { pushQueueUndoFromGetter } from '@/features/playback/store/queueUndo';
import { appendTimelineLeaveTrack } from '@/features/playback/store/timelineSessionHistory';
import { stopRadio } from '@/features/playback/store/radioPlayer';
import { clearAllPlaybackScheduleTimers } from '@/features/playback/store/scheduleTimers';
import { clearSeekDebounce } from '@/features/playback/store/seekDebounce';
import {
  clearSeekFallbackRetry,
  getSeekFallbackVisualTarget,
  setSeekFallbackRestartAt,
  setSeekFallbackTrackId,
  setSeekFallbackVisualTarget,
} from '@/features/playback/store/seekFallbackState';
import {
  clearSeekTarget,
  setSeekTarget,
} from '@/features/playback/store/seekTargetState';
type SetState = (
  partial: Partial<PlayerState> | ((state: PlayerState) => Partial<PlayerState>),
) => void;
type GetState = () => PlayerState;

/**
 * Play a track, optionally replacing the queue and/or jumping to an
 * explicit slot. Three guard layers run before the actual play body:
 *
 * 1. **Orbit bulk-gate** — when `queue.length > 1` and isn't a no-op
 *    replace of the current queue, prompt via `orbitBulkGuard`; on
 *    confirm, hosts/guests append (Orbit semantics — bulk replace
 *    would drop guest suggestions) and non-Orbit users replace as
 *    normal.
 * 2. **Orbit-host single-track protection** — a `playTrack(track,
 *    [track])` from a host would blow away the shared queue; re-route
 *    to append-and-jump so guest suggestions survive.
 * 3. **Ghost-command guard** — a playTrack arriving within 500 ms of
 *    the last gapless switch is almost certainly a stale IPC echo.
 *
 * The play body itself: clears all scheduled timers + seek state,
 * resolves the URL, updates store + normalization snapshot
 * optimistically, invokes the Rust engine, and on success seeks to
 * the visual target if there was a pending one. Falls back to
 * `next(false)` 500 ms after an `audio_play` failure. Same-track
 * replays first flush the previous play's `stream_completed_cache`
 * to hot disk so `fetch_data` doesn't re-run an HTTP range request.
 */
export function runPlayTrack(
  set: SetState,
  get: GetState,
  track: Track,
  queue: Track[] | undefined,
  manual: boolean,
  _orbitConfirmed: boolean,
  targetQueueIndex: number | undefined,
): void {
  // Orbit bulk-gate: only gate when the `queue` argument *replaces*
  // the current queue (Play All / Play Album / Play Playlist / Hero
  // play buttons). Navigation calls — queue-row click, next(),
  // previous() — pass the existing queue back through playTrack just
  // to move the index; they are not bulk operations and must not
  // trigger the confirm dialog (#234 regression).
  if (!_orbitConfirmed && queue && queue.length > 1) {
    const current = get().queueItems;
    const sameAsCurrent = queue.length === current.length
      && queue.every((t, i) => sameQueueTrackId(current[i]?.trackId, t.id));
    if (!sameAsCurrent) {
      void orbitBulkGuard(queue.length).then(ok => {
        if (!ok) return;
        // Inside an Orbit session a bulk replace would discard guest
        // suggestions mid-listen. Append instead — the dialog's
        // "Add them all" copy already matches that semantic. Outside
        // Orbit, proceed as a normal replace.
        const role = orbitSnapshot().role;
        if (role === 'host' || role === 'guest') {
          get().enqueue(queue, true);
        } else {
          get().playTrack(track, queue, manual, true);
        }
      });
      return;
    }
  }

  // Orbit-host single-track protection. The host's `playerStore.queue`
  // *is* the shared Orbit queue. A `playTrack(track, [track])` call
  // (e.g. OfflineLibrary's "Play this album" on a single-track album,
  // or any other surface that explicitly passes a 1-track replacement
  // queue) would otherwise blow away every guest suggestion + every
  // upcoming track. Re-route to append + jump so the queue survives.
  // Guest stays unguarded — a guest clicking Play locally is choosing
  // to opt out of host-sync, which is the existing "guest is running
  // their own show" path. `useOrbitGuest`'s `syncToHost` is also a
  // guest-only call site, so it's never intercepted here.
  if (!_orbitConfirmed && queue && queue.length === 1) {
    const orbitRole = orbitSnapshot().role;
    if (orbitRole === 'host') {
      const currentItems = get().queueItems;
      const currentTrackId = currentItems[get().queueIndex]?.trackId;
      if (track.id !== currentTrackId) {
        const existsAt = currentItems.findIndex(r => sameQueueTrackId(r.trackId, track.id));
        if (existsAt >= 0) {
          // Re-jump within the existing queue: pass undefined so playTrack keeps
          // the canonical queueItems and just moves the index.
          get().playTrack(track, undefined, manual, true, existsAt);
        } else {
          // Append the single track to the resolved current queue and jump to it.
          const newQueue = [...getQueueTracksView(currentItems), track];
          get().playTrack(track, newQueue, manual, true, newQueue.length - 1);
        }
        return;
      }
    }
  }

  // Ghost-command guard: if a gapless switch happened within 500 ms,
  // this playTrack call is likely a stale IPC echo — suppress it.
  if (Date.now() - getLastGaplessSwitchTime() < 500) {
    return;
  }

  void playListenSessionFinalize('skip');

  const stateBeforeLeave = get();
  const prevTrackForHistory = stateBeforeLeave.currentTrack;
  const scopedTrackEarly = stampTrackServerId(track);
  if (
    prevTrackForHistory
    && !sameQueueTrackId(prevTrackForHistory.id, scopedTrackEarly.id)
  ) {
    appendTimelineLeaveTrack(
      prevTrackForHistory,
      stateBeforeLeave.queueItems,
      stateBeforeLeave.queueIndex,
    );
  }

  const scopedTrack = scopedTrackEarly;
  const scopedQueue = queue ? stampTrackServerIds(queue) : queue;

  clearAllPlaybackScheduleTimers();
  set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });

  const gen = bumpPlayGeneration();
  clearInterruptHandoff();
  setIsAudioPaused(false);
  clearPreloadingIds(); // new track — allow fresh preload for next
  clearSeekDebounce(); clearSeekTarget();
  clearSeekFallbackRetry();
  setSeekFallbackRestartAt(0);

  // If a radio stream is active, stop it before the new track starts so
  // the PlayerBar clears radio mode immediately and the stream is released.
  if (get().currentRadio) {
    stopRadio();
  }

  const state = get();
  const wasPlayingBeforeSkip = state.isPlaying;
  const skipFromTimeSec = state.currentTime;
  const outgoingWaveformBins = state.waveformBins;
  const prevTrack = state.currentTrack;
  if (prevTrack?.id !== scopedTrack.id) {
    setSeekFallbackTrackId(null);
  }
  const visualOnEntry = getSeekFallbackVisualTarget();
  if (visualOnEntry?.trackId !== scopedTrack.id) {
    setSeekFallbackVisualTarget(null);
  }
  // Thin-state: only a real queue *replacement* (explicit `queue` arg) rebuilds
  // queueItems. A no-arg navigation (next/previous/queue-row jump) keeps the
  // canonical refs and just moves the index — so we never resolve the whole
  // queue here (O(visible), not O(queue length)), which would hitch + churn
  // every subscriber on each track change at scale.
  const replacing = scopedQueue !== undefined;
  const srcLen = replacing ? scopedQueue.length : state.queueItems.length;
  if (replacing && shouldBindQueueServerForPlay(state.queueItems, scopedQueue, scopedQueue)) {
    bindQueueServerForTracks(scopedQueue);
  }
  // Prefer an explicit target index from the caller (next/previous/queue-row
  // click already know the exact slot). `findIndex` returns the *first*
  // matching id, which jumps backwards when the queue contains the same
  // track twice — breaking radio playback (issue #500).
  const matchesAt = (i: number): boolean =>
    replacing
      ? sameQueueTrackId(scopedQueue[i]?.id, scopedTrack.id)
      : sameQueueTrackId(state.queueItems[i]?.trackId, scopedTrack.id);
  const explicitIdxValid =
    typeof targetQueueIndex === 'number'
    && targetQueueIndex >= 0
    && targetQueueIndex < srcLen
    && matchesAt(targetQueueIndex);
  const idx = explicitIdxValid
    ? (targetQueueIndex as number)
    : replacing
      ? scopedQueue.findIndex(t => sameQueueTrackId(t.id, scopedTrack.id))
      : state.queueItems.findIndex(r => sameQueueTrackId(r.trackId, scopedTrack.id));
  const playIdx = idx >= 0 ? idx : 0;
  const playingRef = replacing ? undefined : state.queueItems[playIdx];
  const prevPlayingRef = replacing ? undefined : state.queueItems[state.queueIndex];
  const prevPlaybackSid = prevTrack && prevPlayingRef
    ? playbackProfileIdForTrack(prevTrack, prevPlayingRef) ?? ''
    : '';
  const nextPlaybackSid = playbackProfileIdForTrack(scopedTrack, playingRef) ?? '';
  if (
    prevTrack
    && !sameQueueTrackId(prevTrack.id, scopedTrack.id)
    && prevPlaybackSid
    && nextPlaybackSid
    && prevPlaybackSid !== nextPlaybackSid
  ) {
    void playbackReportStopped(skipFromTimeSec);
  }
  // ±1 neighbours for replaygain normalization — resolve only these (not the
  // whole queue). On replace they come from the provided Track[]; on navigation
  // from the resolver cache (the bridge keeps that window warm).
  const neighbourAt = (i: number): Track | null => {
    if (i < 0 || i >= srcLen) return null;
    if (replacing) return scopedQueue[i] ?? null;
    if (i === playIdx) return scopedTrack;
    const ref = state.queueItems[i];
    return ref ? resolveQueueTrack(ref) : null;
  };
  const prevNeighbour = neighbourAt(playIdx - 1);
  const nextNeighbour = neighbourAt(playIdx + 1);
  // Minimal window so deriveNormalizationSnapshot reads ±1 without a full array.
  const normWindow: Track[] = prevNeighbour ? [prevNeighbour] : [];
  const normIdx = normWindow.length;
  normWindow.push(scopedTrack);
  if (nextNeighbour) normWindow.push(nextNeighbour);
  if (manual) {
    pushQueueUndoFromGetter(get);
  }
  const visualForInitial = getSeekFallbackVisualTarget();
  const pendingVisualTarget = visualForInitial?.trackId === scopedTrack.id
    ? visualForInitial.seconds
    : null;
  const initialTime = pendingVisualTarget !== null
    ? Math.max(0, Math.min(pendingVisualTarget, scopedTrack.duration || pendingVisualTarget))
    : 0;
  const initialProgress =
    scopedTrack.duration && scopedTrack.duration > 0
      ? Math.max(0, Math.min(1, initialTime / scopedTrack.duration))
      : 0;

  const authState = useAuthStore.getState();
  const playbackProfileId = playbackProfileIdForTrack(scopedTrack, playingRef);
  const libraryLocalUrl = playbackProfileId
    ? findLocalPlaybackUrl(scopedTrack.id, playbackProfileId, 'library')
    : null;
  // Same-track replay: Rust `fetch_data` consumes `stream_completed_cache` with
  // `take()` once; a second replay would full HTTP-range again unless we flush
  // RAM to hot disk first (promote was only run when switching to another track).
  const needSameTrackHotPromote =
    !libraryLocalUrl
    && !(playbackProfileId && hasLocalPersistentPlaybackBytes(scopedTrack.id, playbackProfileId))
    && Boolean(
      prevTrack
      && sameQueueTrackId(prevTrack.id, scopedTrack.id)
      && authState.hotCacheEnabled
      && getPlaybackCacheServerKey(),
    );

  const runPlayTrackBody = (trackForPlay: Track) => {
    const playNormWindow = normWindow.map((t, i) => (i === normIdx ? trackForPlay : t));
    const authStateNow = useAuthStore.getState();
    const playbackSid = playbackProfileIdForTrack(trackForPlay, playingRef);
    const playbackCacheSid = playbackCacheKeyForTrack(trackForPlay, playingRef);
    const url = libraryLocalUrl
      ?? findLocalPlaybackUrl(trackForPlay.id, playbackSid, 'library')
      ?? findLocalPlaybackUrl(trackForPlay.id, playbackSid, 'favorite-auto')
      ?? resolvePlaybackUrl(trackForPlay.id, playbackCacheSid);
    recordEnginePlayUrl(trackForPlay.id, url);
    const preloadedTrackId = get().enginePreloadedTrackId;
    const keepPreloadHint = preloadedTrackId === trackForPlay.id;
    const playbackSourceHint = playbackSourceHintForResolvedUrl(
      trackForPlay.id,
      playbackCacheSid,
      url,
    );
    if (import.meta.env.DEV) {
      console.info('[psysonic][playTrack-source]', {
        trackId: trackForPlay.id,
        resolvedUrl: url,
        preloadedTrackId,
        keepPreloadHint,
        playbackSourceHint,
      });
    }

    // Set state immediately so the UI updates before the download completes.
    // currentRadio: null ensures the PlayerBar switches out of radio mode right away.
    const queueSid = get().queueServerId ?? '';
    // When the caller replaced the queue (explicit `queue` arg), seed the
    // resolver with those tracks so the UI / hot paths resolve them without a
    // network round-trip. No-arg jumps reuse already-cached refs.
    if (scopedQueue) {
      for (const t of scopedQueue) {
        const sid = playbackCacheKeyForTrack(t);
        if (sid) seedQueueResolver(sid, [t]);
      }
    } else if (queueSid) {
      seedQueueResolver(queueSid, [trackForPlay]);
    }

    const hasJsAutoHandoff = !manual && peekArmedCrossfadeDynamicOverlap(trackForPlay.id);
    const wantInterruptBlend = Boolean(
      shouldAutodjInterruptBlend(wasPlayingBeforeSkip, hasJsAutoHandoff)
      && prevTrack
      && !sameQueueTrackId(prevTrack.id, trackForPlay.id),
    );
    const bReadyNow = isCrossfadeNextReady(trackForPlay.id, playbackSid, playbackCacheSid);
    /** Cold interrupt: engine still on A — don't swap player-bar metadata until handoff. */
    const deferInterruptUi = shouldDeferInterruptHandoffUi(wantInterruptBlend, bReadyNow);

    const applyInterruptHandoffUi = () => {
      resetGaplessProgressTracking();
      set({
        currentTrack: trackForPlay,
        waveformBins: null,
        ...deriveNormalizationSnapshot(trackForPlay, playNormWindow, normIdx),
        progress: initialProgress,
        buffered: 0,
        currentTime: initialTime,
        scrobbled: false,
        networkLoved: false,
        isPlaying: playbackSourceHint !== 'stream',
        isPlaybackBuffering: playbackSourceHint === 'stream',
        currentPlaybackSource: playbackSourceHint,
        enginePreloadedTrackId: keepPreloadHint ? trackForPlay.id : null,
      });
      void refreshWaveformForTrack(trackForPlay.id);
      void refreshLoudnessForTrack(trackForPlay.id, { syncPlayingEngine: false });
    };

    if (deferInterruptUi) {
      set({
        currentRadio: null,
        ...(replacing ? { queueItems: toQueueItemRefs(queueSid, scopedQueue) } : {}),
        queueIndex: idx >= 0 ? idx : 0,
      });
    } else {
      resetGaplessProgressTracking();
      set({
        currentTrack: trackForPlay,
        currentRadio: null,
        waveformBins: null,
        ...deriveNormalizationSnapshot(trackForPlay, playNormWindow, normIdx),
        // Only a replace rewrites the queue; navigation keeps the canonical refs.
        ...(replacing ? { queueItems: toQueueItemRefs(queueSid, scopedQueue) } : {}),
        queueIndex: idx >= 0 ? idx : 0,
        progress: initialProgress,
        buffered: 0,
        currentTime: initialTime,
        scrobbled: false,
        networkLoved: false,
        // HTTP stream: wait for Rust `audio:playing` so the seekbar does not
        // extrapolate while RangedHttpSource / legacy reader is still buffering.
        // During interrupt prep A is still audible — keep the play affordance on.
        isPlaying: (wantInterruptBlend && wasPlayingBeforeSkip) || playbackSourceHint !== 'stream',
        isPlaybackBuffering: wantInterruptBlend && wasPlayingBeforeSkip
          ? false
          : playbackSourceHint === 'stream',
        currentPlaybackSource: playbackSourceHint,
        enginePreloadedTrackId: keepPreloadHint ? trackForPlay.id : null,
      });
      void refreshWaveformForTrack(trackForPlay.id);
      void refreshLoudnessForTrack(
        trackForPlay.id,
        wantInterruptBlend ? { syncPlayingEngine: false } : undefined,
      );
    }

    setDeferHotCachePrefetch(true);
    if (
      prevTrack
      && !sameQueueTrackId(prevTrack.id, trackForPlay.id)
      && authStateNow.hotCacheEnabled
    ) {
      const prevPromoteSid = playbackCacheKeyForTrack(prevTrack, prevPlayingRef);
      if (prevPromoteSid) {
        void promoteCompletedStreamToHotCache(
          prevTrack,
          prevPromoteSid,
          authStateNow.hotCacheDownloadDir || null,
        );
      }
    }
    const replayGainDb = resolveReplayGainDb(
      trackForPlay, prevTrack, nextNeighbour,
      isReplayGainActive(), authStateNow.replayGainMode,
    );
    const replayGainPeak = isReplayGainActive() ? (trackForPlay.replayGainPeak ?? null) : null;

    const invokeAudioPlay = (manualBlend: CrossfadeTransitionPlan | null) => {
      // Silence-aware crossfade (B-head + dynamic overlap): on a fresh auto-advance
      // under crossfade, start past this track's leading silence (always, from the
      // plan) and — only when the JS A-tail advance positioned this transition —
      // fade over the content-driven overlap it armed. AutoDJ smooth skip uses the
      // same rules from the current playback position on manual next/previous.
      const useTrimAuto =
        !manual
        && authStateNow.crossfadeEnabled
        && authStateNow.crossfadeTrimSilence
        && !authStateNow.gaplessEnabled
        && initialTime <= 0.05;
      const useManualBlend = manualBlend !== null;

      const crossfadePlan = useTrimAuto ? getCrossfadeTransition(trackForPlay.id) : null;
      const armedOverlap = useTrimAuto ? consumeCrossfadeDynamicOverlap(trackForPlay.id) : null;
      const crossfadeStartSecs = useManualBlend
        ? manualBlend.bStartSec
        : (crossfadePlan?.bStartSec ?? 0);
      const crossfadeSecsOverride = useManualBlend
        ? manualBlend.overlapSec
        : (armedOverlap ? armedOverlap.overlapSec : null);
      const outgoingFadeSecsOverride = useManualBlend
        ? manualBlend.outgoingFadeSec
        : (armedOverlap ? armedOverlap.outgoingFadeSec : null);

      if (useManualBlend) {
        armAutodjMixing(manualBlend.overlapSec);
      } else if (crossfadeSecsOverride != null && crossfadeSecsOverride > 0) {
        armAutodjMixing(crossfadeSecsOverride);
      } else if (manual) {
        clearAutodjTransitionUi();
      }

      invoke('audio_play', {
        url,
        volume: state.volume,
        durationHint: trackForPlay.duration,
        replayGainDb,
        replayGainPeak,
        loudnessGainDb: loudnessGainDbForEngineBind(trackForPlay.id),
        preGainDb: authStateNow.replayGainPreGainDb,
        fallbackDb: authStateNow.replayGainFallbackDb,
        manual,
        ...audioPlayHiResBlendArgs(authStateNow),
        analysisTrackId: trackForPlay.id,
        serverId: getPlaybackIndexKey() || null,
        streamFormatSuffix: trackForPlay.suffix ?? null,
        startPaused: false,
        startSecs: crossfadeStartSecs > 0.05 ? crossfadeStartSecs : null,
        crossfadeSecsOverride,
        outgoingFadeSecsOverride,
        manualAutodjBlend: useManualBlend ? true : null,
      })
        .then(() => {
          if (getPlayGeneration() !== gen) return;
          if (wantInterruptBlend) {
            get().updateReplayGainForCurrentTrack();
          }
          if (keepPreloadHint) {
            set({ enginePreloadedTrackId: null });
          }
          const durSeek = trackForPlay.duration && trackForPlay.duration > 0 ? trackForPlay.duration : null;
          const seekTo = initialTime;
          const canSeekAfterPlay =
            seekTo > 0.05 && (durSeek == null || seekTo < durSeek - 0.05);
          if (canSeekAfterPlay) {
            void audioSeek({ seconds: seekTo })
              .then(() => {
                if (getPlayGeneration() !== gen) return;
                setSeekTarget(seekTo);
                if (getSeekFallbackVisualTarget()?.trackId === trackForPlay.id) {
                  setSeekFallbackVisualTarget(null);
                }
              })
              .catch(() => {
                if (getSeekFallbackVisualTarget()?.trackId === trackForPlay.id) {
                  setSeekFallbackVisualTarget(null);
                }
              });
          }
        })
        .catch((err: unknown) => {
          if (getPlayGeneration() !== gen) return;
          setDeferHotCachePrefetch(false);
          console.error('[psysonic] audio_play failed:', err);
          set({ isPlaying: false });
          setTimeout(() => {
            if (getPlayGeneration() !== gen) return;
            get().next(false);
          }, 500);
        });
    };

    const finishPlaybackSideEffects = () => {
      // Subsonic-server now-playing follows nowPlayingEnabled; Music Network
      // now-playing follows scrobbling, as Last.fm now-playing did (runtime gates
      // internally). playbackReportStart opens the live FSM on extension-capable
      // servers and falls back to the legacy presence call otherwise.
      playbackReportStart(trackForPlay.id, playbackSid);
      const runtime = getMusicNetworkRuntimeOrNull();
      void runtime?.dispatchNowPlaying({
        title: trackForPlay.title,
        artist: trackForPlay.artist,
        album: trackForPlay.album,
        duration: trackForPlay.duration,
        timestamp: Date.now(),
      });
      if (runtime?.getEnrichmentPrimaryId()) {
        void runtime
          .isTrackLoved({ title: trackForPlay.title, artist: trackForPlay.artist })
          .then(loved => {
            const cacheKey = `${trackForPlay.title}::${trackForPlay.artist}`;
            set(s => ({
              networkLoved: loved,
              networkLovedCache: { ...s.networkLovedCache, [cacheKey]: loved },
            }));
          });
      }
      pushQueueOnPlaybackStart(get().queueItems, trackForPlay, initialTime);
      touchHotCacheOnPlayback(trackForPlay.id, playbackCacheSid);
    };

    const startAudio = (manualBlend: CrossfadeTransitionPlan | null) => {
      if (deferInterruptUi) applyInterruptHandoffUi();
      clearInterruptHandoff();
      invokeAudioPlay(manualBlend);
      finishPlaybackSideEffects();
    };

    if (wantInterruptBlend && prevTrack) {
      const aDur = prevTrack.duration || 0;
      armAutodjMixing(STANDARD_BLEND_SEC);
      armInterruptHandoff(gen);
      void (async () => {
        try {
          const [prep, bBins] = await Promise.all([
            bReadyNow
              ? Promise.resolve({ ready: true })
              : runInterruptBlendPrep(
                trackForPlay,
                playbackSid,
                playbackCacheSid,
                () => getPlayGeneration() !== gen,
              ),
            fetchWaveformBins(trackForPlay.id, playbackCacheSid || null),
          ]);
          if (getPlayGeneration() !== gen) {
            clearInterruptHandoff();
            return;
          }
          const blend = prep.ready
            ? computeAutodjManualBlendPlan(
              outgoingWaveformBins,
              aDur,
              skipFromTimeSec,
              bBins,
              trackForPlay.duration || 0,
            )
            : null;
          startAudio(blend
            ? {
              ...blend,
              // Prep fade already ducked A when we waited for a cold B.
              outgoingFadeSec: bReadyNow ? blend.outgoingFadeSec : 0,
            }
            : null);
        } catch {
          if (getPlayGeneration() !== gen) {
            clearInterruptHandoff();
            return;
          }
          startAudio(null);
        }
      })();
      return;
    }

    startAudio(null);
  };

  const launchPlayTrackBody = () => {
    void (async () => {
      let trackForPlay = scopedTrack;
      const metadataSid =
        playbackCacheKeyForTrack(scopedTrack, playingRef)
        || get().queueServerId
        || getPlaybackIndexKey()
        || '';
      if (metadataSid) {
        trackForPlay = await enrichTrackPlaybackMetadata(scopedTrack, metadataSid);
      }
      if (getPlayGeneration() !== gen) return;
      runPlayTrackBody(trackForPlay);
    })();
  };

  const hotPromoteSid = getPlaybackCacheServerKey();
  if (needSameTrackHotPromote && hotPromoteSid) {
    void promoteCompletedStreamToHotCache(
      scopedTrack,
      hotPromoteSid,
      authState.hotCacheDownloadDir || null,
    )
      .then(() => {
        if (getPlayGeneration() !== gen) return;
        launchPlayTrackBody();
      })
      .catch((err: unknown) => {
        if (getPlayGeneration() !== gen) return;
        setDeferHotCachePrefetch(false);
        console.error('[psysonic] same-track hot promote / play body failed:', err);
        set({ isPlaying: false });
      });
  } else {
    launchPlayTrackBody();
  }
}
