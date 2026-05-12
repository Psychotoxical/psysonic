import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { showToast } from '../utils/toast';
import i18n from '../i18n';
import { buildStreamUrl, getPlayQueue, savePlayQueue, reportNowPlaying, getSong, getSimilarSongs2, getTopSongs, setRating } from '../api/subsonic';
import { resolvePlaybackUrl } from '../utils/resolvePlaybackUrl';
import { setDeferHotCachePrefetch } from '../utils/hotCacheGate';
import { lastfmUpdateNowPlaying, lastfmGetTrackLoved } from '../api/lastfm';
import { useAuthStore } from './authStore';
import { useOfflineStore } from './offlineStore';
import { useHotCacheStore } from './hotCacheStore';
import { orbitBulkGuard } from '../utils/orbitBulkGuard';
import { useOrbitStore } from './orbitStore';
import { estimateLivePosition } from '../api/orbit';
import { loudnessGainPlaceholderUntilCacheDb } from '../utils/loudnessPlaceholder';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../utils/loudnessPreAnalysisSlider';
import { resolveReplayGainDb } from '../utils/resolveReplayGainDb';
import { shuffleArray } from '../utils/shuffleArray';
import { songToTrack } from '../utils/songToTrack';
import { buildInfiniteQueueCandidates } from '../utils/buildInfiniteQueueCandidates';
import {
  queuesStructuralEqual,
  sameQueueTrackId,
} from '../utils/queueIdentity';
import { waveformBlobLenOk } from '../utils/waveformParse';
import { isRecoverableSeekError } from '../utils/seekErrors';
import {
  emitPlaybackProgress,
  getPlaybackProgressSnapshot,
  subscribePlaybackProgress,
  type PlaybackProgressSnapshot,
} from './playbackProgress';
import {
  playbackSourceHintForResolvedUrl,
  recordEnginePlayUrl,
  shouldRebindPlaybackToHotCache,
} from './playbackUrlRouting';
import { deriveNormalizationSnapshot } from './normalizationSnapshot';
import { isInOrbitSession } from './orbitSession';
import {
  getCachedLoudnessGain,
  hasStableLoudness,
  isReplayGainActive,
  loudnessCacheStateKeysForTrackId,
  loudnessGainDbForEngineBind,
} from './loudnessGainCache';
import {
  clearAllPlaybackScheduleTimers,
  clearScheduledPauseTimers,
  clearScheduledResumeTimers,
  schedulePauseTimer,
  scheduleResumeTimer,
} from './scheduleTimers';
import { invokeAudioUpdateReplayGainDeduped } from './normalizationIpcDedupe';
import { touchHotCacheOnPlayback } from './hotCacheTouch';
import { applySkipStarOnManualNext } from './skipStarRating';
import { resetLoudnessBackfillStateForTrackId } from './loudnessBackfillState';
import {
  flushPlayQueuePosition,
  flushQueueSyncToServer,
  syncQueueToServer,
} from './queueSync';
import {
  clearPreloadingIds,
  getLastGaplessSwitchTime,
} from './gaplessPreloadState';
import { promoteCompletedStreamToHotCache } from './promoteStreamCache';
import {
  clearSeekTarget,
  setSeekTarget,
} from './seekTargetState';
import { tryAcquireTogglePlayLock } from './togglePlayLock';
import { reseedLoudnessForTrackId } from './loudnessReseed';
import { refreshWaveformForTrack } from './waveformRefresh';
import { refreshLoudnessForTrack } from './loudnessRefresh';
import {
  clearRadioReconnectTimer,
  pauseRadio,
  playRadioStream,
  resumeRadio,
  setRadioVolume,
  stopRadio,
} from './radioPlayer';
import {
  clearSeekFallbackRetry,
  getSeekFallbackRestartAt,
  getSeekFallbackTrackId,
  getSeekFallbackVisualTarget,
  scheduleSeekFallbackRetry,
  setSeekFallbackRestartAt,
  setSeekFallbackTrackId,
  setSeekFallbackVisualTarget,
} from './seekFallbackState';
import {
  armSeekDebounce,
  clearSeekDebounce,
} from './seekDebounce';
import {
  bumpPlayGeneration,
  getIsAudioPaused,
  getPlayGeneration,
  setIsAudioPaused,
} from './engineState';
import {
  addRadioSessionSeen,
  getCurrentRadioArtistId,
  hasRadioSessionSeen,
  isRadioFetching,
  setRadioFetching,
} from './radioSessionState';
import {
  isInfiniteQueueFetching,
  setInfiniteQueueFetching,
} from './infiniteQueueState';
import { initAudioListeners } from './initAudioListeners';
import { installQueueUndoHotkey } from './queueUndoHotkey';
import { readInitialQueueVisibility } from './queueVisibilityStorage';

// Re-export so MainApp + the 3 playerStore characterization tests keep
// their existing `from './playerStore'` imports.
export { initAudioListeners };

// Re-export so bootstrap.ts + bootstrap.test keep their existing
// `from './playerStore'` imports.
export { installQueueUndoHotkey };

