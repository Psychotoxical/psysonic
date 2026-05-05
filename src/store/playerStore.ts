import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { showToast } from '../utils/toast';
import { buildCoverArtUrl, buildStreamUrl, getPlayQueue, savePlayQueue, reportNowPlaying, scrobbleSong, SubsonicSong, getSong, getRandomSongs, getSimilarSongs2, getTopSongs, InternetRadioStation, setRating, getAlbumInfo2 } from '../api/subsonic';
import { resolvePlaybackUrl, streamUrlTrackId, getPlaybackSourceKind, type PlaybackSourceKind } from '../utils/resolvePlaybackUrl';
import { redactSubsonicUrlForLog } from '../utils/redactSubsonicUrl';
import { setDeferHotCachePrefetch } from '../utils/hotCacheGate';
import { lastfmScrobble, lastfmUpdateNowPlaying, lastfmLoveTrack, lastfmUnloveTrack, lastfmGetTrackLoved, lastfmGetAllLovedTracks } from '../api/lastfm';
import { useAuthStore } from './authStore';
import { useOfflineStore } from './offlineStore';
import { useHotCacheStore } from './hotCacheStore';
import { onAnalysisStorageChanged } from './analysisSync';
import { orbitBulkGuard } from '../utils/orbitBulkGuard';
import { useOrbitStore } from './orbitStore';
import { estimateLivePosition } from '../api/orbit';
import { loudnessGainPlaceholderUntilCacheDb } from '../utils/loudnessPlaceholder';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../utils/loudnessPreAnalysisSlider';
import {
  enrichSongsForMixRatingFilter,
  getMixMinRatingsConfigFromAuth,
  passesMixMinRatings,
} from '../utils/mixRatingFilter';
import { getPerfProbeFlags } from '../utils/perfFlags';
import { bumpPerfCounter } from '../utils/perfTelemetry';

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
}

export function songToTrack(song: SubsonicSong): Track {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    albumId: song.albumId,
    artistId: song.artistId,
    duration: song.duration,
    coverArt: song.coverArt,
    track: song.track,
    year: song.year,
    bitRate: song.bitRate,
    suffix: song.suffix,
    userRating: song.userRating,
    replayGainTrackDb: song.replayGain?.trackGain,
    replayGainAlbumDb: song.replayGain?.albumGain,
    replayGainPeak: song.replayGain?.trackPeak,
    starred: song.starred,
    genre: song.genre,
    samplingRate: song.samplingRate,
    bitDepth: song.bitDepth,
    size: song.size,
  };
}

/**
 * Resolve the ReplayGain dB value for a track based on the configured mode.
 * In 'auto' mode, picks album-gain when an adjacent queue neighbour shares the
 * same albumId (i.e. the track is being played as part of an album), otherwise
 * track-gain. Falls back to track-gain when album-gain is missing.
 */
export function resolveReplayGainDb(
  track: Track,
  prevTrack: Track | null | undefined,
  nextTrack: Track | null | undefined,
  enabled: boolean,
  mode: 'track' | 'album' | 'auto',
): number | null {
  if (!enabled) return null;
  let useAlbum: boolean;
  if (mode === 'album') {
    useAlbum = true;
  } else if (mode === 'track') {
    useAlbum = false;
  } else {
    const albumId = track.albumId;
    useAlbum = !!albumId && (
      prevTrack?.albumId === albumId || nextTrack?.albumId === albumId
    );
  }
  const value = useAlbum
    ? (track.replayGainAlbumDb ?? track.replayGainTrackDb)
    : track.replayGainTrackDb;
  return value ?? null;
}

export function shuffleArray<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Infinite queue source strategy (Instant Mix-like):
 * 1) Prefer artist-driven candidates (Top + Similar) around the current track.
 * 2) Fallback to random songs when artist-driven fetches are empty.
 */
async function buildInfiniteQueueCandidates(
  seedTrack: Track | null,
  existingIds: Set<string>,
  count = 5,
): Promise<Track[]> {
  const RANDOM_TOPUP_BATCH_SIZE = Math.max(10, count * 2);
  const RANDOM_TOPUP_MAX_BATCHES = 8;
  const artistId = seedTrack?.artistId?.trim() || null;
  const artistName = seedTrack?.artist?.trim() || null;

  const [similar, top] = await Promise.all([
    artistId ? getSimilarSongs2(artistId).catch(() => []) : Promise.resolve([]),
    artistName ? getTopSongs(artistName).catch(() => []) : Promise.resolve([]),
  ]);

  const seedId = seedTrack?.id ?? null;
  const mixCfg = getMixMinRatingsConfigFromAuth();
  const mixedSources = [...top, ...similar];
  const filteredMixedSongs = mixCfg.enabled
    ? (await enrichSongsForMixRatingFilter(mixedSources, mixCfg)).filter(s => passesMixMinRatings(s, mixCfg))
    : mixedSources;
  const out: Track[] = shuffleArray(
    filteredMixedSongs
      .map(songToTrack)
      .filter(t => t.id !== seedId && !existingIds.has(t.id)),
  )
    .slice(0, count)
    .map(t => ({ ...t, autoAdded: true as const }));

  const seenIds = new Set<string>([...existingIds, ...out.map(t => t.id)]);
  for (let b = 0; out.length < count && b < RANDOM_TOPUP_MAX_BATCHES; b++) {
    const random = await getRandomSongs(RANDOM_TOPUP_BATCH_SIZE, seedTrack?.genre).catch(() => []);
    if (!random.length) break;
    const filteredRandomSongs = mixCfg.enabled
      ? (await enrichSongsForMixRatingFilter(random, mixCfg)).filter(s => passesMixMinRatings(s, mixCfg))
      : random;
    for (const track of shuffleArray(filteredRandomSongs.map(songToTrack))) {
      if (track.id === seedId || seenIds.has(track.id)) continue;
      out.push({ ...track, autoAdded: true as const });
      seenIds.add(track.id);
      if (out.length >= count) break;
    }
  }

  return out.slice(0, count);
}

interface PlayerState {
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
   *  orbit bulk-gate should leave it `undefined`. */
  playTrack: (track: Track, queue?: Track[], manual?: boolean, _orbitConfirmed?: boolean) => void;
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
  };
  openContextMenu: (x: number, y: number, item: any, type: 'song' | 'favorite-song' | 'album' | 'artist' | 'queue-item' | 'album-song' | 'playlist' | 'multi-album' | 'multi-artist' | 'multi-playlist', queueIndex?: number, playlistId?: string, playlistSongIndex?: number) => void;
  closeContextMenu: () => void;

  songInfoModal: { isOpen: boolean; songId: string | null };
  openSongInfo: (songId: string) => void;
  closeSongInfo: () => void;
}

type WaveformCachePayload = {
  /** May be `number[]` or `Uint8Array` depending on Tauri IPC / serde path. */
  bins: number[] | Uint8Array;
  binCount: number;
  isPartial: boolean;
  knownUntilSec: number;
  durationSec: number;
  updatedAt: number;
};

/** v4: `500` peak + `500` mean-abs = `1000` bytes. Legacy single curve: `500` (treated as mean=max). */
function waveformBlobLenOk(len: number): boolean {
  return len === 500 || len === 1000;
}

/** `Vec<u8>` from Rust often arrives as `Uint8Array`, not `Array.isArray`. */
function coerceWaveformBins(bins: unknown): number[] | null {
  if (bins == null) return null;
  let raw: number[] | null = null;
  if (Array.isArray(bins)) {
    if (bins.length === 0) return null;
    raw = bins.map(x => Number(x) & 255);
  } else if (bins instanceof Uint8Array) {
    if (bins.length === 0) return null;
    raw = Array.from(bins);
  } else if (typeof bins === 'object' && 'length' in bins && typeof (bins as { length: unknown }).length === 'number') {
    const len = (bins as { length: number }).length;
    if (len === 0) return null;
    try {
      raw = Array.from(bins as ArrayLike<number>).map(x => Number(x) & 255);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (!waveformBlobLenOk(raw.length)) return null;
  return raw;
}

type LoudnessCachePayload = {
  integratedLufs: number;
  truePeak: number;
  recommendedGainDb: number;
  targetLufs: number;
  updatedAt: number;
};

type NormalizationStatePayload = {
  engine: 'off' | 'replaygain' | 'loudness' | string;
  currentGainDb: number | null;
  targetLufs: number;
};

// ─── Module-level playback primitives ─────────────────────────────────────────

// isAudioPaused — true when the Rust audio engine has a loaded-but-paused track.
// Used by resume() to decide between audio_resume (warm) vs audio_play (cold start).
let isAudioPaused = false;

// JS-side generation counter. Incremented on every playTrack() call.
// The invoke().catch() error handler captures its own gen and bails if
// playGeneration has moved on, preventing stale errors from skipping wrong tracks.
let playGeneration = 0;

// Guard against concurrent infinite-queue fetches.
let infiniteQueueFetching = false;
// Guard against concurrent radio top-up fetches.
let radioFetching = false;
// Artist ID used to start the current radio session — persists across track
// advances so proactive loading works even when songs lack artistId.
let currentRadioArtistId: string | null = null;
let cachedLoudnessGainByTrackId: Record<string, number> = {};
let stableLoudnessGainByTrackId: Record<string, true> = {};
let lastNormalizationUiUpdateAtMs = 0;

/** Bounded stack of queue snapshots for Ctrl+Z / Cmd+Z undo. */
const QUEUE_UNDO_MAX = 32;
type QueueUndoSnapshot = {
  queue: Track[];
  queueIndex: number;
  currentTrack: Track | null;
  /** Seconds — captured with the snapshot (older entries may omit). */
  currentTime?: number;
  progress?: number;
  isPlaying?: boolean;
  /** Main queue panel list `scrollTop` when the snapshot was taken. */
  queueListScrollTop?: number;
};
const queueUndoStack: QueueUndoSnapshot[] = [];
const queueRedoStack: QueueUndoSnapshot[] = [];

/** QueuePanel registers a reader so undo snapshots capture list scroll position. */
let queueListScrollTopReader: (() => number | undefined) | null = null;

export function registerQueueListScrollTopReader(reader: (() => number | undefined) | null): void {
  queueListScrollTopReader = reader;
}

function readQueueListScrollTopForUndo(): number | undefined {
  return queueListScrollTopReader?.() ?? undefined;
}

/** Set in applyQueueHistorySnapshot; QueuePanel consumes in useLayoutEffect after commit. */
let pendingQueueListScrollTop: number | undefined;

export function consumePendingQueueListScrollTop(): number | undefined {
  const v = pendingQueueListScrollTop;
  pendingQueueListScrollTop = undefined;
  return v;
}

function shallowCloneQueueTracks(queue: Track[]): Track[] {
  return queue.map(t => ({ ...t }));
}

function queueUndoSnapshotFromState(s: PlayerState): QueueUndoSnapshot {
  const scrollTop = readQueueListScrollTopForUndo();
  return {
    queue: shallowCloneQueueTracks(s.queue),
    queueIndex: s.queueIndex,
    currentTrack: s.currentTrack ? { ...s.currentTrack } : null,
    currentTime: s.currentTime,
    progress: s.progress,
    isPlaying: s.isPlaying,
    ...(scrollTop !== undefined ? { queueListScrollTop: scrollTop } : {}),
  };
}

function pushQueueUndoFromGetter(get: () => PlayerState) {
  queueRedoStack.length = 0;
  queueUndoStack.push(queueUndoSnapshotFromState(get()));
  while (queueUndoStack.length > QUEUE_UNDO_MAX) queueUndoStack.shift();
}

/** Reload Rust audio to match a queue-undo snapshot (Zustand alone does not move the engine). */
function queueUndoRestoreAudioEngine(opts: {
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
  const url = resolvePlaybackUrl(track.id, authState.activeServerId ?? '');
  recordEnginePlayUrl(track.id, url);
  usePlayerStore.setState({
    currentPlaybackSource: playbackSourceHintForResolvedUrl(track.id, authState.activeServerId ?? '', url),
  });
  const keepPreloadHint = usePlayerStore.getState().enginePreloadedTrackId === track.id;
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
    hiResEnabled: authState.enableHiRes,
    analysisTrackId: track.id,
    streamFormatSuffix: track.suffix ?? null,
  })
    .then(() => {
      if (playGeneration !== generation) return;
      if (keepPreloadHint) {
        usePlayerStore.setState({ enginePreloadedTrackId: null });
      }
      const dur = track.duration && track.duration > 0 ? track.duration : null;
      const seekTo = Math.max(0, atSeconds);
      const canSeek = seekTo > 0.05 && (dur == null || seekTo < dur - 0.05);
      const afterSeek = () => {
        if (playGeneration !== generation) return;
        if (!wantPlaying) {
          invoke('audio_pause').catch(console.error);
          isAudioPaused = true;
          usePlayerStore.setState({ isPlaying: false });
        } else {
          isAudioPaused = false;
        }
      };
      if (canSeek) {
        void invoke('audio_seek', { seconds: seekTo }).then(afterSeek).catch(afterSeek);
      } else {
        afterSeek();
      }
    })
    .catch((err: unknown) => {
      if (playGeneration !== generation) return;
      console.error('[psysonic] queue-undo audio_play failed:', err);
      usePlayerStore.setState({ isPlaying: false });
    })
    .finally(() => {
      setDeferHotCachePrefetch(false);
    });
  touchHotCacheOnPlayback(track.id, authState.activeServerId ?? '');
}

function emitNormalizationDebug(step: string, details?: Record<string, unknown>) {
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  void invoke('frontend_debug_log', {
    scope: 'normalization',
    message: JSON.stringify({ step, details }),
  }).catch(() => {});
}

function normalizeAnalysisTrackId(trackId?: string | null): string | null {
  if (!trackId) return null;
  if (trackId.startsWith('stream:')) return trackId.slice('stream:'.length);
  return trackId;
}

/** Compare track ids across `stream:` / bare Subsonic forms. */
function sameQueueTrackId(a: string | undefined | null, b: string | undefined | null): boolean {
  if (a == null || b == null) return false;
  const na = normalizeAnalysisTrackId(a) ?? a;
  const nb = normalizeAnalysisTrackId(b) ?? b;
  return na === nb;
}

function queuesStructuralEqual(a: Track[], b: Track[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameQueueTrackId(a[i]?.id, b[i]?.id)) return false;
  }
  return true;
}

