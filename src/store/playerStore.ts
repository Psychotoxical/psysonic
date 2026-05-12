import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { showToast } from '../utils/toast';
import i18n from '../i18n';
import { buildStreamUrl, getPlayQueue, savePlayQueue, reportNowPlaying, getSong, getSimilarSongs2, getTopSongs, InternetRadioStation, setRating } from '../api/subsonic';
import { resolvePlaybackUrl, getPlaybackSourceKind, type PlaybackSourceKind } from '../utils/resolvePlaybackUrl';
import { setDeferHotCachePrefetch } from '../utils/hotCacheGate';
import { lastfmUpdateNowPlaying, lastfmLoveTrack, lastfmUnloveTrack, lastfmGetTrackLoved, lastfmGetAllLovedTracks } from '../api/lastfm';
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
  shallowCloneQueueTracks,
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
  clearRadioSessionSeenIds,
  deleteRadioSessionSeen,
  getCurrentRadioArtistId,
  hasRadioSessionSeen,
  isRadioFetching,
  setCurrentRadioArtistId,
  setRadioFetching,
} from './radioSessionState';
import {
  isInfiniteQueueFetching,
  setInfiniteQueueFetching,
} from './infiniteQueueState';
import { queueUndoRestoreAudioEngine } from './queueUndoAudioRestore';
import { prefetchLoudnessForEnqueuedTracks } from './loudnessPrefetch';
import { initAudioListeners } from './initAudioListeners';

// Re-export so MainApp + the 3 playerStore characterization tests keep
// their existing `from './playerStore'` imports.
export { initAudioListeners };

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
import { getWindowKind } from '../app/windowKind';
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
  setPendingQueueListScrollTop,
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

const QUEUE_VISIBILITY_STORAGE_KEY = 'psysonic_queue_visible';

function readInitialQueueVisibility(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(QUEUE_VISIBILITY_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // ignore storage access failures and fall back to default
  }
  return true;
}

function persistQueueVisibility(visible: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(QUEUE_VISIBILITY_STORAGE_KEY, String(visible));
  } catch {
    // ignore storage access failures
  }
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  artistId?: string;
  duration: number;
  coverArt?: string;
  track?: number;
  year?: number;
  bitRate?: number;
  suffix?: string;
  userRating?: number;
  replayGainTrackDb?: number;
  replayGainAlbumDb?: number;
  replayGainPeak?: number;
  starred?: string;
  genre?: string;
  samplingRate?: number;
  bitDepth?: number;
  /** Subsonic `size` in bytes when provided by the server (helps hot-cache budgeting). */
  size?: number;
  autoAdded?: boolean;
  radioAdded?: boolean;
  /** Inserted via "Play Next". Used by the preserve-order toggle to find the
   *  end of the current Play-Next streak. Stale flags behind queueIndex are
   *  harmless — the streak scan only looks forward from queueIndex+1. */
  playNextAdded?: boolean;
}

export interface PlayerState {
  currentTrack: Track | null;
  waveformBins: number[] | null;
  normalizationNowDb: number | null;
  normalizationTargetLufs: number | null;
  normalizationEngineLive: 'off' | 'replaygain' | 'loudness';
  normalizationDbgSource: string | null;
  normalizationDbgTrackId: string | null;
  normalizationDbgCacheGainDb: number | null;
  normalizationDbgCacheTargetLufs: number | null;
  normalizationDbgCacheUpdatedAt: number | null;
  normalizationDbgLastEventAt: number | null;
  currentRadio: InternetRadioStation | null;
  /** Latches the source used to start the currently playing track. */
  currentPlaybackSource: PlaybackSourceKind | null;
  /**
   * Subsonic track id for which `audio_preload` finished into the engine RAM slot (see `audio:preload-ready`).
   * Cleared after a successful `audio_play` consumed that preload, or when starting another track.
   */
  enginePreloadedTrackId: string | null;
  queue: Track[];
  queueIndex: number;
  isPlaying: boolean;
  progress: number; // 0–1
  buffered: number; // 0–1 (unused in Rust backend, kept for UI compat)
  currentTime: number;
  volume: number;
  scrobbled: boolean;
  lastfmLoved: boolean;
  lastfmLovedCache: Record<string, boolean>;
  starredOverrides: Record<string, boolean>;
  setStarredOverride: (id: string, starred: boolean) => void;
  /** Optimistic track ratings (e.g. skip→1★ while UI lists still have stale `song.userRating`). */
  userRatingOverrides: Record<string, number>;
  setUserRatingOverride: (id: string, rating: number) => void;

