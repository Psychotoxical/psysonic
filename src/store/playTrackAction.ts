import { reportNowPlaying } from '../api/subsonicScrobble';
import { invoke } from '@tauri-apps/api/core';
import { lastfmGetTrackLoved, lastfmUpdateNowPlaying } from '../api/lastfm';
import { setDeferHotCachePrefetch } from '../utils/cache/hotCacheGate';
import { orbitBulkGuard } from '../utils/orbitBulkGuard';
import { sameQueueTrackId } from '../utils/playback/queueIdentity';
import {
  bindQueueServerForPlayback,
  getPlaybackServerId,
  shouldBindQueueServerForPlay,
} from '../utils/playback/playbackServer';
import { resolvePlaybackUrl } from '../utils/playback/resolvePlaybackUrl';
import { resolveReplayGainDb } from '../utils/audio/resolveReplayGainDb';
import { useAuthStore } from './authStore';
import {
  bumpPlayGeneration,
  getPlayGeneration,
  setIsAudioPaused,
} from './engineState';
import {
  clearPreloadingIds,
  getLastGaplessSwitchTime,
} from './gaplessPreloadState';
import { touchHotCacheOnPlayback } from './hotCacheTouch';
import {
  isReplayGainActive,
  loudnessGainDbForEngineBind,
} from './loudnessGainCache';
import { refreshLoudnessForTrack } from './loudnessRefresh';
import { deriveNormalizationSnapshot } from './normalizationSnapshot';
import { useOrbitStore } from './orbitStore';
import {
  playbackSourceHintForResolvedUrl,
  recordEnginePlayUrl,
} from './playbackUrlRouting';
import type { PlayerState, Track } from './playerStoreTypes';
import { promoteCompletedStreamToHotCache } from './promoteStreamCache';
import { syncQueueToServer } from './queueSync';
import { pushQueueUndoFromGetter } from './queueUndo';
import { stopRadio } from './radioPlayer';
import { clearAllPlaybackScheduleTimers } from './scheduleTimers';
import { clearSeekDebounce } from './seekDebounce';
import {
  clearSeekFallbackRetry,
  getSeekFallbackVisualTarget,
  setSeekFallbackRestartAt,
  setSeekFallbackTrackId,
  setSeekFallbackVisualTarget,
} from './seekFallbackState';
import {
  clearSeekTarget,
  setSeekTarget,
} from './seekTargetState';
import { refreshWaveformForTrack } from './waveformRefresh';

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
  if (shouldBindQueueServerForPlay(state.queue, newQueue, queue)) {
    bindQueueServerForPlayback();
  }
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
      && getPlaybackServerId(),
    );

  const runPlayTrackBody = () => {
    const authStateNow = useAuthStore.getState();
    const playbackSid = getPlaybackServerId();
    const url = resolvePlaybackUrl(track.id, playbackSid);
    recordEnginePlayUrl(track.id, url);
    const preloadedTrackId = get().enginePreloadedTrackId;
    const keepPreloadHint = preloadedTrackId === track.id;
    const playbackSourceHint = playbackSourceHintForResolvedUrl(
      track.id,
      playbackSid,
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
      const prevPromoteSid = getPlaybackServerId();
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
          set({ enginePreloadedTrackId: null });
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
    if (npEnabled) reportNowPlaying(track.id, getPlaybackServerId());
    if (lfmKey) {
      if (lfmEnabled) lastfmUpdateNowPlaying(track, lfmKey);
      lastfmGetTrackLoved(track.title, track.artist, lfmKey).then(loved => {
        const cacheKey = `${track.title}::${track.artist}`;
        set(s => ({
          lastfmLoved: loved,
          lastfmLovedCache: { ...s.lastfmLovedCache, [cacheKey]: loved },
        }));
      });
    }
    syncQueueToServer(newQueue, track, initialTime);
    touchHotCacheOnPlayback(track.id, playbackSid);
  };

  const hotPromoteSid = getPlaybackServerId();
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
}