function normalizationAlmostEqual(a: number | null, b: number | null, eps = 0.12): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= eps;
}

function deriveNormalizationSnapshot(
  track: Track,
  queue: Track[],
  queueIndex: number,
): Pick<
  PlayerState,
  'normalizationNowDb' | 'normalizationTargetLufs' | 'normalizationEngineLive'
> {
  const auth = useAuthStore.getState();
  const engine = auth.normalizationEngine;
  if (engine === 'loudness') {
    const target = auth.loudnessTargetLufs;
    return {
      // Clears stale UI until `audio:normalization-state` / refresh catches up.
      normalizationNowDb: null,
      normalizationTargetLufs: target,
      normalizationEngineLive: 'loudness',
    };
  }
  if (engine === 'replaygain' && auth.replayGainEnabled) {
    const prev = queueIndex > 0 ? queue[queueIndex - 1] : null;
    const next = queueIndex + 1 < queue.length ? queue[queueIndex + 1] : null;
    const resolved = resolveReplayGainDb(track, prev, next, true, auth.replayGainMode);
    const nowDb = resolved != null ? (resolved + auth.replayGainPreGainDb) : auth.replayGainFallbackDb;
    return {
      normalizationNowDb: nowDb,
      normalizationTargetLufs: null,
      normalizationEngineLive: 'replaygain',
    };
  }
  return {
    normalizationNowDb: null,
    normalizationTargetLufs: null,
    normalizationEngineLive: 'off',
  };
}

// Debounce timer for seek slider drags.
let seekDebounce: ReturnType<typeof setTimeout> | null = null;
// Target time of the last seek — blocks stale Rust progress ticks until the
// engine has actually caught up to the new position.
let seekTarget: number | null = null;
let seekTargetSetAt = 0;
const SEEK_TARGET_GUARD_TIMEOUT_MS = 5000;
const analysisBackfillInFlightByTrackId: Record<string, true> = {};
const analysisBackfillAttemptsByTrackId: Record<string, number> = {};
const MAX_BACKFILL_ATTEMPTS_PER_TRACK = 2;
// Streaming fallback seek guard: coalesce repeated "not seekable" recoveries.
let seekFallbackRetryTimer: ReturnType<typeof setTimeout> | null = null;
let seekFallbackRetryStartedAt = 0;
let seekFallbackRetryTarget: { trackId: string; seconds: number } | null = null;
let seekFallbackTrackId: string | null = null;
let seekFallbackRestartAt = 0;
let seekFallbackVisualTarget: { trackId: string; seconds: number; setAtMs: number } | null = null;
const SEEK_FALLBACK_VISUAL_GUARD_MS = 1600;
const SEEK_FALLBACK_RETRY_INTERVAL_MS = 180;
const SEEK_FALLBACK_RETRY_MAX_MS = 6000;
const LIVE_PROGRESS_EMIT_MIN_MS = 1500;
const LIVE_PROGRESS_EMIT_MIN_DELTA_SEC = 0.9;
let lastLiveProgressEmitAt = 0;
const STORE_PROGRESS_COMMIT_MIN_MS = 20_000;
const STORE_PROGRESS_COMMIT_MIN_DELTA_SEC = 5.0;
let lastStoreProgressCommitAt = 0;

export type PlaybackProgressSnapshot = {
  currentTime: number;
  progress: number;
  buffered: number;
};

let playbackProgressSnapshot: PlaybackProgressSnapshot = {
  currentTime: 0,
  progress: 0,
  buffered: 0,
};
const playbackProgressListeners = new Set<(
  next: PlaybackProgressSnapshot,
  prev: PlaybackProgressSnapshot
) => void>();

function emitPlaybackProgress(next: PlaybackProgressSnapshot): void {
  const prev = playbackProgressSnapshot;
  if (
    Math.abs(prev.currentTime - next.currentTime) < 0.005 &&
    Math.abs(prev.progress - next.progress) < 0.0002 &&
    Math.abs(prev.buffered - next.buffered) < 0.0002
  ) {
    return;
  }
  playbackProgressSnapshot = next;
  playbackProgressListeners.forEach(cb => cb(next, prev));
}

export function getPlaybackProgressSnapshot(): PlaybackProgressSnapshot {
  return playbackProgressSnapshot;
}

export function subscribePlaybackProgress(
  cb: (next: PlaybackProgressSnapshot, prev: PlaybackProgressSnapshot) => void,
): () => void {
  playbackProgressListeners.add(cb);
  return () => {
    playbackProgressListeners.delete(cb);
  };
}


/** Deferred pause / resume — cleared on stop, new track, manual pause/resume. */
let scheduledPauseTimer: number | null = null;
let scheduledResumeTimer: number | null = null;

function clearScheduledPauseTimers() {
  if (scheduledPauseTimer != null) {
    window.clearTimeout(scheduledPauseTimer);
    scheduledPauseTimer = null;
  }
}

function clearScheduledResumeTimers() {
  if (scheduledResumeTimer != null) {
    window.clearTimeout(scheduledResumeTimer);
    scheduledResumeTimer = null;
  }
}

function clearAllPlaybackScheduleTimers() {
  clearScheduledPauseTimers();
  clearScheduledResumeTimers();
}

function setSeekTarget(seconds: number) {
  seekTarget = seconds;
  seekTargetSetAt = Date.now();
}

function clearSeekTarget() {
  seekTarget = null;
  seekTargetSetAt = 0;
}

function clearSeekFallbackRetry() {
  if (seekFallbackRetryTimer) {
    clearTimeout(seekFallbackRetryTimer);
    seekFallbackRetryTimer = null;
  }
  seekFallbackRetryStartedAt = 0;
  seekFallbackRetryTarget = null;
}

function isRecoverableSeekError(msg: string): boolean {
  return msg.includes('not seekable')
    || msg.includes('audio sink not ready')
    || msg.includes('audio seek busy')
    || msg.includes('audio seek timeout');
}

function scheduleSeekFallbackRetry(trackId: string, seconds: number) {
  const now = Date.now();
  if (
    !seekFallbackRetryTarget
    || seekFallbackRetryTarget.trackId !== trackId
    || Math.abs(seekFallbackRetryTarget.seconds - seconds) > 0.25
  ) {
    clearSeekFallbackRetry();
    seekFallbackRetryStartedAt = now;
    seekFallbackRetryTarget = { trackId, seconds };
  } else if (seekFallbackRetryStartedAt === 0) {
    seekFallbackRetryStartedAt = now;
  }
  if (seekFallbackRetryTimer) clearTimeout(seekFallbackRetryTimer);
  seekFallbackRetryTimer = setTimeout(() => {
    seekFallbackRetryTimer = null;
    const target = seekFallbackRetryTarget;
    const s = usePlayerStore.getState();
    if (!target || !s.currentTrack || s.currentTrack.id !== target.trackId) {
      clearSeekFallbackRetry();
      return;
    }
    if (Date.now() - seekFallbackRetryStartedAt > SEEK_FALLBACK_RETRY_MAX_MS) {
      clearSeekFallbackRetry();
      seekFallbackVisualTarget = null;
      return;
    }
    invoke('audio_seek', { seconds: target.seconds }).then(() => {
      setSeekTarget(target.seconds);
      seekFallbackVisualTarget = null;
      clearSeekFallbackRetry();
    }).catch((err: unknown) => {
      const msg = String(err ?? '');
      if (!isRecoverableSeekError(msg)) {
        console.error(err);
        seekFallbackVisualTarget = null;
        clearSeekFallbackRetry();
        return;
      }
      scheduleSeekFallbackRetry(target.trackId, target.seconds);
    });
  }, SEEK_FALLBACK_RETRY_INTERVAL_MS);
}

// Guard against rapid double-click play/pause sending two state transitions
// to the Rust backend before it has finished the previous one.
let togglePlayLock = false;
/**
 * Skip → 1★: counts in `authStore.skipStarManualSkipCountsByKey` (persisted).
 * Only user-initiated `next()` increments. Natural track end (incl. gapless) clears the count;
 * threshold reached clears count and sets 1★ if still unrated.
 */
function applySkipStarOnManualNext(skippedTrack: Track | null, manual: boolean): void {
  if (!manual || !skippedTrack) return;
  const id = skippedTrack.id;
  const adv = useAuthStore.getState().recordSkipStarManualAdvance(id);
  if (!adv?.crossedThreshold) return;
  const live = usePlayerStore.getState();
  const fromQueue = live.queue.find(t => t.id === id);
  const cur =
    live.userRatingOverrides[id] ??
    fromQueue?.userRating ??
    skippedTrack.userRating ??
    0;
  if (cur >= 1) return;
  setRating(id, 1)
    .then(() => {
      usePlayerStore.setState(s => ({
        queue: s.queue.map(t => (t.id === id ? { ...t, userRating: 1 } : t)),
        currentTrack: s.currentTrack?.id === id ? { ...s.currentTrack, userRating: 1 } : s.currentTrack,
        userRatingOverrides: { ...s.userRatingOverrides, [id]: 1 },
      }));
    })
    .catch(() => {});
}