  playRadio: (station: InternetRadioStation) => void;
  /** `_orbitConfirmed` is an internal bypass flag — callers outside the
   *  orbit bulk-gate should leave it `undefined`.
   *  `targetQueueIndex` lets callers that already know the exact target
   *  position (next()/previous()/queue-row click) bypass the `findIndex`
   *  by-id fallback, which otherwise resolves to the *first* occurrence
   *  and breaks navigation when the same track appears multiple times in
   *  the queue (issue #500). Ignored if out of range or if the track id
   *  at that position doesn't match. */
  playTrack: (track: Track, queue?: Track[], manual?: boolean, _orbitConfirmed?: boolean, targetQueueIndex?: number) => void;
  /** Queue becomes `[track]` only; if already on this track, does not restart `audio_play`. */
  reseedQueueForInstantMix: (track: Track) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  togglePlay: () => void;
  /** Wall-clock ms when auto-pause fires, or null. */
  scheduledPauseAtMs: number | null;
  /** Wall-clock ms when the current auto-pause timer was armed (for progress-ring totals). */
  scheduledPauseStartMs: number | null;
  /** Wall-clock ms when auto-resume fires, or null. */
  scheduledResumeAtMs: number | null;
  /** Wall-clock ms when the current auto-resume timer was armed (for progress-ring totals). */
  scheduledResumeStartMs: number | null;
  schedulePauseIn: (seconds: number) => void;
  scheduleResumeIn: (seconds: number) => void;
  clearScheduledPause: () => void;
  clearScheduledResume: () => void;
  next: (manual?: boolean) => void;
  previous: () => void;
  seek: (progress: number) => void;
   setVolume: (v: number) => void;
   updateReplayGainForCurrentTrack: () => void;
   reanalyzeLoudnessForTrack: (trackId: string) => Promise<void>;
   setProgress: (t: number, duration: number) => void;
  enqueue: (tracks: Track[], _orbitConfirmed?: boolean) => void;
  enqueueAt: (tracks: Track[], insertIndex: number, _orbitConfirmed?: boolean) => void;
  /** "Play Next" — inserts after the current track. When
   *  `preservePlayNextOrder` is on, appends to the existing Play-Next streak
   *  (Spotify-style); otherwise inserts directly after the current track and
   *  pushes any earlier Play-Next items down (default). Falls back to
   *  `playTrack` when nothing is currently playing. */
  playNext: (tracks: Track[]) => void;
  enqueueRadio: (tracks: Track[], artistId?: string) => void;
  setRadioArtistId: (artistId: string) => void;
  /** For Lucky Mix: drop upcoming tail; keep the currently playing item only. */
  pruneUpcomingToCurrent: () => void;
  clearQueue: () => void;

  isQueueVisible: boolean;
  toggleQueue: () => void;
  setQueueVisible: (v: boolean) => void;

  isFullscreenOpen: boolean;
  toggleFullscreen: () => void;

  repeatMode: 'off' | 'all' | 'one';
  toggleRepeat: () => void;

  reorderQueue: (startIndex: number, endIndex: number) => void;
  removeTrack: (index: number) => void;
  shuffleQueue: () => void;
  /** Shuffle only the tracks after the current one — leaves played history intact. */
  shuffleUpcomingQueue: () => void;