// Re-export so TauriEventBridge + persistence test keep their existing
// `from './playerStore'` imports.
export { flushPlayQueuePosition };

// Re-export the playback-progress public surface so existing call sites
// (PlayerBar, FullscreenPlayer, WaveformSeek, LyricsPane, MobilePlayerView,
// TauriEventBridge, plus the progress characterization test) keep their
// `from './playerStore'` imports working.
export {
  getPlaybackProgressSnapshot,
  subscribePlaybackProgress,
  type PlaybackProgressSnapshot,
};
import {
  _resetQueueUndoStacksForTest,
  consumePendingQueueListScrollTop,
  popQueueRedoSnapshot,
  popQueueUndoSnapshot,
  pushQueueRedoSnapshot,
  pushQueueUndoFromGetter,
  pushQueueUndoSnapshot,
  queueUndoSnapshotFromState,
  registerQueueListScrollTopReader,
  type QueueUndoSnapshot,
} from './queueUndo';

// Re-export for backward compatibility with the ~30 call sites that still
// import these helpers from playerStore. Phase E (store splits) will migrate
// the imports to '../utils/*' directly and drop these re-exports.
export { resolveReplayGainDb, shuffleArray, songToTrack };

// Re-export the queue-undo public API so existing callers (QueuePanel,
// test/helpers/storeReset) keep their `from './playerStore'` imports.
export {
  _resetQueueUndoStacksForTest,
  consumePendingQueueListScrollTop,
  registerQueueListScrollTopReader,
};

import type { PlayerState, Track } from './playerStoreTypes';
export type { PlayerState, Track };
import { applyQueueHistorySnapshot } from './applyQueueHistorySnapshot';
import { createLastfmActions } from './lastfmActions';
import { createQueueMutationActions } from './queueMutationActions';
import { createUiStateActions } from './uiStateActions';


// ─── Module-level playback primitives ─────────────────────────────────────────