// ── HTML5 Radio Player ────────────────────────────────────────────────────────
// Internet radio streams are played via a native <audio> element instead of
// the Rust/Symphonia engine.  This gives us browser-native reconnect logic,
// codec support (MP3, AAC, HE-AAC, OGG) and stable ICY stream handling for
// free, without touching the regular playback pipeline at all.
const radioAudio = new Audio();
radioAudio.preload = 'none';
let radioStopping = false;
// Pending reconnect timer for stalled streams — null when no reconnect is scheduled.
let radioReconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Counts how many stalled-reconnects have been attempted for the current station.
// Reset to 0 on successful playback.  Hard-stop after MAX_RADIO_RECONNECTS so a
// dead stream doesn't loop forever and leak resources in the background.
let radioReconnectCount = 0;
const MAX_RADIO_RECONNECTS = 5;

function clearRadioReconnectTimer() {
  if (radioReconnectTimer) { clearTimeout(radioReconnectTimer); radioReconnectTimer = null; }
}

radioAudio.addEventListener('ended', () => {
  // Stream disconnected unexpectedly — clear radio state.
  clearRadioReconnectTimer();
  radioReconnectCount = 0;
  usePlayerStore.setState({ isPlaying: false, currentRadio: null, progress: 0, currentTime: 0 });
});
radioAudio.addEventListener('error', () => {
  clearRadioReconnectTimer();
  if (radioStopping) { radioStopping = false; radioReconnectCount = 0; return; }
  radioReconnectCount = 0;
  usePlayerStore.setState({ isPlaying: false, currentRadio: null });
  showToast('Radio stream error', 3000, 'error');
});
// Playing: stream is delivering audio — reset the reconnect counter.
radioAudio.addEventListener('playing', () => {
  radioReconnectCount = 0;
});
// Stalled: stream stopped delivering data — try to reconnect after 4 s.
// On macOS/WKWebView, reassigning src during a stall can itself trigger
// another stall event before the new connection is established.  The
// radioReconnectTimer guard prevents stacking, and MAX_RADIO_RECONNECTS
// ensures we don't loop forever on a dead stream.
radioAudio.addEventListener('stalled', () => {
  if (radioReconnectTimer) return; // already scheduled
  if (radioReconnectCount >= MAX_RADIO_RECONNECTS) {
    radioReconnectCount = 0;
    usePlayerStore.setState({ isPlaying: false, currentRadio: null });
    showToast('Radio stream disconnected', 4000, 'error');
    return;
  }
  radioReconnectTimer = setTimeout(() => {
    radioReconnectTimer = null;
    if (!usePlayerStore.getState().currentRadio) return;
    radioReconnectCount++;
    // Use load() + play() instead of src reassignment — more reliable on
    // macOS WKWebView where setting src can fire a premature error event.
    radioAudio.load();
    radioAudio.play().catch(console.error);
  }, 4000);
});
// Waiting: browser is rebuffering — normal for live streams, no action needed.
radioAudio.addEventListener('waiting', () => {
  console.debug('[psysonic] radio: buffering');
});
// Suspend: browser paused loading (sufficient buffer) — cancel any stale reconnect.
radioAudio.addEventListener('suspend', () => {
  clearRadioReconnectTimer();
});

// Timestamp of the last gapless auto-advance (from audio:track_switched).
// Used to suppress ghost-commands from stale IPC arriving after the switch.
let lastGaplessSwitchTime = 0;

function touchHotCacheOnPlayback(trackId: string, serverId: string) {
  if (!trackId || !serverId) return;
  useHotCacheStore.getState().touchPlayed(trackId, serverId);
}

/** Last-write-wins generation per track: avoids applying a stale empty waveform read when
 * `analysis:waveform-updated` bumps gen after SQLite commit while an older `analysis_get_waveform_for_track`
 * is still in flight. Gen is bumped only on explicit invalidation (waveform-updated, analysis storage),
 * not on every `refreshWaveformForTrack` call — otherwise bursts (Lucky Mix, queue) cancel each other. */
const waveformRefreshGenByTrackId: Record<string, number> = {};

function bumpWaveformRefreshGen(trackId: string) {
  if (!trackId) return;
  waveformRefreshGenByTrackId[trackId] = (waveformRefreshGenByTrackId[trackId] ?? 0) + 1;
}

/** Coalesce concurrent `analysis_get_loudness_for_track` for one id+mode pair. The
 *  analysis:waveform-updated listener fires refreshWaveform + refreshLoudness in
 *  parallel for every full-track analysis completion; without coalescing, gapless
 *  preload + current-track completion can stack two SQLite reads + two state writes. */
const loudnessRefreshInflight = new Map<string, Promise<void>>();

/** Skip redundant `audio_set_normalization` IPC when the same payload is sent twice within a short window (e.g. StrictMode). */
let lastNormAudioInvokeKey = '';
let lastNormAudioInvokeAtMs = 0;

function invokeAudioSetNormalizationDeduped(payload: {
  engine: string;
  targetLufs: number;
  preAnalysisAttenuationDb: number;
}) {
  const key = `${payload.engine}|${payload.targetLufs}|${payload.preAnalysisAttenuationDb}`;
  const now = Date.now();
  if (key === lastNormAudioInvokeKey && now - lastNormAudioInvokeAtMs < 450) {
    return;
  }
  lastNormAudioInvokeKey = key;
  lastNormAudioInvokeAtMs = now;
  void invoke('audio_set_normalization', payload).catch(() => {});
}

/**
 * Skip redundant `audio_update_replay_gain` IPC when the same payload was sent
 * recently. updateReplayGainForCurrentTrack runs from the analysis:loudness-partial
 * listener (~every 900 ms while LUFS is on); without dedupe each tick triggers a
 * full IPC roundtrip + backend audio:normalization-state echo + frontend setState,
 * which saturates the WebView2 renderer thread on Windows after a few minutes.
 */
let lastRgInvokeKey = '';
let lastRgInvokeAtMs = 0;

function invokeAudioUpdateReplayGainDeduped(payload: {
  volume: number;
  replayGainDb: number | null;
  replayGainPeak: number | null;
  loudnessGainDb: number | null;
  preGainDb: number;
  fallbackDb: number;
}) {
  const auth = useAuthStore.getState();
  /** Must vary when LUFS target / pre-trim changes: Rust recomputes in `audio_update_replay_gain` even if JS still sends the same cached dB. */
  const preEff =
    auth.normalizationEngine === 'loudness'
      ? effectiveLoudnessPreAnalysisAttenuationDb(
          auth.loudnessPreAnalysisAttenuationDb,
          auth.loudnessTargetLufs,
        )
      : auth.loudnessPreAnalysisAttenuationDb;
  const normDedupeKey =
    auth.normalizationEngine === 'loudness'
      ? `loudness|tgt=${auth.loudnessTargetLufs}|pre=${preEff.toFixed(2)}`
      : auth.normalizationEngine === 'replaygain'
        ? 'replaygain'
        : 'off';
  const fmt = (v: number | null) => (v == null || !Number.isFinite(v) ? 'null' : v.toFixed(3));
  const key = [
    normDedupeKey,
    payload.volume.toFixed(4),
    fmt(payload.replayGainDb),
    fmt(payload.replayGainPeak),
    fmt(payload.loudnessGainDb),
    payload.preGainDb.toFixed(2),
    payload.fallbackDb.toFixed(2),
  ].join('|');
  const now = Date.now();
  if (key === lastRgInvokeKey && now - lastRgInvokeAtMs < 250) {
    return;
  }
  lastRgInvokeKey = key;
  lastRgInvokeAtMs = now;
  invoke('audio_update_replay_gain', payload).catch(console.error);
}

function isReplayGainActive() {
  const a = useAuthStore.getState();
  return a.normalizationEngine === 'replaygain' && a.replayGainEnabled;
}

function loudnessCacheStateKeysForTrackId(trackId: string): string[] {
  if (!trackId) return [];
  const out: string[] = [trackId];
  if (trackId.startsWith('stream:')) {
    const bare = trackId.slice('stream:'.length);
    if (bare) out.push(bare);
  } else {
    out.push(`stream:${trackId}`);
  }
  return out;
}

function clearLoudnessCacheStateForTrackId(trackId: string) {
  for (const k of loudnessCacheStateKeysForTrackId(trackId)) {
    delete cachedLoudnessGainByTrackId[k];
    delete stableLoudnessGainByTrackId[k];
  }
}

/** Pass to `audio_play` / `audio_chain_preload` only — DB-backed gain. Omit partial hints so Rust uses pre-trim until `analysis:loudness-partial` + `audio_update_replay_gain`. */
function loudnessGainDbForEngineBind(trackId: string | undefined | null): number | null {
  if (!trackId) return null;
  if (!stableLoudnessGainByTrackId[trackId]) return null;
  const v = cachedLoudnessGainByTrackId[trackId];
  return Number.isFinite(v) ? v : null;
}

function resetLoudnessBackfillStateForTrackId(trackId: string) {
  for (const k of loudnessCacheStateKeysForTrackId(trackId)) {
    delete analysisBackfillInFlightByTrackId[k];
    analysisBackfillAttemptsByTrackId[k] = 0;
  }
}

async function reseedLoudnessForTrackId(trackId: string) {
  if (!trackId) return;
  const auth = useAuthStore.getState();
  if (auth.normalizationEngine !== 'loudness') return;
  clearLoudnessCacheStateForTrackId(trackId);
  resetLoudnessBackfillStateForTrackId(trackId);
  if (auth.normalizationEngine === 'loudness') {
    usePlayerStore.setState({
      normalizationNowDb: null,
      normalizationTargetLufs: auth.loudnessTargetLufs,
      normalizationEngineLive: 'loudness',
    });
  }
  try {
    await invoke('analysis_delete_loudness_for_track', { trackId });
  } catch (e) {
    console.error('[psysonic] analysis_delete_loudness_for_track failed:', e);
  }
  usePlayerStore.getState().updateReplayGainForCurrentTrack();
  const url = buildStreamUrl(trackId);
  try {
    await invoke('analysis_enqueue_seed_from_url', {
      trackId,
      url,
      force: true,
    });
  } catch (e) {
    console.error('[psysonic] analysis_enqueue_seed_from_url (reseed) failed:', e);
  }
}

async function refreshWaveformForTrack(trackId: string) {
  if (!trackId) return;
  const gen = waveformRefreshGenByTrackId[trackId] ?? 0;
  try {
    const row = await invoke<WaveformCachePayload | null>('analysis_get_waveform_for_track', { trackId });
    if ((waveformRefreshGenByTrackId[trackId] ?? 0) !== gen) return;
    // Never apply bins for a non-current track (e.g. gapless byte-preload fetches the neighbour).
    if (usePlayerStore.getState().currentTrack?.id !== trackId) return;
    const bins = row ? coerceWaveformBins(row.bins) : null;
    if (!bins || bins.length === 0) {
      usePlayerStore.setState({
        waveformBins: null,
      });
      return;
    }
    usePlayerStore.setState({
      waveformBins: bins,
    });
  } catch {
    // best-effort; seekbar falls back to placeholder waveform
  }
}

/** When `syncPlayingEngine` is false, only update `cachedLoudnessGainByTrackId` (e.g. queue neighbour) — do not call `audio_update_replay_gain` for the already-playing track. */
async function refreshLoudnessForTrack(
  trackId: string,
  opts?: { syncPlayingEngine?: boolean },
): Promise<void> {
  if (!trackId) return;
  const syncEngine = opts?.syncPlayingEngine !== false;
  const target = useAuthStore.getState().loudnessTargetLufs;
  const inflightKey = `${trackId}|${syncEngine ? 'sync' : 'no-sync'}|${target}`;
  const existing = loudnessRefreshInflight.get(inflightKey);
  if (existing) return existing;
  const job = (async () => { await runRefreshLoudnessForTrack(trackId, syncEngine); })()
    .finally(() => { loudnessRefreshInflight.delete(inflightKey); });
  loudnessRefreshInflight.set(inflightKey, job);
  return job;
}