  /**
   * Revert the last explicit queue edit (enqueue, reorder, remove, shuffle, manual
   * `playTrack`, …). Returns true if a snapshot was applied. Snapshots include queue,
   * current track, playback time, progress, and pause state. If the undone edit did
   * not change which song is current (reorder, enqueue, remove another row, …), only
   * the queue is restored and playback continues; otherwise the Rust engine is
   * resynced to the snapshot track/position. Does not cover `clearQueue` or automatic advances from
   * `next()` / gapless.
   * If the snapshot had no `currentTrack` but playback is active, the playing track
   * is kept: prepended when missing from the restored queue, otherwise re-bound by id.
   */
  undoLastQueueEdit: () => boolean;
  /** Ctrl+Shift+Z / Cmd+Shift+Z — opposite of `undoLastQueueEdit` while redo stack is non-empty. */
  redoLastQueueEdit: () => boolean;

  toggleLastfmLove: () => void;
  setLastfmLoved: (v: boolean) => void;
  setLastfmLovedForSong: (title: string, artist: string, v: boolean) => void;
  syncLastfmLovedTracks: () => Promise<void>;

  resetAudioPause: () => void;
  initializeFromServerQueue: () => Promise<void>;

  contextMenu: {
    isOpen: boolean;
    x: number;
    y: number;
    item: any;
    type: 'song' | 'favorite-song' | 'album' | 'artist' | 'queue-item' | 'album-song' | 'playlist' | 'multi-album' | 'multi-artist' | 'multi-playlist' | null;
    queueIndex?: number;
    playlistId?: string;
    playlistSongIndex?: number;
    /** Overrides the EntityShareKind for the "Share" action — used by Composers
     *  list/grid to copy a `composer` link from the otherwise artist-typed
     *  context menu, so paste lands on /composer/:id instead of /artist/:id. */
    shareKindOverride?: 'track' | 'album' | 'artist' | 'composer';
  };
  openContextMenu: (x: number, y: number, item: any, type: 'song' | 'favorite-song' | 'album' | 'artist' | 'queue-item' | 'album-song' | 'playlist' | 'multi-album' | 'multi-artist' | 'multi-playlist', queueIndex?: number, playlistId?: string, playlistSongIndex?: number, shareKindOverride?: 'track' | 'album' | 'artist' | 'composer') => void;
  closeContextMenu: () => void;

  songInfoModal: { isOpen: boolean; songId: string | null };
  openSongInfo: (songId: string) => void;
  closeSongInfo: () => void;
}

// ─── Module-level playback primitives ─────────────────────────────────────────