// ─── Store ────────────────────────────────────────────────────────────────────

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => {

      return {
      currentTrack: null,
      waveformBins: null,
      normalizationNowDb: null,
      normalizationTargetLufs: null,
      normalizationEngineLive: 'off',
      normalizationDbgSource: null,
      normalizationDbgTrackId: null,
      normalizationDbgCacheGainDb: null,
      normalizationDbgCacheTargetLufs: null,
      normalizationDbgCacheUpdatedAt: null,
      normalizationDbgLastEventAt: null,
      currentRadio: null,
      currentPlaybackSource: null,
      enginePreloadedTrackId: null,
      queue: [],
      queueIndex: 0,
      isPlaying: false,
      progress: 0,
      buffered: 0,
      currentTime: 0,
      volume: 0.8,
      scrobbled: false,
      lastfmLoved: false,
      lastfmLovedCache: {},
      starredOverrides: {},
      userRatingOverrides: {},
      isQueueVisible: readInitialQueueVisibility(),
      isFullscreenOpen: false,
      scheduledPauseAtMs: null,
      scheduledPauseStartMs: null,
      scheduledResumeAtMs: null,
      scheduledResumeStartMs: null,
      repeatMode: 'off',
      contextMenu: { isOpen: false, x: 0, y: 0, item: null, type: null },
      songInfoModal: { isOpen: false, songId: null },

      ...createUiStateActions(set),
      ...createLastfmActions(set, get),
      ...createQueueMutationActions(set, get),

      // ── stop ────────────────────────────────────────────────────────────────
      stop: () => {
        clearAllPlaybackScheduleTimers();
        if (get().currentRadio) {
          stopRadio();
        } else {
          invoke('audio_stop').catch(console.error);
        }
        setIsAudioPaused(false);
        clearSeekFallbackRetry();
        clearSeekDebounce(); clearSeekTarget();
        set({
          isPlaying: false,
          progress: 0,
          buffered: 0,
          currentTime: 0,
          currentRadio: null,
          waveformBins: null,
          normalizationNowDb: null,
          normalizationTargetLufs: null,
          normalizationEngineLive: 'off',
          currentPlaybackSource: null,
          enginePreloadedTrackId: null,
          scheduledPauseAtMs: null,
          scheduledPauseStartMs: null,
          scheduledResumeAtMs: null,
          scheduledResumeStartMs: null,
        });
      },

      // ── playRadio ────────────────────────────────────────────────────────────
      playRadio: async (station) => {
        const { volume } = get();
        bumpPlayGeneration();
        clearAllPlaybackScheduleTimers();
        set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });
        setIsAudioPaused(false);
        clearRadioReconnectTimer();
        clearPreloadingIds();
        clearSeekFallbackRetry();
        clearSeekDebounce(); clearSeekTarget();
        // Stop Rust engine in case a regular track was playing.
        invoke('audio_stop').catch(() => {});
        // Resolve PLS/M3U playlist URLs to the actual stream URL before handing
        // to HTML5 <audio> — the browser cannot play playlist files directly.
        const streamUrl = await invoke<string>('resolve_stream_url', { url: station.streamUrl })
          .catch(() => station.streamUrl);
        const { replayGainFallbackDb } = useAuthStore.getState();
        const fallbackFactor = replayGainFallbackDb !== 0 ? Math.pow(10, replayGainFallbackDb / 20) : 1;
        playRadioStream(streamUrl, Math.min(1, volume * fallbackFactor)).catch((err: unknown) => {
          console.error('[psysonic] radio HTML5 play failed:', err);
          showToast('Radio stream error', 3000, 'error');
          set({ isPlaying: false, currentRadio: null });
        });
        set({
          currentRadio: station,
          currentTrack: null,
          waveformBins: null,
          normalizationNowDb: null,
          normalizationTargetLufs: null,
          normalizationEngineLive: 'off',
          currentPlaybackSource: null,
          queue: [],
          queueIndex: 0,
          isPlaying: true,
          progress: 0,
          currentTime: 0,
          buffered: 0,
          scrobbled: true, // no scrobbling for radio
        });
      },

      // ── playTrack ────────────────────────────────────────────────────────────
      playTrack: (track, queue, manual = true, _orbitConfirmed = false, targetQueueIndex) => {
        // Orbit bulk-gate: only gate when the `queue` argument *replaces*
        // the current queue (Play All / Play Album / Play Playlist / Hero
        // play buttons). Navigation calls — queue-row click, next(),
        // previous() — pass the existing queue back through playTrack just
        // to move the index; they are not bulk operations and must not
        // trigger the confirm dialog (#234 regression).
        if (!_orbitConfirmed && queue && queue.length > 1) {
          const current = get().queue;
          const sameAsCurrent = queue.length === current.length
            && queue.every((t, i) => sameQueueTrackId(current[i]?.id, t.id));
          if (!sameAsCurrent) {
            void orbitBulkGuard(queue.length).then(ok => {
              if (!ok) return;
              // Inside an Orbit session a bulk replace would discard guest
              // suggestions mid-listen. Append instead — the dialog's
              // "Add them all" copy already matches that semantic. Outside
              // Orbit, proceed as a normal replace.
              const role = useOrbitStore.getState().role;
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
          const orbitRole = useOrbitStore.getState().role;
          if (orbitRole === 'host') {
            const current = get().queue;
            const currentTrackId = current[get().queueIndex]?.id;
            if (track.id !== currentTrackId) {
              const existsAt = current.findIndex(t => sameQueueTrackId(t.id, track.id));
              if (existsAt >= 0) {
                get().playTrack(track, current, manual, true, existsAt);
              } else {
                const newQueue = [...current, track];
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

        clearAllPlaybackScheduleTimers();
        set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });

        const gen = bumpPlayGeneration();
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
        const prevTrack = state.currentTrack;
        if (prevTrack?.id !== track.id) {
          setSeekFallbackTrackId(null);
        }
        const visualOnEntry = getSeekFallbackVisualTarget();
        if (visualOnEntry?.trackId !== track.id) {
          setSeekFallbackVisualTarget(null);
        }
        const newQueue = queue ?? state.queue;
        // Prefer an explicit target index from the caller (next/previous/queue-row
        // click already know the exact slot). `findIndex` returns the *first*
        // matching id, which jumps backwards when the queue contains the same
        // track twice — breaking radio playback (issue #500).
        const explicitIdxValid =
          typeof targetQueueIndex === 'number'
          && targetQueueIndex >= 0
          && targetQueueIndex < newQueue.length
          && sameQueueTrackId(newQueue[targetQueueIndex]?.id, track.id);
        const idx = explicitIdxValid
          ? (targetQueueIndex as number)
          : newQueue.findIndex(t => sameQueueTrackId(t.id, track.id));
        if (manual) {
          pushQueueUndoFromGetter(get);
        }
        const visualForInitial = getSeekFallbackVisualTarget();
        const pendingVisualTarget = visualForInitial?.trackId === track.id
          ? visualForInitial.seconds
          : null;
        const initialTime = pendingVisualTarget !== null
          ? Math.max(0, Math.min(pendingVisualTarget, track.duration || pendingVisualTarget))
          : 0;
        const initialProgress =
          track.duration && track.duration > 0 ? Math.max(0, Math.min(1, initialTime / track.duration)) : 0;

        const authState = useAuthStore.getState();
        // Same-track replay: Rust `fetch_data` consumes `stream_completed_cache` with
        // `take()` once; a second replay would full HTTP-range again unless we flush
        // RAM to hot disk first (promote was only run when switching to another track).
        const needSameTrackHotPromote =
          Boolean(
            prevTrack
            && sameQueueTrackId(prevTrack.id, track.id)
            && authState.hotCacheEnabled
            && authState.activeServerId,
          );

        const runPlayTrackBody = () => {
          const authStateNow = useAuthStore.getState();
          const url = resolvePlaybackUrl(track.id, authStateNow.activeServerId ?? '');
          recordEnginePlayUrl(track.id, url);
          const preloadedTrackId = get().enginePreloadedTrackId;
          const keepPreloadHint = preloadedTrackId === track.id;
          const playbackSourceHint = playbackSourceHintForResolvedUrl(
            track.id,
            authStateNow.activeServerId ?? '',
            url,
          );
          if (import.meta.env.DEV) {
            console.info('[psysonic][playTrack-source]', {
              trackId: track.id,
              resolvedUrl: url,
              preloadedTrackId,
              keepPreloadHint,
              playbackSourceHint,
            });
          }

          // Set state immediately so the UI updates before the download completes.
          // currentRadio: null ensures the PlayerBar switches out of radio mode right away.
          set({
            currentTrack: track,
            currentRadio: null,
            waveformBins: null,
            ...deriveNormalizationSnapshot(track, newQueue, idx >= 0 ? idx : 0),
            queue: newQueue,
            queueIndex: idx >= 0 ? idx : 0,
            progress: initialProgress,
            buffered: 0,
            currentTime: initialTime,
            scrobbled: false,
            lastfmLoved: false,
            isPlaying: true, // optimistic — reverted on error
            currentPlaybackSource: playbackSourceHint,
            enginePreloadedTrackId: keepPreloadHint ? track.id : null,
          });

          if (
            prevTrack
            && !sameQueueTrackId(prevTrack.id, track.id)
            && authStateNow.hotCacheEnabled
          ) {
            const prevPromoteSid = authStateNow.activeServerId;
            if (prevPromoteSid) {
              void promoteCompletedStreamToHotCache(
                prevTrack,
                prevPromoteSid,
                authStateNow.hotCacheDownloadDir || null,
              );
            }
          }
          void refreshWaveformForTrack(track.id);
          void refreshLoudnessForTrack(track.id);
          setDeferHotCachePrefetch(true);
          const playIdx = idx >= 0 ? idx : 0;
          const nextNeighbour = playIdx + 1 < newQueue.length ? newQueue[playIdx + 1] : null;
          const replayGainDb = resolveReplayGainDb(
            track, prevTrack, nextNeighbour,
            isReplayGainActive(), authStateNow.replayGainMode,
          );
          const replayGainPeak = isReplayGainActive() ? (track.replayGainPeak ?? null) : null;
          invoke('audio_play', {
            url,
            volume: state.volume,
            durationHint: track.duration,
            replayGainDb,
            replayGainPeak,
            loudnessGainDb: loudnessGainDbForEngineBind(track.id),
            preGainDb: authStateNow.replayGainPreGainDb,
            fallbackDb: authStateNow.replayGainFallbackDb,
            manual,
            hiResEnabled: authStateNow.enableHiRes,
            analysisTrackId: track.id,
            streamFormatSuffix: track.suffix ?? null,
          })
            .then(() => {
              if (getPlayGeneration() !== gen) return;
              if (keepPreloadHint) {
                usePlayerStore.setState({ enginePreloadedTrackId: null });
              }
              const durSeek = track.duration && track.duration > 0 ? track.duration : null;
              const seekTo = initialTime;
              const canSeekAfterPlay =
                seekTo > 0.05 && (durSeek == null || seekTo < durSeek - 0.05);
              if (canSeekAfterPlay) {
                void invoke('audio_seek', { seconds: seekTo })
                  .then(() => {
                    if (getPlayGeneration() !== gen) return;
                    setSeekTarget(seekTo);
                    if (getSeekFallbackVisualTarget()?.trackId === track.id) {
                      setSeekFallbackVisualTarget(null);
                    }
                  })
                  .catch(() => {
                    if (getSeekFallbackVisualTarget()?.trackId === track.id) {
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

          // Report Now Playing to Navidrome (for Live/getNowPlaying) + Last.fm
          const { nowPlayingEnabled: npEnabled, scrobblingEnabled: lfmEnabled, lastfmSessionKey: lfmKey } = useAuthStore.getState();
          if (npEnabled) reportNowPlaying(track.id);
          if (lfmKey) {
            if (lfmEnabled) lastfmUpdateNowPlaying(track, lfmKey);
            lastfmGetTrackLoved(track.title, track.artist, lfmKey).then(loved => {
              const cacheKey = `${track.title}::${track.artist}`;
              usePlayerStore.setState(s => ({
                lastfmLoved: loved,
                lastfmLovedCache: { ...s.lastfmLovedCache, [cacheKey]: loved },
              }));
            });
          }
          syncQueueToServer(newQueue, track, initialTime);
          touchHotCacheOnPlayback(track.id, authStateNow.activeServerId ?? '');
        };

        const hotPromoteSid = authState.activeServerId;
        if (needSameTrackHotPromote && hotPromoteSid) {
          void promoteCompletedStreamToHotCache(
            track,
            hotPromoteSid,
            authState.hotCacheDownloadDir || null,
          )
            .then(() => {
              if (getPlayGeneration() !== gen) return;
              runPlayTrackBody();
            })
            .catch((err: unknown) => {
              if (getPlayGeneration() !== gen) return;
              setDeferHotCachePrefetch(false);
              console.error('[psysonic] same-track hot promote / play body failed:', err);
              set({ isPlaying: false });
            });
        } else {
          runPlayTrackBody();
        }
      },

      reseedQueueForInstantMix: (track) => {
        const s = get();
        if (s.currentTrack?.id !== track.id) {
          get().playTrack(track, [track]);
          return;
        }
        pushQueueUndoFromGetter(get);
        const wasPlaying = s.isPlaying;
        set({
          queue: [track],
          queueIndex: 0,
          currentTrack: track,
        });
        syncQueueToServer([track], track, s.currentTime);
        if (!wasPlaying) get().resume();
      },

      // ── pause / resume / togglePlay ──────────────────────────────────────────
      pause: () => {
        clearAllPlaybackScheduleTimers();
        if (get().currentRadio) {
          pauseRadio();
        } else {
          invoke('audio_pause').catch(console.error);
          setIsAudioPaused(true);
          // Flush position so a quick close after pause still leaves the
          // server with the right resume point for other devices.
          const s = get();
          if (s.currentTrack) {
            void flushQueueSyncToServer(s.queue, s.currentTrack, s.currentTime);
          }
        }
        set({ isPlaying: false, scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });
      },

      resetAudioPause: () => {
        setIsAudioPaused(false);
      },

      resume: () => {
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
      },

      clearScheduledPause: () => {
        clearScheduledPauseTimers();
        set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null });
      },

      clearScheduledResume: () => {
        clearScheduledResumeTimers();
        set({ scheduledResumeAtMs: null, scheduledResumeStartMs: null });
      },

      schedulePauseIn: (seconds) => {
        const s = get();
        if (!s.isPlaying) return;
        const delayMs = Math.max(500, Math.round(Number(seconds) * 1000));
        const startedAt = Date.now();
        const at = startedAt + delayMs;
        set({ scheduledPauseAtMs: at, scheduledPauseStartMs: startedAt });
        schedulePauseTimer(delayMs, () => {
          set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null });
          get().pause();
        });
      },

      scheduleResumeIn: (seconds) => {
        const s = get();
        if (s.isPlaying) return;
        if (!s.currentTrack && !s.currentRadio) return;
        const delayMs = Math.max(500, Math.round(Number(seconds) * 1000));
        const startedAt = Date.now();
        const at = startedAt + delayMs;
        set({ scheduledResumeAtMs: at, scheduledResumeStartMs: startedAt });
        scheduleResumeTimer(delayMs, () => {
          set({ scheduledResumeAtMs: null, scheduledResumeStartMs: null });
          get().resume();
        });
      },

      togglePlay: () => {
        if (!tryAcquireTogglePlayLock()) return;
        const { isPlaying } = get();
        isPlaying ? get().pause() : get().resume();
      },

      // ── next / previous ──────────────────────────────────────────────────────
      next: (manual = true) => {
        const { queue, queueIndex, repeatMode, currentTrack } = get();
        applySkipStarOnManualNext(currentTrack, manual);
        const nextIdx = queueIndex + 1;
        if (nextIdx < queue.length) {
          get().playTrack(queue[nextIdx], queue, manual, false, nextIdx);
          // Proactively top up auto-added tracks when ≤ 2 remain ahead,
          // so the queue never runs dry without a visible loading pause.
          // Skipped while in Orbit — the host's queue is the source of
          // truth there, and any silent local extension would either
          // drift this client off the host or pop the bulk-add modal at
          // the next track-end fallback.
          const { infiniteQueueEnabled } = useAuthStore.getState();
          if (infiniteQueueEnabled && repeatMode === 'off' && !isInfiniteQueueFetching() && !isInOrbitSession()) {
            const remainingAuto = queue.slice(nextIdx + 1).filter(t => t.autoAdded).length;
            if (remainingAuto <= 2) {
              setInfiniteQueueFetching(true);
              const existingIds = new Set(get().queue.map(t => t.id));
              buildInfiniteQueueCandidates(currentTrack, existingIds, 5).then(newTracks => {
                // Re-check at resolution time — the user may have joined
                // an Orbit session between scheduling and resolving.
                if (isInOrbitSession()) return;
                if (newTracks.length > 0) {
                  set(state => ({ queue: [...state.queue, ...newTracks] }));
                }
              }).catch(() => {}).finally(() => { setInfiniteQueueFetching(false); });
            }
          }
          // Proactively top up radio tracks when ≤ 2 remain — always, regardless
          // of infinite queue setting.
          const nextTrack = queue[nextIdx];
          if (nextTrack.radioAdded && !isRadioFetching()) {
            const remainingRadio = queue.slice(nextIdx + 1).filter(t => t.radioAdded).length;
            if (remainingRadio <= 2) {
              const artistId = nextTrack.artistId ?? getCurrentRadioArtistId() ?? null;
              const artistName = nextTrack.artist;
              if (artistId) {
                setRadioFetching(true);
                Promise.all([getSimilarSongs2(artistId), getTopSongs(artistName)])
                  .then(([similar, top]) => {
                    const existingIds = new Set(get().queue.map(t => t.id));
                    // Lead with similar (other artists) for variety; top tracks
                    // of the upcoming artist are only a fallback when similar
                    // is empty. Single-pass loop dedupes against the live queue,
                    // the session seen-set, and intra-batch overlap (issue #500).
                    const sourceList = similar.length > 0 ? similar : top;
                    const fresh: Track[] = [];
                    for (const raw of sourceList) {
                      if (fresh.length >= 10) break;
                      const t = songToTrack(raw);
                      if (existingIds.has(t.id) || hasRadioSessionSeen(t.id)) continue;
                      addRadioSessionSeen(t.id);
                      fresh.push({ ...t, radioAdded: true as const });
                    }
                    if (fresh.length > 0) {
                      // Trim played tracks from the front to keep the queue bounded.
                      // Without trimming the queue grows unboundedly, making every
                      // Zustand persist write larger and causing UI freezes over time.
                      // Keep the last HISTORY_KEEP played tracks so the user can still
                      // navigate backwards a few songs. Trimmed ids stay in the seen-set.
                      const HISTORY_KEEP = 5;
                      set(state => {
                        const trimStart = Math.max(0, state.queueIndex - HISTORY_KEEP);
                        return {
                          queue: [...state.queue.slice(trimStart), ...fresh],
                          queueIndex: state.queueIndex - trimStart,
                        };
                      });
                    }
                  })
                  .catch(() => {})
                  .finally(() => { setRadioFetching(false); });
              }
            }
          }
        } else if (repeatMode === 'all' && queue.length > 0) {
          get().playTrack(queue[0], queue, manual, false, 0);
        } else {
          // ── Orbit short-circuit ──
          // The host owns the shared queue. The radio / infinite-queue
          // fallbacks below would either pop the orbitBulkGuard modal (with a
          // 6-track add) or silently inject unrelated tracks into the local
          // player and drift the guest off the host. Stop instead and let the
          // next pull tick in `useOrbitGuest` sync to the host's next track.
          // Covers any active orbit phase (`active` / `joining` / `starting`)
          // so a fetch scheduled mid-join doesn't slip through.
          if (isInOrbitSession()) {
            invoke('audio_stop').catch(console.error);
            setIsAudioPaused(false);
            set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
            return;
          }
          // Queue exhausted. Check radio first (independent of infinite queue setting),
          // then infinite queue, then stop.
          if (currentTrack?.radioAdded && !isRadioFetching()) {
            const artistId = currentTrack.artistId ?? getCurrentRadioArtistId() ?? null;
            if (artistId) {
              setRadioFetching(true);
              Promise.all([getSimilarSongs2(artistId), getTopSongs(currentTrack.artist)])
                .then(([similar, top]) => {
                  setRadioFetching(false);
                  // The user may have joined an Orbit session while this
                  // fetch was in flight — bail without touching the queue.
                  if (isInOrbitSession()) {
                    invoke('audio_stop').catch(console.error);
                    setIsAudioPaused(false);
                    set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
                    return;
                  }
                  const existingIds = new Set(get().queue.map(t => t.id));
                  // Same source preference + dedup contract as the proactive
                  // top-up: similar first, top only as a fallback (issue #500).
                  const sourceList = similar.length > 0 ? similar : top;
                  const fresh: Track[] = [];
                  for (const raw of sourceList) {
                    if (fresh.length >= 10) break;
                    const t = songToTrack(raw);
                    if (existingIds.has(t.id) || hasRadioSessionSeen(t.id)) continue;
                    addRadioSessionSeen(t.id);
                    fresh.push({ ...t, radioAdded: true as const });
                  }
                  if (fresh.length > 0) {
                    const currentQueue = get().queue;
                    const newQueue = [...currentQueue, ...fresh];
                    get().playTrack(fresh[0], newQueue, false, false, currentQueue.length);
                  } else {
                    invoke('audio_stop').catch(console.error);
                    setIsAudioPaused(false);
                    set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
                  }
                })
                .catch(() => {
                  setRadioFetching(false);
                  invoke('audio_stop').catch(console.error);
                  setIsAudioPaused(false);
                  set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
                });
              return;
            }
          }
          const { infiniteQueueEnabled } = useAuthStore.getState();
          if (infiniteQueueEnabled && repeatMode === 'off') {
            if (isInfiniteQueueFetching()) return;
            setInfiniteQueueFetching(true);
            const existingIds = new Set(get().queue.map(t => t.id));
            buildInfiniteQueueCandidates(currentTrack, existingIds, 5).then(newTracks => {
              setInfiniteQueueFetching(false);
              // The user may have joined an Orbit session while this
              // fetch was in flight — bail without invoking playTrack.
              if (isInOrbitSession()) {
                invoke('audio_stop').catch(console.error);
                setIsAudioPaused(false);
                set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
                return;
              }
              if (newTracks.length === 0) {
                invoke('audio_stop').catch(console.error);
                setIsAudioPaused(false);
                set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
                return;
              }
              const currentQueue = get().queue;
              const newQueue = [...currentQueue, ...newTracks];
              get().playTrack(newTracks[0], newQueue, false);
            }).catch(() => {
              setInfiniteQueueFetching(false);
              invoke('audio_stop').catch(console.error);
              setIsAudioPaused(false);
              set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
            });
          } else {
            invoke('audio_stop').catch(console.error);
            setIsAudioPaused(false);
            set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
          }
        }
      },

      previous: () => {
        const { queue, queueIndex, currentTrack } = get();
        const currentTime = getPlaybackProgressSnapshot().currentTime;
        if (currentTime > 3) {
          // Restart current track from the beginning.
          const authState = useAuthStore.getState();
          const sid = authState.activeServerId ?? '';
          if (currentTrack && shouldRebindPlaybackToHotCache(currentTrack.id, sid)) {
            setSeekFallbackVisualTarget({ trackId: currentTrack.id, seconds: 0, setAtMs: Date.now() });
            get().playTrack(currentTrack, queue, true);
            return;
          }
          invoke('audio_seek', { seconds: 0 }).catch(console.error);
          set({ progress: 0, currentTime: 0 });
          return;
        }
        const prevIdx = queueIndex - 1;
        if (prevIdx >= 0) get().playTrack(queue[prevIdx], queue, true, false, prevIdx);
      },

      // ── seek ─────────────────────────────────────────────────────────────────
      // 100 ms debounce collapses rapid slider drags into one actual seek.
      seek: (progress) => {
        const { currentTrack } = get();
        if (!currentTrack) return;
        const dur = currentTrack.duration;
        if (!dur || !isFinite(dur)) return;
        const time = Math.max(0, Math.min(progress * dur, dur - 0.25));
        set({ progress: time / dur, currentTime: time });
        armSeekDebounce(100, () => {
          const s0 = get();
          if (!s0.currentTrack) return;
          const authSeek = useAuthStore.getState();
          const sidSeek = authSeek.activeServerId ?? '';
          if (shouldRebindPlaybackToHotCache(s0.currentTrack.id, sidSeek)) {
            setSeekFallbackVisualTarget({
              trackId: s0.currentTrack.id,
              seconds: time,
              setAtMs: Date.now(),
            });
            clearSeekFallbackRetry();
            s0.playTrack(s0.currentTrack, s0.queue, true);
            return;
          }
          invoke('audio_seek', { seconds: time }).then(() => {
            // Arm stale-progress guard only after backend acknowledged seek.
            setSeekTarget(time);
            setSeekFallbackVisualTarget(null);
            clearSeekFallbackRetry();
          }).catch((err: unknown) => {
            // Release the progress-tick guard so the UI doesn't freeze
            // waiting for a target the engine will never reach.
            clearSeekTarget();
            const msg = String(err ?? '');
            if (!isRecoverableSeekError(msg)) {
              console.error(err);
              setSeekFallbackVisualTarget(null);
              clearSeekFallbackRetry();
              return;
            }
            // Streaming-start path can be temporarily non-seekable or busy.
            // Keep UI at target and retry seek for a short bounded window.
            const s = get();
            if (!s.currentTrack) return;
            const now = Date.now();
            const sameBurst =
              getSeekFallbackTrackId() === s.currentTrack.id
              && now - getSeekFallbackRestartAt() < 600;
            setSeekFallbackVisualTarget({
              trackId: s.currentTrack.id,
              seconds: time,
              setAtMs: Date.now(),
            });
            // Keep stale progress ticks from snapping UI back to start while
            // recoverable seek retries are still in flight.
            setSeekTarget(time);
            if (msg.includes('not seekable') && !sameBurst) {
              setSeekFallbackTrackId(s.currentTrack.id);
              setSeekFallbackRestartAt(now);
              // Keep manual semantics (no crossfade) for seek recovery restarts.
              s.playTrack(s.currentTrack, s.queue, true);
            }
            scheduleSeekFallbackRetry(s.currentTrack.id, time);
          });
        });
      },

      // ── volume ───────────────────────────────────────────────────────────────
      setVolume: (v) => {
        const clamped = Math.max(0, Math.min(1, v));
        invoke('audio_set_volume', { volume: clamped }).catch(console.error);
        setRadioVolume(clamped);
        set({ volume: clamped });
      },

      setProgress: (t, duration) => {
        set({ currentTime: t, progress: duration > 0 ? t / duration : 0 });
      },

      // ── queue management ─────────────────────────────────────────────────────
      undoLastQueueEdit: () => {
        const prior = get();
        const snap = popQueueUndoSnapshot();
        if (!snap) return false;
        pushQueueRedoSnapshot(queueUndoSnapshotFromState(prior));
        return applyQueueHistorySnapshot(snap, prior, set, get);
      },

      redoLastQueueEdit: () => {
        const prior = get();
        const snap = popQueueRedoSnapshot();
        if (!snap) return false;
        pushQueueUndoSnapshot(queueUndoSnapshotFromState(prior));
        return applyQueueHistorySnapshot(snap, prior, set, get);
      },

      // ── server queue restore ─────────────────────────────────────────────────
      initializeFromServerQueue: async () => {
          try {
            const q = await getPlayQueue();
            if (q.songs.length > 0) {
              const mappedTracks: Track[] = q.songs.map(songToTrack);

              let currentTrack = mappedTracks[0];
             let queueIndex = 0;

             if (q.current) {
               const idx = mappedTracks.findIndex(t => t.id === q.current);
               if (idx >= 0) { currentTrack = mappedTracks[idx]; queueIndex = idx; }
             }

             // Prefer the server position if available; otherwise keep the
             // localStorage-persisted currentTime (more reliable than server
             // queue position, which may not flush before app close).
             const serverTime = q.position ? q.position / 1000 : 0;
             const localTime = get().currentTime;
             set({
               queue: mappedTracks,
               queueIndex,
               currentTrack,
               currentTime: serverTime > 0 ? serverTime : localTime,
             });
             void refreshWaveformForTrack(currentTrack.id);
           }
         } catch (e) {
           console.error('Failed to initialize queue from server', e);
         }
       },

      reanalyzeLoudnessForTrack: async (trackId: string) => {
        try {
          showToast(i18n.t('queue.recalculatingLoudnessWaveform'), 2000, 'info');
        } catch {
          // no-op
        }
        await reseedLoudnessForTrackId(trackId);
      },

       updateReplayGainForCurrentTrack: () => {
         const { currentTrack, queue, queueIndex, volume } = get();
         if (!currentTrack || !currentTrack.id) return;
         const authState = useAuthStore.getState();
         const prev = queueIndex > 0 ? queue[queueIndex - 1] : null;
         const next = queueIndex + 1 < queue.length ? queue[queueIndex + 1] : null;
         const replayGainDb = resolveReplayGainDb(
           currentTrack, prev, next,
           isReplayGainActive(), authState.replayGainMode,
         );
         const replayGainPeak = isReplayGainActive()
           ? (currentTrack.replayGainPeak ?? null)
           : null;
         
        const normalization = deriveNormalizationSnapshot(currentTrack, queue, queueIndex);
        const cachedLoud = getCachedLoudnessGain(currentTrack.id);
        const cachedLoudDb = Number.isFinite(cachedLoud) ? cachedLoud! : null;
        const haveStableLoud = hasStableLoudness(currentTrack.id);
        const preEffForNorm = effectiveLoudnessPreAnalysisAttenuationDb(
          authState.loudnessPreAnalysisAttenuationDb,
          authState.loudnessTargetLufs,
        );
        const preAnalysisPlaceholderDb =
          normalization.normalizationEngineLive === 'loudness'
          && cachedLoudDb == null
          && !haveStableLoud
          && Number.isFinite(preEffForNorm)
            ? loudnessGainPlaceholderUntilCacheDb(
                authState.loudnessTargetLufs,
                preEffForNorm,
              )
            : null;
        set(prevState => ({
          normalizationNowDb:
            normalization.normalizationEngineLive === 'loudness'
              ? (cachedLoudDb ?? preAnalysisPlaceholderDb ?? prevState.normalizationNowDb)
              : normalization.normalizationNowDb,
          normalizationTargetLufs: normalization.normalizationTargetLufs,
          normalizationEngineLive: normalization.normalizationEngineLive,
        }));
        invokeAudioUpdateReplayGainDeduped({
          volume,
          replayGainDb,
          replayGainPeak,
          loudnessGainDb: currentTrack ? (getCachedLoudnessGain(currentTrack.id) ?? null) : null,
          preGainDb: authState.replayGainPreGainDb,
          fallbackDb: authState.replayGainFallbackDb,
        });
       },
    };
    },
    {
      name: 'psysonic-player',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        volume: state.volume,
        repeatMode: state.repeatMode,
        currentTrack: state.currentTrack,
        queue: state.queue,
        queueIndex: state.queueIndex,
        isQueueVisible: state.isQueueVisible,
        // currentTime is intentionally NOT persisted here.
        // handleAudioProgress fires every 100ms and each setState with a
        // persisted field triggers a full JSON serialisation of the queue to
        // localStorage.  After ~10 minutes of Artist Radio the queue grows to
        // 50+ tracks; 6 000+ synchronous SQLite writes cause WKWebView's
        // storage process to crash on macOS → black screen + audio stop.
        // Resume position is recovered from Subsonic savePlayQueue (5s debounce).
        lastfmLovedCache: state.lastfmLovedCache,
      }),
    }
  )
);

usePlayerStore.subscribe((state, prev) => {
  if (
    state.currentTime === prev.currentTime &&
    state.progress === prev.progress &&
    state.buffered === prev.buffered
  ) return;
  emitPlaybackProgress({
    currentTime: state.currentTime,
    progress: state.progress,
    buffered: state.buffered,
  });
});