async function runRefreshLoudnessForTrack(trackId: string, syncEngine: boolean): Promise<void> {
  emitNormalizationDebug('refresh:start', { trackId });
  usePlayerStore.setState({ normalizationDbgSource: 'refresh:start', normalizationDbgTrackId: trackId });
  try {
    const requestedTarget = useAuthStore.getState().loudnessTargetLufs;
    const row = await invoke<LoudnessCachePayload | null>('analysis_get_loudness_for_track', {
      trackId,
      targetLufs: requestedTarget,
    });
    if (useAuthStore.getState().loudnessTargetLufs !== requestedTarget) {
      emitNormalizationDebug('refresh:stale-target', { trackId, requestedTarget });
      void refreshLoudnessForTrack(trackId, { syncPlayingEngine: syncEngine });
      return;
    }
    if (!row || !Number.isFinite(row.recommendedGainDb)) {
      delete cachedLoudnessGainByTrackId[trackId];
      delete stableLoudnessGainByTrackId[trackId];
      emitNormalizationDebug('refresh:miss', { trackId, row: row ?? null });
      const auth = useAuthStore.getState();
      const attempts = analysisBackfillAttemptsByTrackId[trackId] ?? 0;
      if (auth.normalizationEngine === 'loudness'
        && !analysisBackfillInFlightByTrackId[trackId]
        && attempts < MAX_BACKFILL_ATTEMPTS_PER_TRACK) {
        analysisBackfillInFlightByTrackId[trackId] = true;
        analysisBackfillAttemptsByTrackId[trackId] = attempts + 1;
        const url = buildStreamUrl(trackId);
        emitNormalizationDebug('backfill:enqueue', {
          trackId,
          url: redactSubsonicUrlForLog(url),
          attempt: attempts + 1,
        });
        void invoke('analysis_enqueue_seed_from_url', { trackId, url })
          .then(() => emitNormalizationDebug('backfill:queued', { trackId, attempt: attempts + 1 }))
          .catch((e) => emitNormalizationDebug('backfill:error', { trackId, error: String(e) }))
          .finally(() => {
            delete analysisBackfillInFlightByTrackId[trackId];
          });
      } else if (auth.normalizationEngine === 'loudness' && attempts >= MAX_BACKFILL_ATTEMPTS_PER_TRACK) {
        emitNormalizationDebug('backfill:throttled', { trackId, attempts });
      }
      usePlayerStore.setState({
        normalizationDbgSource: 'refresh:miss',
        normalizationDbgTrackId: trackId,
        normalizationDbgCacheGainDb: null,
        normalizationDbgCacheTargetLufs: Number.isFinite(row?.targetLufs as number) ? (row?.targetLufs as number) : null,
        normalizationDbgCacheUpdatedAt: Number.isFinite(row?.updatedAt as number) ? (row?.updatedAt as number) : null,
      });
      return;
    }
    cachedLoudnessGainByTrackId[trackId] = row.recommendedGainDb;
    stableLoudnessGainByTrackId[trackId] = true;
    analysisBackfillAttemptsByTrackId[trackId] = 0;
    emitNormalizationDebug('refresh:hit', { trackId, row });
    usePlayerStore.setState({
      normalizationDbgSource: 'refresh:hit',
      normalizationDbgTrackId: trackId,
      normalizationDbgCacheGainDb: row.recommendedGainDb,
      normalizationDbgCacheTargetLufs: Number.isFinite(row.targetLufs) ? row.targetLufs : null,
      normalizationDbgCacheUpdatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : null,
    });
    if (syncEngine) {
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    }
  } catch {
    delete cachedLoudnessGainByTrackId[trackId];
    delete stableLoudnessGainByTrackId[trackId];
    emitNormalizationDebug('refresh:error', { trackId });
    usePlayerStore.setState({ normalizationDbgSource: 'refresh:error', normalizationDbgTrackId: trackId });
  }
}

/** After bulk enqueue, warm loudness cache so gapless `audio_chain_preload` sees real gain, not only startup trim. */
const LOUDNESS_PREFETCH_MAX_ENQUEUED_IDS = 40;

function prefetchLoudnessForEnqueuedTracks(
  incoming: Track[],
  mergedQueue: Track[],
  queueIndex: number,
) {
  if (useAuthStore.getState().normalizationEngine !== 'loudness') return;
  const ids = new Set<string>();
  const next = mergedQueue[queueIndex + 1];
  if (next?.id) ids.add(next.id);
  let n = 0;
  for (const t of incoming) {
    if (n >= LOUDNESS_PREFETCH_MAX_ENQUEUED_IDS) break;
    if (t?.id) {
      ids.add(t.id);
      n++;
    }
  }
  for (const id of ids) {
    void refreshLoudnessForTrack(id, { syncPlayingEngine: false });
  }
}

async function promoteCompletedStreamToHotCache(track: Track, serverId: string, customDir: string | null) {
  try {
    const res = await invoke<{ path: string; size: number } | null>(
      'promote_stream_cache_to_hot_cache',
      {
        trackId: track.id,
        serverId,
        url: buildStreamUrl(track.id),
        suffix: track.suffix || 'mp3',
        customDir,
      },
    );
    if (!res || !res.path) return;
    useHotCacheStore.getState().setEntry(track.id, serverId, res.path, res.size || 0, 'stream-promote');
  } catch {
    // best-effort promotion; normal hot-cache prefetch remains fallback
  }
}

/**
 * Tracks the **actual** `audio_play` URL family: `getPlaybackSourceKind()` can
 * report `hot` for RAM preload or disk index while the engine still uses HTTP.
 * Rebind-to-local seeks need this, not the UI hint alone.
 */
let lastOpenedWithHttpTrackId: string | null = null;

function recordEnginePlayUrl(trackId: string, url: string): void {
  lastOpenedWithHttpTrackId = url.startsWith('psysonic-local://') ? null : trackId;
}

/** Matches `playTrack` / PlayerBar: stream vs hot-cache vs offline file from resolved `audio_play` URL. */
function playbackSourceHintForResolvedUrl(trackId: string, serverId: string, url: string): PlaybackSourceKind {
  if (!url.startsWith('psysonic-local://')) return 'stream';
  return useOfflineStore.getState().getLocalUrl(trackId, serverId) ? 'offline' : 'hot';
}

function shouldRebindPlaybackToHotCache(trackId: string, serverId: string): boolean {
  if (!serverId) return false;
  if (!lastOpenedWithHttpTrackId || !sameQueueTrackId(lastOpenedWithHttpTrackId, trackId)) {
    return false;
  }
  return resolvePlaybackUrl(trackId, serverId).startsWith('psysonic-local://');
}

// Track ID that has already been sent to audio_chain_preload (gapless chain).
let gaplessPreloadingId: string | null = null;
// Track ID that has already been sent to audio_preload (byte pre-download).
let bytePreloadingId: string | null = null;

// ─── Server queue sync ─────────────────────────────────────────────────────────
let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let lastQueueHeartbeatAt = 0;

function syncQueueToServer(queue: Track[], currentTrack: Track | null, currentTime: number) {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    syncTimeout = null;
    const ids = queue.slice(0, 1000).map(t => t.id);
    const pos = Math.floor(currentTime * 1000);
    savePlayQueue(ids, currentTrack?.id, pos).catch(err => {
      console.error('Failed to sync play queue to server', err);
    });
  }, 5000);
}

// Cancel any pending debounced sync and push the current position
// immediately. Used by the playback heartbeat, pause(), and the
// app-close handler — all paths where a user might switch to another
// device and expect to resume from the right spot.
function flushQueueSyncToServer(queue: Track[], currentTrack: Track | null, currentTime: number): Promise<void> {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
  if (!currentTrack || queue.length === 0) return Promise.resolve();
  lastQueueHeartbeatAt = Date.now();
  const ids = queue.slice(0, 1000).map(t => t.id);
  const pos = Math.floor(currentTime * 1000);
  return savePlayQueue(ids, currentTrack.id, pos).catch(err => {
    console.error('Failed to flush play queue to server', err);
  });
}

export function flushPlayQueuePosition(): Promise<void> {
  const s = usePlayerStore.getState();
  if (s.currentRadio) return Promise.resolve();
  return flushQueueSyncToServer(s.queue, s.currentTrack, getPlaybackProgressSnapshot().currentTime);
}

// ─── Audio event handlers (called from initAudioListeners) ───────────────────

function handleAudioPlaying(_duration: number) {
  setDeferHotCachePrefetch(false);
  lastLiveProgressEmitAt = 0;
  lastStoreProgressCommitAt = 0;
  usePlayerStore.setState({ isPlaying: true });
}