// ─── Store ────────────────────────────────────────────────────────────────────

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => {
      function applyQueueHistorySnapshot(snap: QueueUndoSnapshot, prior: PlayerState): boolean {
        if (prior.currentRadio) {
          stopRadio();
        }
        let nextQueue = shallowCloneQueueTracks(snap.queue);
        let nextIndex = snap.queueIndex;
        let nextTrack = snap.currentTrack ? { ...snap.currentTrack } : null;

        if (snap.currentTrack == null && prior.currentTrack) {
          const playing = prior.currentTrack;
          const pos = nextQueue.findIndex(t => sameQueueTrackId(t.id, playing.id));
          if (pos === -1) {
            nextQueue = [{ ...playing }, ...nextQueue];
            nextIndex = 0;
            nextTrack = { ...playing };
          } else {
            nextTrack = { ...playing };
            nextIndex = pos;
          }
        }

        nextIndex = Math.max(0, Math.min(nextIndex, Math.max(0, nextQueue.length - 1)));

        const keepPlaybackFromPrior =
          prior.currentTrack != null
          && nextTrack != null
          && sameQueueTrackId(prior.currentTrack.id, nextTrack.id)
          && nextQueue.some(t => sameQueueTrackId(t.id, prior.currentTrack!.id))
          && (
            (snap.currentTrack != null && sameQueueTrackId(prior.currentTrack.id, snap.currentTrack.id))
            || snap.currentTrack == null
          );

        if (keepPlaybackFromPrior) {
          const playingKeep = prior.currentTrack;
          if (playingKeep) {
            const idxPrior = nextQueue.findIndex(t => sameQueueTrackId(t.id, playingKeep.id));
            if (idxPrior >= 0) {
              nextIndex = idxPrior;
              nextTrack = { ...playingKeep };
            }
          }
        }

        let tRestoreRaw = typeof snap.currentTime === 'number' && Number.isFinite(snap.currentTime)
          ? snap.currentTime
          : 0;
        let playingRestore = snap.isPlaying !== false;
        if (keepPlaybackFromPrior && prior.currentTrack) {
          tRestoreRaw = prior.currentTime;
          playingRestore = prior.isPlaying;
        }
        const durForProgress = nextTrack?.duration && nextTrack.duration > 0 ? nextTrack.duration : null;
        let pRestore = typeof snap.progress === 'number' && Number.isFinite(snap.progress)
          ? snap.progress
          : (durForProgress != null && durForProgress > 0
            ? Math.max(0, Math.min(1, tRestoreRaw / durForProgress))
            : 0);
        if (keepPlaybackFromPrior) {
          pRestore = prior.progress;
        }
        const tRestore = durForProgress != null
          ? Math.max(0, Math.min(tRestoreRaw, durForProgress))
          : Math.max(0, tRestoreRaw);

        const keepWaveform =
          prior.currentTrack?.id != null &&
          nextTrack?.id != null &&
          sameQueueTrackId(prior.currentTrack.id, nextTrack.id);
        const norm =
          nextTrack != null
            ? deriveNormalizationSnapshot(nextTrack, nextQueue, nextIndex)
            : ({
                normalizationNowDb: null,
                normalizationTargetLufs: null,
                normalizationEngineLive: 'off',
              } as Pick<
                PlayerState,
                'normalizationNowDb' | 'normalizationTargetLufs' | 'normalizationEngineLive'
              >);
        const authSnap = useAuthStore.getState();
        const playbackSourceUndo = nextTrack
          ? getPlaybackSourceKind(nextTrack.id, authSnap.activeServerId ?? '', null)
          : null;
        const playbackSourceFinal = keepPlaybackFromPrior && prior.currentPlaybackSource != null
          ? prior.currentPlaybackSource
          : playbackSourceUndo;

        clearAllPlaybackScheduleTimers();
        set({
          scheduledPauseAtMs: null,
          scheduledPauseStartMs: null,
          scheduledResumeAtMs: null,
          scheduledResumeStartMs: null,
        });

        clearPreloadingIds();

        let gen = getPlayGeneration();
        const resyncEngine = Boolean(nextTrack) && !keepPlaybackFromPrior;
        if (resyncEngine || !nextTrack) {
          gen = bumpPlayGeneration();
          if (resyncEngine) {
            setIsAudioPaused(false);
          }
        }

        set({
          queue: nextQueue,
          queueIndex: nextIndex,
          currentTrack: nextTrack,
          currentRadio: null,
          currentTime: tRestore,
          progress: pRestore,
          isPlaying: playingRestore,
          waveformBins: keepWaveform ? prior.waveformBins : null,
          enginePreloadedTrackId: keepPlaybackFromPrior ? prior.enginePreloadedTrackId : null,
          currentPlaybackSource: playbackSourceFinal,
          ...norm,
        });

        if (!nextTrack) {
          invoke('audio_stop').catch(console.error);
          setIsAudioPaused(false);
          syncQueueToServer(nextQueue, null, 0);
          if (typeof snap.queueListScrollTop === 'number' && Number.isFinite(snap.queueListScrollTop)) {
            setPendingQueueListScrollTop(Math.max(0, snap.queueListScrollTop));
          }
          return true;
        }

        void refreshWaveformForTrack(nextTrack.id);
        void refreshLoudnessForTrack(nextTrack.id);
        get().updateReplayGainForCurrentTrack();

        if (!keepPlaybackFromPrior) {
          const { nowPlayingEnabled: npUndo } = useAuthStore.getState();
          if (npUndo) reportNowPlaying(nextTrack.id);

          queueUndoRestoreAudioEngine({
            generation: gen,
            track: nextTrack,
            queue: nextQueue,
            queueIndex: nextIndex,
            atSeconds: tRestore,
            wantPlaying: playingRestore,
          });
        }
        if (typeof snap.queueListScrollTop === 'number' && Number.isFinite(snap.queueListScrollTop)) {
          setPendingQueueListScrollTop(Math.max(0, snap.queueListScrollTop));
        }
        syncQueueToServer(nextQueue, nextTrack, tRestore);
        return true;
      }

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
      setStarredOverride: (id, starred) => set(s => ({ starredOverrides: { ...s.starredOverrides, [id]: starred } })),
      userRatingOverrides: {},
      setUserRatingOverride: (id, rating) =>
        set(s => {
          const nextOverrides = { ...s.userRatingOverrides };
          if (rating === 0) delete nextOverrides[id];
          else nextOverrides[id] = rating;
          return {
            userRatingOverrides: nextOverrides,
            queue: s.queue.map(t => (t.id === id ? { ...t, userRating: rating } : t)),
            currentTrack:
              s.currentTrack?.id === id ? { ...s.currentTrack, userRating: rating } : s.currentTrack,
          };
        }),
      isQueueVisible: readInitialQueueVisibility(),
      isFullscreenOpen: false,
      scheduledPauseAtMs: null,
      scheduledPauseStartMs: null,
      scheduledResumeAtMs: null,
      scheduledResumeStartMs: null,
      repeatMode: 'off',
      contextMenu: { isOpen: false, x: 0, y: 0, item: null, type: null },

      openContextMenu: (x, y, item, type, queueIndex, playlistId, playlistSongIndex, shareKindOverride) => set({
        contextMenu: { isOpen: true, x, y, item, type, queueIndex, playlistId, playlistSongIndex, shareKindOverride },
      }),
      closeContextMenu: () => set(state => ({
        contextMenu: { ...state.contextMenu, isOpen: false },
      })),

      songInfoModal: { isOpen: false, songId: null },
      openSongInfo: (songId) => set({ songInfoModal: { isOpen: true, songId } }),
      closeSongInfo: () => set({ songInfoModal: { isOpen: false, songId: null } }),

      toggleQueue: () =>
        set(state => {
          const next = !state.isQueueVisible;
          persistQueueVisibility(next);
          return { isQueueVisible: next };
        }),
      setQueueVisible: (v: boolean) => {
        persistQueueVisibility(v);
        set({ isQueueVisible: v });
      },
      toggleFullscreen: () => set(state => ({ isFullscreenOpen: !state.isFullscreenOpen })),

      toggleLastfmLove: () => {
        const { currentTrack, lastfmLoved } = get();
        const { lastfmSessionKey } = useAuthStore.getState();
        if (!currentTrack || !lastfmSessionKey) return;
        const newLoved = !lastfmLoved;
        const cacheKey = `${currentTrack.title}::${currentTrack.artist}`;
        set(s => ({ lastfmLoved: newLoved, lastfmLovedCache: { ...s.lastfmLovedCache, [cacheKey]: newLoved } }));
        if (newLoved) {
          lastfmLoveTrack(currentTrack, lastfmSessionKey);
        } else {
          lastfmUnloveTrack(currentTrack, lastfmSessionKey);
        }
      },

      setLastfmLoved: (v) => {
        const { currentTrack } = get();
        if (currentTrack) {
          const cacheKey = `${currentTrack.title}::${currentTrack.artist}`;
          set(s => ({ lastfmLoved: v, lastfmLovedCache: { ...s.lastfmLovedCache, [cacheKey]: v } }));
        } else {
          set({ lastfmLoved: v });
        }
      },

      syncLastfmLovedTracks: async () => {
        const { lastfmSessionKey, lastfmUsername } = useAuthStore.getState();
        if (!lastfmSessionKey || !lastfmUsername) return;
        const tracks = await lastfmGetAllLovedTracks(lastfmUsername, lastfmSessionKey);
        const newCache: Record<string, boolean> = {};
        for (const t of tracks) newCache[`${t.title}::${t.artist}`] = true;
        // Merge with existing cache (local likes take precedence)
        set(s => ({ lastfmLovedCache: { ...newCache, ...s.lastfmLovedCache } }));
        // Update current track's loved state if it's in the new cache
        const { currentTrack } = get();
        if (currentTrack) {
          const loved = newCache[`${currentTrack.title}::${currentTrack.artist}`] ?? false;
          set({ lastfmLoved: loved });
        }
      },

      setLastfmLovedForSong: (title, artist, v) => {
        const cacheKey = `${title}::${artist}`;
        const isCurrentTrack = get().currentTrack?.title === title && get().currentTrack?.artist === artist;
        set(s => ({
          lastfmLovedCache: { ...s.lastfmLovedCache, [cacheKey]: v },
          ...(isCurrentTrack ? { lastfmLoved: v } : {}),
        }));
      },

      toggleRepeat: () => set(state => {
        const modes = ['off', 'all', 'one'] as const;
        return { repeatMode: modes[(modes.indexOf(state.repeatMode) + 1) % modes.length] };
      }),

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

      pruneUpcomingToCurrent: () => {
        const s = get();
        if (s.currentRadio) return;
        if (!s.currentTrack) {
          if (s.queue.length === 0) return;
          pushQueueUndoFromGetter(get);
          set({ queue: [], queueIndex: 0 });
          syncQueueToServer([], null, 0);
          return;
        }
        pushQueueUndoFromGetter(get);
        const at = s.queue.findIndex(t => t.id === s.currentTrack!.id);
        const newQueue: Track[] =
          at >= 0
            ? s.queue.slice(0, at + 1)
            : [s.currentTrack!];
        const newIndex = at >= 0 ? at : 0;
        set({ queue: newQueue, queueIndex: newIndex });
        syncQueueToServer(newQueue, s.currentTrack, s.currentTime);
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
      enqueue: (tracks, _orbitConfirmed = false) => {
        if (!_orbitConfirmed && tracks.length > 1) {
          void orbitBulkGuard(tracks.length).then(ok => {
            if (ok) get().enqueue(tracks, true);
          });
          return;
        }
        pushQueueUndoFromGetter(get);
        set(state => {
          // Insert before the first upcoming auto-added track so the
          // "Added automatically" separator always stays at the boundary.
          const firstAutoIdx = state.queue.findIndex(
            (t, i) => t.autoAdded && i > state.queueIndex
          );
          const newQueue = firstAutoIdx === -1
            ? [...state.queue, ...tracks]
            : [
                ...state.queue.slice(0, firstAutoIdx),
                ...tracks,
                ...state.queue.slice(firstAutoIdx),
              ];
          syncQueueToServer(newQueue, state.currentTrack, state.currentTime);
          prefetchLoudnessForEnqueuedTracks(newQueue, state.queueIndex);
          return { queue: newQueue };
        });
      },

      setRadioArtistId: (artistId) => {
        if (artistId !== getCurrentRadioArtistId()) {
          clearRadioSessionSeenIds();
        }
        setCurrentRadioArtistId(artistId);
      },

      enqueueRadio: (tracks, artistId) => {
        if (artistId !== undefined) {
          if (artistId !== getCurrentRadioArtistId()) {
            clearRadioSessionSeenIds();
          }
          setCurrentRadioArtistId(artistId);
        }
        pushQueueUndoFromGetter(get);
        set(state => {
          // Drop all upcoming (not yet played) radio tracks — clicking "Start Radio"
          // again replaces the pending radio batch instead of stacking on top.
          const beforeAndCurrent = state.queue.slice(0, state.queueIndex + 1);
          const upcoming = state.queue.slice(state.queueIndex + 1).filter(t => !t.radioAdded);
          // Tracks about to leave the queue here. Callers like ContextMenu.startRadio
          // pass the previous pending radio back in `tracks` to merge with new
          // similars — the seen-set must not block those re-introductions.
          const droppedRadioIds = state.queue
            .slice(state.queueIndex + 1)
            .filter(t => t.radioAdded)
            .map(t => t.id);
          for (const id of droppedRadioIds) deleteRadioSessionSeen(id);
          // Capture surviving queue ids in the seen-set so the next radio top-up
          // can dedupe against the seed track + already-queued non-radio items.
          for (const t of beforeAndCurrent) addRadioSessionSeen(t.id);
          for (const t of upcoming) addRadioSessionSeen(t.id);
          // Drop incoming tracks already seen earlier this session AND
          // intra-batch duplicates (top + similar Last.fm responses commonly
          // overlap). The seen-set is mutated inside the loop so a repeated
          // id later in `tracks` is rejected by the same pass that admitted
          // the first occurrence (issue #500).
          const dedupedTracks: Track[] = [];
          for (const t of tracks) {
            if (hasRadioSessionSeen(t.id)) continue;
            addRadioSessionSeen(t.id);
            dedupedTracks.push(t);
          }
          // Insert new radio tracks before any autoAdded tracks in the upcoming section.
          const firstAutoIdx = upcoming.findIndex(t => t.autoAdded);
          const merged = firstAutoIdx === -1
            ? [...upcoming, ...dedupedTracks]
            : [
                ...upcoming.slice(0, firstAutoIdx),
                ...dedupedTracks,
                ...upcoming.slice(firstAutoIdx),
              ];
          const newQueue = [...beforeAndCurrent, ...merged];
          syncQueueToServer(newQueue, state.currentTrack, state.currentTime);
          return { queue: newQueue };
        });
      },

      enqueueAt: (tracks, insertIndex, _orbitConfirmed = false) => {
        if (!_orbitConfirmed && tracks.length > 1) {
          void orbitBulkGuard(tracks.length).then(ok => {
            if (ok) get().enqueueAt(tracks, insertIndex, true);
          });
          return;
        }
        pushQueueUndoFromGetter(get);
        set(state => {
          const idx = Math.max(0, Math.min(insertIndex, state.queue.length));
          const newQueue = [
            ...state.queue.slice(0, idx),
            ...tracks,
            ...state.queue.slice(idx),
          ];
          const newQueueIndex = idx <= state.queueIndex
            ? state.queueIndex + tracks.length
            : state.queueIndex;
          syncQueueToServer(newQueue, state.currentTrack, state.currentTime);
          prefetchLoudnessForEnqueuedTracks(newQueue, newQueueIndex);
          return { queue: newQueue, queueIndex: newQueueIndex };
        });
      },

      playNext: (tracks) => {
        if (tracks.length === 0) return;
        const state = get();
        const tagged = tracks.map(t => ({ ...t, playNextAdded: true as const }));
        if (!state.currentTrack) {
          state.playTrack(tagged[0], tagged);
          return;
        }
        const baseIdx = state.queueIndex + 1;
        let insertIdx = baseIdx;
        if (useAuthStore.getState().preservePlayNextOrder) {
          const q = state.queue;
          while (insertIdx < q.length && q[insertIdx].playNextAdded) insertIdx++;
        }
        get().enqueueAt(tagged, insertIdx);
      },

      clearQueue: () => {
        invoke('audio_stop').catch(console.error);
        setIsAudioPaused(false);
        clearSeekFallbackRetry();
        clearSeekDebounce(); clearSeekTarget();
        clearRadioSessionSeenIds();
        setCurrentRadioArtistId(null);
        set({ queue: [], queueIndex: 0, currentTrack: null, isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
        syncQueueToServer([], null, 0);
      },

      reorderQueue: (startIndex, endIndex) => {
        pushQueueUndoFromGetter(get);
        const { queue, queueIndex, currentTrack } = get();
        const result = Array.from(queue);
        const [removed] = result.splice(startIndex, 1);
        result.splice(endIndex, 0, removed);
        let newIndex = queueIndex;
        if (currentTrack) newIndex = result.findIndex(t => t.id === currentTrack.id);
        set({ queue: result, queueIndex: Math.max(0, newIndex) });
        syncQueueToServer(result, currentTrack, get().currentTime);
      },

      shuffleQueue: () => {
        const { queue, currentTrack } = get();
        if (queue.length < 2) return;
        pushQueueUndoFromGetter(get);
        const currentIdx = currentTrack ? queue.findIndex(t => t.id === currentTrack.id) : -1;
        const others = queue.filter((_, i) => i !== currentIdx);
        for (let i = others.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [others[i], others[j]] = [others[j], others[i]];
        }
        const result = currentIdx >= 0
          ? [queue[currentIdx], ...others]
          : others;
        const newIndex = currentIdx >= 0 ? 0 : -1;
        set({ queue: result, queueIndex: Math.max(0, newIndex) });
        syncQueueToServer(result, currentTrack, get().currentTime);
      },

      shuffleUpcomingQueue: () => {
        const { queue, queueIndex, currentTrack } = get();
        const upcomingStart = queueIndex + 1;
        const upcomingCount = queue.length - upcomingStart;
        if (upcomingCount < 2) return;
        pushQueueUndoFromGetter(get);
        const head     = queue.slice(0, upcomingStart);
        const upcoming = queue.slice(upcomingStart);
        for (let i = upcoming.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [upcoming[i], upcoming[j]] = [upcoming[j], upcoming[i]];
        }
        const result = [...head, ...upcoming];
        set({ queue: result });
        syncQueueToServer(result, currentTrack, get().currentTime);
      },

      undoLastQueueEdit: () => {
        const prior = get();
        const snap = popQueueUndoSnapshot();
        if (!snap) return false;
        pushQueueRedoSnapshot(queueUndoSnapshotFromState(prior));
        return applyQueueHistorySnapshot(snap, prior);
      },

      redoLastQueueEdit: () => {
        const prior = get();
        const snap = popQueueRedoSnapshot();
        if (!snap) return false;
        pushQueueUndoSnapshot(queueUndoSnapshotFromState(prior));
        return applyQueueHistorySnapshot(snap, prior);
      },

      removeTrack: (index) => {
        pushQueueUndoFromGetter(get);
        const { queue, queueIndex } = get();
        const newQueue = [...queue];
        newQueue.splice(index, 1);
        set({ queue: newQueue, queueIndex: Math.min(queueIndex, newQueue.length - 1) });
        syncQueueToServer(newQueue, get().currentTrack, get().currentTime);
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

const QUEUE_UNDO_HOTKEY_FLAG = '__psyQueueUndoListenerInstalled';

/** True when the event path includes a real text field — skip queue undo so Ctrl+Z stays native there. */
function keyboardEventTargetIsEditableField(e: KeyboardEvent): boolean {
  for (const n of e.composedPath()) {
    if (!(n instanceof HTMLElement)) continue;
    const tag = n.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (n.isContentEditable) return true;
  }
  return false;
}

/**
 * Ctrl+Z / Cmd+Z undo and Ctrl+Shift+Z / Cmd+Shift+Z redo for the queue — document capture.
 * Call once at startup (e.g. from main.tsx); idempotent. Skips the mini-player window.
 */
export function installQueueUndoHotkey(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w[QUEUE_UNDO_HOTKEY_FLAG]) return;
  if (getWindowKind() === 'mini') return;
  w[QUEUE_UNDO_HOTKEY_FLAG] = true;
  document.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.code !== 'KeyZ' && String(e.key || '').toLowerCase() !== 'z') return;
      if (keyboardEventTargetIsEditableField(e)) return;

      if (e.shiftKey) {
        if (usePlayerStore.getState().redoLastQueueEdit()) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      if (usePlayerStore.getState().undoLastQueueEdit()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