function handleAudioProgress(current_time: number, duration: number) {
  bumpPerfCounter('audioProgressEvents');
  const perfFlags = getPerfProbeFlags();
  const progressUiDisabled = perfFlags.disablePlayerProgressUi;
  // While a seek is pending, the store already holds the optimistic target
  // position.  Accepting stale progress from the Rust engine would briefly
  // snap the waveform back to the old position before the seek completes.
  if (seekDebounce) return;
  // After the debounce fires, Rust may still emit 1–2 ticks with the old
  // position before the seek takes effect.  Block until current_time is
  // within 2 s of the requested target, then clear the guard.
  if (seekTarget !== null) {
    if (Math.abs(current_time - seekTarget) > 2.0) {
      // If a seek command hangs while streaming is stalled, do not freeze UI.
      if (Date.now() - seekTargetSetAt <= SEEK_TARGET_GUARD_TIMEOUT_MS) return;
      clearSeekTarget();
    } else {
      clearSeekTarget();
    }
  }

  const store = usePlayerStore.getState();
  const track = store.currentTrack;
  if (!track) return;
  // Some backends can emit stale progress ticks shortly after pause/stop.
  // Ignoring them avoids reactivating UI redraw loops while transport is idle.
  const transportActive = store.isPlaying || store.currentRadio != null;
  if (!transportActive && !seekFallbackVisualTarget) return;
  if (seekFallbackVisualTarget && seekFallbackVisualTarget.trackId !== track.id) {
    seekFallbackVisualTarget = null;
  }
  let displayTime = current_time;
  if (
    seekFallbackVisualTarget
    && seekFallbackVisualTarget.trackId === track.id
  ) {
    const nearTarget = Math.abs(current_time - seekFallbackVisualTarget.seconds) <= 2.0;
    if (nearTarget) {
      seekFallbackVisualTarget = null;
    } else if (Date.now() - seekFallbackVisualTarget.setAtMs <= SEEK_FALLBACK_VISUAL_GUARD_MS) {
      // Keep UI at the requested position while backend catches up.
      displayTime = seekFallbackVisualTarget.seconds;
    } else {
      seekFallbackVisualTarget = null;
    }
  }
  const dur = duration > 0 ? duration : track.duration;
  if (dur <= 0) return;
  const progress = displayTime / dur;
  if (!progressUiDisabled) {
    const nowLive = Date.now();
    const live = getPlaybackProgressSnapshot();
    const liveTimeDelta = Math.abs(live.currentTime - displayTime);
    if (
      nowLive - lastLiveProgressEmitAt >= LIVE_PROGRESS_EMIT_MIN_MS ||
      liveTimeDelta >= LIVE_PROGRESS_EMIT_MIN_DELTA_SEC ||
      seekFallbackVisualTarget != null
    ) {
      emitPlaybackProgress({
        currentTime: displayTime,
        progress,
        buffered: 0,
      });
      lastLiveProgressEmitAt = nowLive;
    }
  }
  // Heartbeat: push current position to the server every 15 s while playing so
  // cross-device resume works even on a hard close — pause() and the close
  // handler flush on top of this for clean shutdowns.
  if (store.isPlaying && !store.currentRadio) {
    const now = Date.now();
    if (now - lastQueueHeartbeatAt >= 15_000) {
      void flushQueueSyncToServer(store.queue, track, displayTime);
    }
  }

  // Scrobble at 50%: Last.fm + Navidrome (updates play_date / recently played)
  if (progress >= 0.5 && !store.scrobbled) {
    usePlayerStore.setState({ scrobbled: true });
    scrobbleSong(track.id, Date.now());
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
    seekFallbackVisualTarget != null ||
    nowCommit - lastStoreProgressCommitAt >= STORE_PROGRESS_COMMIT_MIN_MS ||
    commitDelta >= STORE_PROGRESS_COMMIT_MIN_DELTA_SEC;
  if (shouldCommitStore) {
    usePlayerStore.setState({ currentTime: displayTime, progress, buffered: 0 });
    lastStoreProgressCommitAt = nowCommit;
  }

  // Pre-buffer / pre-chain next track based on preload mode and crossfade.
  const {
    gaplessEnabled,
    preloadMode,
    preloadCustomSeconds,
    hotCacheEnabled,
    crossfadeEnabled,
    crossfadeSecs,
  } = useAuthStore.getState();
  const remaining = dur - current_time;

  // Gapless chain: always triggers at 30s regardless of preloadMode.
  const shouldChainGapless = gaplessEnabled && remaining < 30 && remaining > 0;
  // Byte pre-download: skip when Hot Cache is active (it already handles buffering).
  // Even with preload mode OFF, crossfade needs the next track bytes ready before
  // we enter the fade window to avoid a hard gap after track boundary.
  const shouldBytePreloadFromMode = preloadMode !== 'off' && (
    preloadMode === 'early'
      ? current_time >= 5
      : preloadMode === 'custom'
        ? remaining < preloadCustomSeconds && remaining > 0
        : remaining < 30 && remaining > 0 // balanced (default)
  );
  const crossfadeWindowSecs = Math.max(8, Math.min(30, crossfadeSecs + 6));
  const shouldBytePreloadForCrossfade =
    !gaplessEnabled && crossfadeEnabled && remaining < crossfadeWindowSecs && remaining > 0;
  const shouldBytePreload = !hotCacheEnabled && (
    shouldBytePreloadFromMode ||
    shouldBytePreloadForCrossfade
  );

  if (shouldChainGapless || shouldBytePreload || gaplessEnabled) {
    const { queue, queueIndex, repeatMode } = store;
    const nextIdx = queueIndex + 1;
    const nextTrack = repeatMode === 'one'
      ? track
      : (nextIdx < queue.length ? queue[nextIdx] : (repeatMode === 'all' ? queue[0] : null));
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

    const serverId = useAuthStore.getState().activeServerId ?? '';
    const nextUrl = resolvePlaybackUrl(nextTrack.id, serverId);

    // Byte pre-download — runs early so bytes are cached by chain time.
    if ((shouldBytePreload || shouldBytePreloadForGaplessBackup) && nextTrack.id !== bytePreloadingId) {
      bytePreloadingId = nextTrack.id;
      // Loudness cache only — do not call refreshWaveformForTrack(next): it writes global
      // waveformBins and would replace the current track's seekbar while still playing it.
      void refreshLoudnessForTrack(nextTrack.id, { syncPlayingEngine: false });
      if (import.meta.env.DEV) {
        console.info('[psysonic][preload-request]', {
          nextTrackId: nextTrack.id,
          nextUrl,
          shouldBytePreload,
          shouldBytePreloadForGaplessBackup,
          remaining,
          gaplessEnabled,
        });
      }
      invoke('audio_preload', {
        url: nextUrl,
        durationHint: nextTrack.duration,
        analysisTrackId: nextTrack.id,
      }).catch(() => {});
    }

    // Gapless chain — decode + chain into Sink 30s before track boundary.
    if (shouldChainGapless && nextTrack.id !== gaplessPreloadingId) {
      gaplessPreloadingId = nextTrack.id;
      // Ensure loudness gain is already cached for the chained request payload.
      void refreshLoudnessForTrack(nextTrack.id, { syncPlayingEngine: false });
      const authState = useAuthStore.getState();
      // Auto-mode neighbours for the *next* track: current track on its left,
      // queue[nextIdx+1] on its right.
      const nextNeighbour = nextIdx + 1 < queue.length
        ? queue[nextIdx + 1]
        : (repeatMode === 'all' && queue.length > 0 ? queue[0] : null);
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
      }).catch(() => {});
    }
  }
}

function handleAudioEnded() {
  // If a gapless switch happened recently, this ended event is stale — the
  // progress task fired it for the OLD source before seeing the chained one.
  if (Date.now() - lastGaplessSwitchTime < 600) {
    return;
  }

  // Radio stream disconnected — just stop; don't advance queue.
  if (usePlayerStore.getState().currentRadio) {
    isAudioPaused = false;
    usePlayerStore.setState({ isPlaying: false, currentRadio: null, progress: 0, currentTime: 0 });
    return;
  }

  const { repeatMode, currentTrack, queue } = usePlayerStore.getState();
  isAudioPaused = false;
  usePlayerStore.setState({
    isPlaying: false,
    progress: 0,
    currentTime: 0,
    buffered: 0,
  });
  setTimeout(() => {
    void (async () => {
      if (repeatMode === 'one' && currentTrack) {
        const authState = useAuthStore.getState();
        const repeatPromoteSid = authState.activeServerId;
        if (authState.hotCacheEnabled && repeatPromoteSid) {
          // Same-track repeat never hit `playTrack`'s prev→promote path; flush
          // Rust `stream_completed_cache` to disk so `resolvePlaybackUrl` uses local.
          await promoteCompletedStreamToHotCache(
            currentTrack,
            repeatPromoteSid,
            authState.hotCacheDownloadDir || null,
          );
        }
        usePlayerStore.getState().playTrack(currentTrack, queue, false);
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
function handleAudioTrackSwitched(duration: number) {
  lastGaplessSwitchTime = Date.now();
  gaplessPreloadingId = null; bytePreloadingId = null; // allow preloading for the track after this one
  isAudioPaused = false;

  const store = usePlayerStore.getState();
  if (store.currentTrack?.id) {
    useAuthStore.getState().clearSkipStarManualCountForTrack(store.currentTrack.id);
  }
  const { queue, queueIndex, repeatMode } = store;
  const nextIdx = queueIndex + 1;
  let nextTrack: Track | null = null;
  let newIndex = queueIndex;

  if (repeatMode === 'one' && store.currentTrack) {
    nextTrack = store.currentTrack;
    // queueIndex stays the same
  } else if (nextIdx < queue.length) {
    nextTrack = queue[nextIdx];
    newIndex = nextIdx;
  } else if (repeatMode === 'all' && queue.length > 0) {
    nextTrack = queue[0];
    newIndex = 0;
  }

  if (!nextTrack) return;

  const switchServerId = useAuthStore.getState().activeServerId ?? '';
  const switchResolvedUrl = resolvePlaybackUrl(nextTrack.id, switchServerId);
  const switchPlaybackSource = playbackSourceHintForResolvedUrl(nextTrack.id, switchServerId, switchResolvedUrl);

  usePlayerStore.setState({
    currentTrack: nextTrack,
    waveformBins: null,
    ...deriveNormalizationSnapshot(nextTrack, queue, newIndex),
    normalizationDbgSource: 'track-switched',
    normalizationDbgTrackId: nextTrack.id,
    queueIndex: newIndex,
    isPlaying: true,
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
  if (nowPlayingEnabled) reportNowPlaying(nextTrack.id);
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
  syncQueueToServer(queue, nextTrack, 0);
  touchHotCacheOnPlayback(nextTrack.id, useAuthStore.getState().activeServerId ?? '');
}

function handleAudioError(message: string) {
  console.error('[psysonic] Audio error from backend:', message);
  isAudioPaused = false;

  const detail = message.length > 80 ? message.slice(0, 80) + '…' : message;
  showToast(`Couldn't play track — skipping. ${detail}`, 8000, 'error');

  const gen = playGeneration;
  usePlayerStore.setState({ isPlaying: false });
  setTimeout(() => {
    if (playGeneration !== gen) return;
    usePlayerStore.getState().next(false);
  }, 1500);
}

/**
 * Set up Tauri event listeners for the Rust audio engine.
 * Returns a cleanup function — pass it to useEffect's return value so that
 * React StrictMode (which double-invokes effects in dev) tears down the first
 * set of listeners before creating the second, avoiding duplicate handlers.
 */
export function initAudioListeners(): () => void {
  // Dev-only: warn when audio:progress events arrive faster than 10/s.
  // This would indicate the Rust emit interval was accidentally lowered.
  let _devEventCount = 0;
  let _devWindowStart = 0;

  const pending = [
    listen<number>('audio:playing', ({ payload }) => handleAudioPlaying(payload)),
    listen<{ current_time: number; duration: number }>('audio:progress', ({ payload }) => {
      if (import.meta.env.DEV) {
        _devEventCount++;
        const now = Date.now();
        if (_devWindowStart === 0) _devWindowStart = now;
        if (now - _devWindowStart >= 1000) {
          if (_devEventCount > 10) {
            console.warn(`[psysonic] audio:progress: ${_devEventCount} events/s (threshold: 10) — check Rust emit interval`);
          }
          _devEventCount = 0;
          _devWindowStart = now;
        }
      }
      handleAudioProgress(payload.current_time, payload.duration);
    }),
    listen<void>('audio:ended', () => handleAudioEnded()),
    listen<string>('audio:error', ({ payload }) => handleAudioError(payload)),
    listen<number>('audio:track_switched', ({ payload }) => handleAudioTrackSwitched(payload)),
    listen<{ trackId?: string | null; gainDb: number; targetLufs: number; isPartial: boolean }>('analysis:loudness-partial', ({ payload }) => {
      const current = usePlayerStore.getState().currentTrack;
      if (!current || !payload) return;
      const payloadTrackId = normalizeAnalysisTrackId(payload.trackId);
      if (payloadTrackId && payloadTrackId !== current.id) return;
      if (!Number.isFinite(payload.gainDb)) return;
      if (stableLoudnessGainByTrackId[current.id]) return;
      // Skip when the cached gain is already within ~0.05 dB of the new payload —
      // float jitter from the partial-loudness heuristic would otherwise re-trigger
      // updateReplayGainForCurrentTrack → audio_update_replay_gain → backend echo
      // every PARTIAL_LOUDNESS_EMIT_INTERVAL_MS even when nothing audibly changed.
      const existing = cachedLoudnessGainByTrackId[current.id];
      if (Number.isFinite(existing) && Math.abs(existing - payload.gainDb) < 0.05) return;
      cachedLoudnessGainByTrackId[current.id] = payload.gainDb;
      emitNormalizationDebug('partial-loudness:apply', {
        trackId: current.id,
        gainDb: payload.gainDb,
        targetLufs: payload.targetLufs,
      });
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    }),
    listen<{ trackId: string; isPartial: boolean }>('analysis:waveform-updated', ({ payload }) => {
      if (!payload?.trackId) return;
      const payloadTrackId = normalizeAnalysisTrackId(payload.trackId);
      if (!payloadTrackId) return;
      const currentRaw = usePlayerStore.getState().currentTrack?.id;
      const currentId = currentRaw ? normalizeAnalysisTrackId(currentRaw) : null;
      if (currentId && payloadTrackId === currentId) {
        bumpWaveformRefreshGen(currentRaw!);
        void refreshWaveformForTrack(currentRaw!);
        void refreshLoudnessForTrack(currentId);
        emitNormalizationDebug('backfill:applied', { trackId: currentId });
        return;
      }
      // Backfill finished for another id (e.g. next in queue): refresh loudness cache only
      // so `cachedLoudnessGainByTrackId` is ready before `audio_play` / gapless chain.
      void refreshLoudnessForTrack(payloadTrackId, { syncPlayingEngine: false });
      emitNormalizationDebug('backfill:applied', { trackId: payloadTrackId });
    }),
    listen<NormalizationStatePayload>('audio:normalization-state', ({ payload }) => {
      if (!payload) return;
      const engine =
        payload.engine === 'loudness' || payload.engine === 'replaygain'
          ? payload.engine
          : 'off';
      const nowDb = Number.isFinite(payload.currentGainDb as number) ? (payload.currentGainDb as number) : null;
      const targetLufs = Number.isFinite(payload.targetLufs) ? payload.targetLufs : null;
      const prev = usePlayerStore.getState();
      // Avoid UI flicker from noisy duplicate emits and transient nulls.
      if (
        engine === prev.normalizationEngineLive
        && normalizationAlmostEqual(nowDb, prev.normalizationNowDb)
        && normalizationAlmostEqual(targetLufs, prev.normalizationTargetLufs, 0.02)
      ) {
        return;
      }
      if (engine === 'loudness' && nowDb == null && prev.normalizationNowDb != null) {
        return;
      }
      const nowMs = Date.now();
      const isFirstNumericGain =
        engine === 'loudness'
        && nowDb != null
        && prev.normalizationNowDb == null;
      if (
        !isFirstNumericGain
        && nowMs - lastNormalizationUiUpdateAtMs < 120
        && engine === prev.normalizationEngineLive
      ) {
        return;
      }
      lastNormalizationUiUpdateAtMs = nowMs;
      emitNormalizationDebug('event:audio:normalization-state', {
        trackId: usePlayerStore.getState().currentTrack?.id ?? null,
        payload,
      });
      usePlayerStore.setState({
        normalizationEngineLive: engine,
        normalizationNowDb: nowDb,
        normalizationTargetLufs: targetLufs,
        normalizationDbgSource: 'event:audio:normalization-state',
        normalizationDbgLastEventAt: Date.now(),
      });
    }),
    listen<string>('audio:preload-ready', ({ payload }) => {
      const tid = streamUrlTrackId(payload);
      if (import.meta.env.DEV) {
        console.info('[psysonic][preload-ready]', {
          payload,
          parsedTrackId: tid,
          prevEnginePreloadedTrackId: usePlayerStore.getState().enginePreloadedTrackId,
        });
      }
      if (tid) usePlayerStore.setState({ enginePreloadedTrackId: tid });
      else if (import.meta.env.DEV) {
        console.warn('[psysonic][preload-ready] could not parse track id from payload URL');
      }
    }),
  ];

  // Sync Last.fm loved tracks cache on startup.
  usePlayerStore.getState().syncLastfmLovedTracks();

  // Initial sync of audio settings to Rust engine on startup.
  const { crossfadeEnabled, crossfadeSecs, gaplessEnabled, audioOutputDevice } = useAuthStore.getState();
  invoke('audio_set_crossfade', { enabled: crossfadeEnabled, secs: crossfadeSecs }).catch(() => {});
  invoke('audio_set_gapless', { enabled: gaplessEnabled }).catch(() => {});
  const normCfg = useAuthStore.getState();
  usePlayerStore.setState({
    normalizationEngineLive: normCfg.normalizationEngine,
    normalizationTargetLufs: normCfg.normalizationEngine === 'loudness' ? normCfg.loudnessTargetLufs : null,
    normalizationNowDb: null,
    normalizationDbgSource: 'init:set-normalization',
  });
  emitNormalizationDebug('init:set-normalization', {
    engine: normCfg.normalizationEngine,
    targetLufs: normCfg.loudnessTargetLufs,
    currentTrackId: usePlayerStore.getState().currentTrack?.id ?? null,
  });
  invokeAudioSetNormalizationDeduped({
    engine: normCfg.normalizationEngine,
    targetLufs: normCfg.loudnessTargetLufs,
    preAnalysisAttenuationDb: effectiveLoudnessPreAnalysisAttenuationDb(
      normCfg.loudnessPreAnalysisAttenuationDb,
      normCfg.loudnessTargetLufs,
    ),
  });
  const bootTrackId = usePlayerStore.getState().currentTrack?.id;
  if (bootTrackId) {
    void refreshWaveformForTrack(bootTrackId);
  }
  if (normCfg.normalizationEngine === 'loudness') {
    const currentId = usePlayerStore.getState().currentTrack?.id;
    if (currentId) {
      void refreshLoudnessForTrack(currentId).finally(() => {
        usePlayerStore.getState().updateReplayGainForCurrentTrack();
      });
    }
  }
  if (audioOutputDevice) {
    invoke('audio_set_device', { deviceName: audioOutputDevice }).catch(() => {});
  }

  // Keep audio settings in sync whenever auth store changes.
  let prevNormEngine = normCfg.normalizationEngine;
  let prevNormTarget = normCfg.loudnessTargetLufs;
  let prevPreAnalysis = normCfg.loudnessPreAnalysisAttenuationDb;
  const unsubAuth = useAuthStore.subscribe((state) => {
    invoke('audio_set_crossfade', {
      enabled: state.crossfadeEnabled,
      secs: state.crossfadeSecs,
    }).catch(() => {});
    invoke('audio_set_gapless', { enabled: state.gaplessEnabled }).catch(() => {});
    const normChanged =
      state.normalizationEngine !== prevNormEngine
      || state.loudnessTargetLufs !== prevNormTarget
      || state.loudnessPreAnalysisAttenuationDb !== prevPreAnalysis;
    if (!normChanged) return;
    const onlyPreAnalysisChanged =
      state.normalizationEngine === prevNormEngine
      && state.loudnessTargetLufs === prevNormTarget
      && state.loudnessPreAnalysisAttenuationDb !== prevPreAnalysis;
    const targetLufsChanged =
      state.normalizationEngine === 'loudness'
      && state.loudnessTargetLufs !== prevNormTarget;
    prevNormEngine = state.normalizationEngine;
    prevNormTarget = state.loudnessTargetLufs;
    prevPreAnalysis = state.loudnessPreAnalysisAttenuationDb;
    usePlayerStore.setState({
      normalizationEngineLive: state.normalizationEngine,
      normalizationTargetLufs: state.normalizationEngine === 'loudness' ? state.loudnessTargetLufs : null,
      normalizationNowDb: state.normalizationEngine === 'loudness'
        ? usePlayerStore.getState().normalizationNowDb
        : null,
      normalizationDbgSource: 'auth:normalization-changed',
    });
    emitNormalizationDebug('auth:normalization-changed', {
      engine: state.normalizationEngine,
      targetLufs: state.loudnessTargetLufs,
      currentTrackId: usePlayerStore.getState().currentTrack?.id ?? null,
    });
    invokeAudioSetNormalizationDeduped({
      engine: state.normalizationEngine,
      targetLufs: state.loudnessTargetLufs,
      preAnalysisAttenuationDb: effectiveLoudnessPreAnalysisAttenuationDb(
        state.loudnessPreAnalysisAttenuationDb,
        state.loudnessTargetLufs,
      ),
    });
    if (state.normalizationEngine === 'loudness') {
      const currentId = usePlayerStore.getState().currentTrack?.id;
      if (onlyPreAnalysisChanged) {
        usePlayerStore.getState().updateReplayGainForCurrentTrack();
      } else if (currentId) {
        if (targetLufsChanged) {
          clearLoudnessCacheStateForTrackId(currentId);
        }
        void refreshLoudnessForTrack(currentId).finally(() => {
          usePlayerStore.getState().updateReplayGainForCurrentTrack();
        });
      }
    } else {
      usePlayerStore.getState().updateReplayGainForCurrentTrack();
    }
  });
  const unsubAnalysisSync = onAnalysisStorageChanged(detail => {
    const currentId = usePlayerStore.getState().currentTrack?.id;
    if (!currentId) return;
    if (detail.trackId && detail.trackId !== currentId) return;
    bumpWaveformRefreshGen(currentId);
    void refreshWaveformForTrack(currentId);
    void refreshLoudnessForTrack(currentId);
  });

  // ── MPRIS / OS media controls sync ───────────────────────────────────────
  // Whenever the current track or playback state changes, push updates to the
  // Rust souvlaki MediaControls so the OS media overlay stays accurate.
  let prevTrackId: string | null = null;
  let prevRadioId: string | null = null;
  let prevIsPlaying: boolean | null = null;
  let lastMprisPositionUpdate = 0;

  const unsubMpris = usePlayerStore.subscribe((state) => {
    const { currentTrack, currentRadio, isPlaying } = state;

    // Update metadata when track changes
    if (currentTrack && currentTrack.id !== prevTrackId) {
      prevTrackId = currentTrack.id;
      prevRadioId = null;
      const coverUrl = currentTrack.coverArt
        ? buildCoverArtUrl(currentTrack.coverArt, 512)
        : undefined;
      invoke('mpris_set_metadata', {
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album,
        coverUrl,
        durationSecs: currentTrack.duration,
      }).catch(() => {});
    }

    // Update metadata when a radio station starts (initial push — station name as title).
    // ICY StreamTitle updates are forwarded by the radio:metadata listener below.
    if (currentRadio && currentRadio.id !== prevRadioId) {
      prevRadioId = currentRadio.id;
      prevTrackId = null;
      invoke('mpris_set_metadata', {
        title: currentRadio.name,
        artist: null,
        album: null,
        coverUrl: null,
        durationSecs: null,
      }).catch(() => {});
    }

    // Update playback state on play/pause change (use live snapshot — persisted
    // store currentTime is intentionally coarse between commits).
    const playbackChanged = isPlaying !== prevIsPlaying;
    if (playbackChanged) {
      prevIsPlaying = isPlaying;
      lastMprisPositionUpdate = Date.now();
      const pos = getPlaybackProgressSnapshot().currentTime;
      invoke('mpris_set_playback', {
        playing: isPlaying,
        positionSecs: pos > 0 ? pos : null,
      }).catch(() => {});
      invoke('update_taskbar_icon', { isPlaying }).catch(() => {});
      return;
    }
  });
  const unsubMprisProgress = subscribePlaybackProgress(({ currentTime }) => {
    const { currentRadio, isPlaying } = usePlayerStore.getState();
    if (currentRadio || !isPlaying) return;
    if (Date.now() - lastMprisPositionUpdate < 1500) return;
    lastMprisPositionUpdate = Date.now();
    invoke('mpris_set_playback', {
      playing: true,
      positionSecs: currentTime,
    }).catch(() => {});
  });

  // ── Radio ICY StreamTitle → MPRIS ─────────────────────────────────────────
  // The Rust download task emits "radio:metadata" with { title, is_ad } every
  // time an ICY metadata block changes (typically every 8–32 KB of audio).
  // Forward each update to mpris_set_metadata so the OS now-playing overlay
  // stays in sync while the stream is live.
  const radioMetaUnlisten = listen<{ title: string; is_ad: boolean }>('radio:metadata', ({ payload }) => {
    const { currentRadio } = usePlayerStore.getState();
    if (!currentRadio) return; // guard: only forward during active radio session
    if (payload.is_ad) return; // skip CDN-injected ad metadata

    // Parse "Artist - Title" convention used by most ICY streams.
    const sep = payload.title.indexOf(' - ');
    const artist = sep !== -1 ? payload.title.slice(0, sep).trim() : null;
    const title  = sep !== -1 ? payload.title.slice(sep + 3).trim() : payload.title;

    invoke('mpris_set_metadata', {
      title: title || currentRadio.name,
      artist: artist || currentRadio.name,
      album: null,
      coverUrl: null,
      durationSecs: null,
    }).catch(() => {});
  });

  // ── Discord Rich Presence sync ────────────────────────────────────────────
  // Updates on track change or play/pause toggle. No per-tick updates needed —
  // Discord auto-counts up the elapsed timer from the start_timestamp we set.
  let discordPrevTrackId: string | null = null;
  let discordPrevIsPlaying: boolean | null = null;
  let discordPrevFetchCovers: boolean | null = null;
  let discordPrevTemplateDetails: string | null = null;
  let discordPrevTemplateState: string | null = null;
  let discordPrevTemplateLargeText: string | null = null;
  let discordPrevCoverSource: string | null = null;
  const discordServerCoverCache = new Map<string, string | null>();

  function syncDiscord() {
    const { currentTrack, isPlaying } = usePlayerStore.getState();
    const currentTime = getPlaybackProgressSnapshot().currentTime;
    const {
      discordRichPresence,
      discordCoverSource,
      discordTemplateDetails,
      discordTemplateState,
      discordTemplateLargeText,
    } = useAuthStore.getState();

    if (!discordRichPresence || !currentTrack) {
      if (discordPrevTrackId !== null) {
        discordPrevTrackId = null;
        discordPrevIsPlaying = null;
        discordPrevFetchCovers = null;
        discordPrevCoverSource = null;
        discordPrevTemplateDetails = null;
        discordPrevTemplateState = null;
        discordPrevTemplateLargeText = null;
        invoke('discord_clear_presence').catch(() => {});
      }
      return;
    }

    const trackChanged = currentTrack.id !== discordPrevTrackId;
    const playingChanged = isPlaying !== discordPrevIsPlaying;
    const coverSourceChanged = discordCoverSource !== discordPrevCoverSource;
    const detailsTemplateChanged = discordTemplateDetails !== discordPrevTemplateDetails;
    const stateTemplateChanged = discordTemplateState !== discordPrevTemplateState;
    const largeTextTemplateChanged = discordTemplateLargeText !== discordPrevTemplateLargeText;
    if (!trackChanged && !playingChanged && !coverSourceChanged && !detailsTemplateChanged && !stateTemplateChanged && !largeTextTemplateChanged) return;

    discordPrevTrackId = currentTrack.id;
    discordPrevIsPlaying = isPlaying;
    discordPrevFetchCovers = discordCoverSource === 'apple';
    discordPrevCoverSource = discordCoverSource;
    discordPrevTemplateDetails = discordTemplateDetails;
    discordPrevTemplateState = discordTemplateState;
    discordPrevTemplateLargeText = discordTemplateLargeText;

    const sendPresence = (coverArtUrl: string | null) => {
      invoke('discord_update_presence', {
        title: currentTrack.title,
        artist: currentTrack.artist ?? 'Unknown Artist',
        album: currentTrack.album ?? null,
        isPlaying,
        elapsedSecs: isPlaying ? currentTime : null,
        coverArtUrl,
        fetchItunesCovers: discordCoverSource === 'apple',
        detailsTemplate: discordTemplateDetails,
        stateTemplate: discordTemplateState,
        largeTextTemplate: discordTemplateLargeText,
      }).catch(() => {});
    };

    if (discordCoverSource === 'server' && currentTrack.albumId) {
      const cached = discordServerCoverCache.get(currentTrack.albumId);
      if (cached !== undefined) {
        sendPresence(cached);
      } else {
        getAlbumInfo2(currentTrack.albumId).then(info => {
          const url = info?.largeImageUrl || info?.mediumImageUrl || info?.smallImageUrl || null;
          discordServerCoverCache.set(currentTrack.albumId, url);
          sendPresence(url);
        });
      }
    } else {
      sendPresence(null);
    }
  }

  const unsubDiscordPlayer = usePlayerStore.subscribe(syncDiscord);
  const unsubDiscordAuth = useAuthStore.subscribe(syncDiscord);

  return () => {
    unsubAuth();
    unsubAnalysisSync();
    unsubMpris();
    unsubMprisProgress();
    unsubDiscordPlayer();
    unsubDiscordAuth();
    pending.forEach(p => p.then(unlisten => unlisten()));
    radioMetaUnlisten.then(unlisten => unlisten());
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => {
      function applyQueueHistorySnapshot(snap: QueueUndoSnapshot, prior: PlayerState): boolean {
        if (prior.currentRadio) {
          clearRadioReconnectTimer();
          radioStopping = true;
          radioAudio.pause();
          radioAudio.src = '';
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

        gaplessPreloadingId = null;
        bytePreloadingId = null;

        let gen = playGeneration;
        const resyncEngine = Boolean(nextTrack) && !keepPlaybackFromPrior;
        if (resyncEngine || !nextTrack) {
          gen = ++playGeneration;
          if (resyncEngine) {
            isAudioPaused = false;
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
          isAudioPaused = false;
          syncQueueToServer(nextQueue, null, 0);
          if (typeof snap.queueListScrollTop === 'number' && Number.isFinite(snap.queueListScrollTop)) {
            pendingQueueListScrollTop = Math.max(0, snap.queueListScrollTop);
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
          pendingQueueListScrollTop = Math.max(0, snap.queueListScrollTop);
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

      openContextMenu: (x, y, item, type, queueIndex, playlistId, playlistSongIndex) => set({
        contextMenu: { isOpen: true, x, y, item, type, queueIndex, playlistId, playlistSongIndex },
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
          clearRadioReconnectTimer();
          radioStopping = true;
          radioAudio.pause();
          radioAudio.src = '';
        } else {
          invoke('audio_stop').catch(console.error);
        }
        isAudioPaused = false;
        clearSeekFallbackRetry();
        if (seekDebounce) { clearTimeout(seekDebounce); seekDebounce = null; } clearSeekTarget();
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
        ++playGeneration;
        clearAllPlaybackScheduleTimers();
        set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });
        isAudioPaused = false;
        clearRadioReconnectTimer();
        radioReconnectCount = 0;
        gaplessPreloadingId = null; bytePreloadingId = null;
        clearSeekFallbackRetry();
        if (seekDebounce) { clearTimeout(seekDebounce); seekDebounce = null; } clearSeekTarget();
        // Stop Rust engine in case a regular track was playing.
        invoke('audio_stop').catch(() => {});
        // Resolve PLS/M3U playlist URLs to the actual stream URL before handing
        // to HTML5 <audio> — the browser cannot play playlist files directly.
        const streamUrl = await invoke<string>('resolve_stream_url', { url: station.streamUrl })
          .catch(() => station.streamUrl);
        // Play via HTML5 audio — browser handles reconnects, codec negotiation, buffering.
        radioAudio.src = streamUrl;
        const { replayGainFallbackDb } = useAuthStore.getState();
        const fallbackFactor = replayGainFallbackDb !== 0 ? Math.pow(10, replayGainFallbackDb / 20) : 1;
        radioAudio.volume = Math.min(1, volume * fallbackFactor);
        radioAudio.play().catch((err: unknown) => {
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
      playTrack: (track, queue, manual = true, _orbitConfirmed = false) => {
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

        // Ghost-command guard: if a gapless switch happened within 500 ms,
        // this playTrack call is likely a stale IPC echo — suppress it.
        if (Date.now() - lastGaplessSwitchTime < 500) {
          return;
        }

        clearAllPlaybackScheduleTimers();
        set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null, scheduledResumeAtMs: null, scheduledResumeStartMs: null });

        const gen = ++playGeneration;
        isAudioPaused = false;
        gaplessPreloadingId = null; bytePreloadingId = null; // new track — allow fresh preload for next
        if (seekDebounce) { clearTimeout(seekDebounce); seekDebounce = null; } clearSeekTarget();
        clearSeekFallbackRetry();
        seekFallbackRestartAt = 0;

        // If a radio stream is active, stop it before the new track starts so
        // the PlayerBar clears radio mode immediately and the stream is released.
        if (get().currentRadio) {
          clearRadioReconnectTimer();
          radioStopping = true;
          radioAudio.pause();
          radioAudio.src = '';
        }

        const state = get();
        const prevTrack = state.currentTrack;
        seekFallbackTrackId = prevTrack?.id === track.id ? seekFallbackTrackId : null;
        if (seekFallbackVisualTarget?.trackId !== track.id) {
          seekFallbackVisualTarget = null;
        }
        const newQueue = queue ?? state.queue;
        const idx = newQueue.findIndex(t => sameQueueTrackId(t.id, track.id));
        if (manual) {
          pushQueueUndoFromGetter(get);
        }
        const pendingVisualTarget = seekFallbackVisualTarget?.trackId === track.id
          ? seekFallbackVisualTarget.seconds
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
              if (playGeneration !== gen) return;
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
                    if (playGeneration !== gen) return;
                    setSeekTarget(seekTo);
                    if (seekFallbackVisualTarget?.trackId === track.id) {
                      seekFallbackVisualTarget = null;
                    }
                  })
                  .catch(() => {
                    if (seekFallbackVisualTarget?.trackId === track.id) {
                      seekFallbackVisualTarget = null;
                    }
                  });
              }
            })
            .catch((err: unknown) => {
              if (playGeneration !== gen) return;
              setDeferHotCachePrefetch(false);
              console.error('[psysonic] audio_play failed:', err);
              set({ isPlaying: false });
              setTimeout(() => {
                if (playGeneration !== gen) return;
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
              if (playGeneration !== gen) return;
              runPlayTrackBody();
            })
            .catch((err: unknown) => {
              if (playGeneration !== gen) return;
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
          radioAudio.pause();
        } else {
          invoke('audio_pause').catch(console.error);
          isAudioPaused = true;
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
        isAudioPaused = false;
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
                if (isAudioPaused) {
                  invoke('audio_resume').catch(console.error);
                  isAudioPaused = false;
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
          radioAudio.play().catch(console.error);
          set({ isPlaying: true });
          return;
        }
        const { currentTrack, queue, queueIndex, currentTime } = get();
        if (!currentTrack) return;
        const coldPrev = queueIndex > 0 ? queue[queueIndex - 1] : null;
        const coldNext = queueIndex + 1 < queue.length ? queue[queueIndex + 1] : null;

        if (isAudioPaused) {
          // Rust engine has audio loaded but paused — just resume it.
          invoke('audio_resume').catch(console.error);
          isAudioPaused = false;
          set({ isPlaying: true });
          touchHotCacheOnPlayback(currentTrack.id, useAuthStore.getState().activeServerId ?? '');
        } else {
          // Engine has no loaded paused stream (app relaunch, or track ended and user
          // hits play — `isAudioPaused` is false after `audio:ended`). Flush any
          // `stream_completed_cache` from the prior play to hot disk before resolving URL.
          const gen = ++playGeneration;
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
            if (playGeneration !== gen) return;

            // Fetch fresh track data from server to get replay gain metadata
            getSong(currentTrack.id).then(freshSong => {
            if (playGeneration !== gen) return;
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
              if (playGeneration === gen && currentTime > 1) {
                invoke('audio_seek', { seconds: currentTime }).catch(console.error);
              }
            }).catch((err: unknown) => {
              if (playGeneration !== gen) return;
              setDeferHotCachePrefetch(false);
              console.error('[psysonic] audio_play (cold resume) failed:', err);
              set({ isPlaying: false });
            });
            syncQueueToServer(queue, trackToPlay, currentTime);
          }).catch(() => {
             if (playGeneration !== gen) return;
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
               if (playGeneration !== gen) return;
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
        clearScheduledPauseTimers();
        const delayMs = Math.max(500, Math.round(Number(seconds) * 1000));
        const startedAt = Date.now();
        const at = startedAt + delayMs;
        set({ scheduledPauseAtMs: at, scheduledPauseStartMs: startedAt });
        scheduledPauseTimer = window.setTimeout(() => {
          scheduledPauseTimer = null;
          set({ scheduledPauseAtMs: null, scheduledPauseStartMs: null });
          get().pause();
        }, delayMs) as unknown as number;
      },

      scheduleResumeIn: (seconds) => {
        const s = get();
        if (s.isPlaying) return;
        if (!s.currentTrack && !s.currentRadio) return;
        clearScheduledResumeTimers();
        const delayMs = Math.max(500, Math.round(Number(seconds) * 1000));
        const startedAt = Date.now();
        const at = startedAt + delayMs;
        set({ scheduledResumeAtMs: at, scheduledResumeStartMs: startedAt });
        scheduledResumeTimer = window.setTimeout(() => {
          scheduledResumeTimer = null;
          set({ scheduledResumeAtMs: null, scheduledResumeStartMs: null });
          get().resume();
        }, delayMs) as unknown as number;
      },

      togglePlay: () => {
        if (togglePlayLock) return;
        togglePlayLock = true;
        setTimeout(() => { togglePlayLock = false; }, 300);
        const { isPlaying } = get();
        isPlaying ? get().pause() : get().resume();
      },

      // ── next / previous ──────────────────────────────────────────────────────
      next: (manual = true) => {
        const { queue, queueIndex, repeatMode, currentTrack } = get();
        applySkipStarOnManualNext(currentTrack, manual);
        const nextIdx = queueIndex + 1;
        if (nextIdx < queue.length) {
          get().playTrack(queue[nextIdx], queue, manual);
          // Proactively top up auto-added tracks when ≤ 2 remain ahead,
          // so the queue never runs dry without a visible loading pause.
          const { infiniteQueueEnabled } = useAuthStore.getState();
          if (infiniteQueueEnabled && repeatMode === 'off' && !infiniteQueueFetching) {
            const remainingAuto = queue.slice(nextIdx + 1).filter(t => t.autoAdded).length;
            if (remainingAuto <= 2) {
              infiniteQueueFetching = true;
              const existingIds = new Set(get().queue.map(t => t.id));
              buildInfiniteQueueCandidates(currentTrack, existingIds, 5).then(newTracks => {
                if (newTracks.length > 0) {
                  set(state => ({ queue: [...state.queue, ...newTracks] }));
                }
              }).catch(() => {}).finally(() => { infiniteQueueFetching = false; });
            }
          }
          // Proactively top up radio tracks when ≤ 2 remain — always, regardless
          // of infinite queue setting.
          const nextTrack = queue[nextIdx];
          if (nextTrack.radioAdded && !radioFetching) {
            const remainingRadio = queue.slice(nextIdx + 1).filter(t => t.radioAdded).length;
            if (remainingRadio <= 2) {
              const artistId = nextTrack.artistId ?? currentRadioArtistId ?? null;
              const artistName = nextTrack.artist;
              if (artistId) {
                radioFetching = true;
                Promise.all([getSimilarSongs2(artistId), getTopSongs(artistName)])
                  .then(([similar, top]) => {
                    const existingIds = new Set(get().queue.map(t => t.id));
                    const fresh: Track[] = [...top, ...similar]
                      .map(songToTrack)
                      .filter(t => !existingIds.has(t.id))
                      .slice(0, 10)
                      .map(t => ({ ...t, radioAdded: true as const }));
                    if (fresh.length > 0) {
                      // Trim played tracks from the front to keep the queue bounded.
                      // Without trimming the queue grows unboundedly, making every
                      // Zustand persist write larger and causing UI freezes over time.
                      // Keep the last HISTORY_KEEP played tracks so the user can still
                      // navigate backwards a few songs.
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
                  .finally(() => { radioFetching = false; });
              }
            }
          }
        } else if (repeatMode === 'all' && queue.length > 0) {
          get().playTrack(queue[0], queue, manual);
        } else {
          // Queue exhausted. Check radio first (independent of infinite queue setting),
          // then infinite queue, then stop.
          if (currentTrack?.radioAdded && !radioFetching) {
            const artistId = currentTrack.artistId ?? currentRadioArtistId ?? null;
            if (artistId) {
              radioFetching = true;
              Promise.all([getSimilarSongs2(artistId), getTopSongs(currentTrack.artist)])
                .then(([similar, top]) => {
                  radioFetching = false;
                  const existingIds = new Set(get().queue.map(t => t.id));
                  const fresh: Track[] = [...top, ...similar]
                    .map(songToTrack)
                    .filter(t => !existingIds.has(t.id))
                    .slice(0, 10)
                    .map(t => ({ ...t, radioAdded: true as const }));
                  if (fresh.length > 0) {
                    const currentQueue = get().queue;
                    const newQueue = [...currentQueue, ...fresh];
                    get().playTrack(fresh[0], newQueue, false);
                  } else {
                    invoke('audio_stop').catch(console.error);
                    isAudioPaused = false;
                    set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
                  }
                })
                .catch(() => {
                  radioFetching = false;
                  invoke('audio_stop').catch(console.error);
                  isAudioPaused = false;
                  set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
                });
              return;
            }
          }
          const { infiniteQueueEnabled } = useAuthStore.getState();
          if (infiniteQueueEnabled && repeatMode === 'off') {
            if (infiniteQueueFetching) return;
            infiniteQueueFetching = true;
            const existingIds = new Set(get().queue.map(t => t.id));
            buildInfiniteQueueCandidates(currentTrack, existingIds, 5).then(newTracks => {
              infiniteQueueFetching = false;
              if (newTracks.length === 0) {
                invoke('audio_stop').catch(console.error);
                isAudioPaused = false;
                set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
                return;
              }
              const currentQueue = get().queue;
              const newQueue = [...currentQueue, ...newTracks];
              get().playTrack(newTracks[0], newQueue, false);
            }).catch(() => {
              infiniteQueueFetching = false;
              invoke('audio_stop').catch(console.error);
              isAudioPaused = false;
              set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
            });
          } else {
            invoke('audio_stop').catch(console.error);
            isAudioPaused = false;
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
            seekFallbackVisualTarget = { trackId: currentTrack.id, seconds: 0, setAtMs: Date.now() };
            get().playTrack(currentTrack, queue, true);
            return;
          }
          invoke('audio_seek', { seconds: 0 }).catch(console.error);
          set({ progress: 0, currentTime: 0 });
          return;
        }
        const prevIdx = queueIndex - 1;
        if (prevIdx >= 0) get().playTrack(queue[prevIdx], queue);
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
        if (seekDebounce) clearTimeout(seekDebounce);
        seekDebounce = setTimeout(() => {
          seekDebounce = null;
          const s0 = get();
          if (!s0.currentTrack) return;
          const authSeek = useAuthStore.getState();
          const sidSeek = authSeek.activeServerId ?? '';
          if (shouldRebindPlaybackToHotCache(s0.currentTrack.id, sidSeek)) {
            seekFallbackVisualTarget = {
              trackId: s0.currentTrack.id,
              seconds: time,
              setAtMs: Date.now(),
            };
            clearSeekFallbackRetry();
            s0.playTrack(s0.currentTrack, s0.queue, true);
            return;
          }
          invoke('audio_seek', { seconds: time }).then(() => {
            // Arm stale-progress guard only after backend acknowledged seek.
            setSeekTarget(time);
            seekFallbackVisualTarget = null;
            clearSeekFallbackRetry();
          }).catch((err: unknown) => {
            // Release the progress-tick guard so the UI doesn't freeze
            // waiting for a target the engine will never reach.
            clearSeekTarget();
            const msg = String(err ?? '');
            if (!isRecoverableSeekError(msg)) {
              console.error(err);
              seekFallbackVisualTarget = null;
              clearSeekFallbackRetry();
              return;
            }
            // Streaming-start path can be temporarily non-seekable or busy.
            // Keep UI at target and retry seek for a short bounded window.
            const s = get();
            if (!s.currentTrack) return;
            const now = Date.now();
            const sameBurst =
              seekFallbackTrackId === s.currentTrack.id
              && now - seekFallbackRestartAt < 600;
            seekFallbackVisualTarget = {
              trackId: s.currentTrack.id,
              seconds: time,
              setAtMs: Date.now(),
            };
            // Keep stale progress ticks from snapping UI back to start while
            // recoverable seek retries are still in flight.
            setSeekTarget(time);
            if (msg.includes('not seekable') && !sameBurst) {
              seekFallbackTrackId = s.currentTrack.id;
              seekFallbackRestartAt = now;
              // Keep manual semantics (no crossfade) for seek recovery restarts.
              s.playTrack(s.currentTrack, s.queue, true);
            }
            scheduleSeekFallbackRetry(s.currentTrack.id, time);
          });
        }, 100);
      },

      // ── volume ───────────────────────────────────────────────────────────────
      setVolume: (v) => {
        const clamped = Math.max(0, Math.min(1, v));
        invoke('audio_set_volume', { volume: clamped }).catch(console.error);
        radioAudio.volume = clamped;
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
          prefetchLoudnessForEnqueuedTracks(tracks, newQueue, state.queueIndex);
          return { queue: newQueue };
        });
      },

      setRadioArtistId: (artistId) => { currentRadioArtistId = artistId; },

      enqueueRadio: (tracks, artistId) => {
        if (artistId) currentRadioArtistId = artistId;
        pushQueueUndoFromGetter(get);
        set(state => {
          // Drop all upcoming (not yet played) radio tracks — clicking "Start Radio"
          // again replaces the pending radio batch instead of stacking on top.
          const beforeAndCurrent = state.queue.slice(0, state.queueIndex + 1);
          const upcoming = state.queue.slice(state.queueIndex + 1).filter(t => !t.radioAdded);
          // Insert new radio tracks before any autoAdded tracks in the upcoming section.
          const firstAutoIdx = upcoming.findIndex(t => t.autoAdded);
          const merged = firstAutoIdx === -1
            ? [...upcoming, ...tracks]
            : [
                ...upcoming.slice(0, firstAutoIdx),
                ...tracks,
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
          prefetchLoudnessForEnqueuedTracks(tracks, newQueue, newQueueIndex);
          return { queue: newQueue, queueIndex: newQueueIndex };
        });
      },

      clearQueue: () => {
        invoke('audio_stop').catch(console.error);
        isAudioPaused = false;
        clearSeekFallbackRetry();
        if (seekDebounce) { clearTimeout(seekDebounce); seekDebounce = null; } clearSeekTarget();
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
        const snap = queueUndoStack.pop();
        if (!snap) return false;
        queueRedoStack.push(queueUndoSnapshotFromState(prior));
        while (queueRedoStack.length > QUEUE_UNDO_MAX) queueRedoStack.shift();
        return applyQueueHistorySnapshot(snap, prior);
      },

      redoLastQueueEdit: () => {
        const prior = get();
        const snap = queueRedoStack.pop();
        if (!snap) return false;
        queueUndoStack.push(queueUndoSnapshotFromState(prior));
        while (queueUndoStack.length > QUEUE_UNDO_MAX) queueUndoStack.shift();
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
          showToast('Recalculating loudness for this track…', 2000, 'info');
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
        const cachedLoud = cachedLoudnessGainByTrackId[currentTrack.id];
        const cachedLoudDb = Number.isFinite(cachedLoud) ? cachedLoud : null;
        const haveStableLoud = !!stableLoudnessGainByTrackId[currentTrack.id];
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
          loudnessGainDb: currentTrack ? (cachedLoudnessGainByTrackId[currentTrack.id] ?? null) : null,
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
  const label = w.__PSY_WINDOW_LABEL__;
  if (label === 'mini') return;
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
