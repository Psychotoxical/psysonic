import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { showToast } from '../utils/toast';
import { buildCoverArtUrl, buildStreamUrl, getPlayQueue, savePlayQueue, reportNowPlaying, scrobbleSong, SubsonicSong, getSong, getRandomSongs, getSimilarSongs2, getTopSongs, InternetRadioStation, setRating } from '../api/subsonic';
import { resolvePlaybackUrl, streamUrlTrackId, getPlaybackSourceKind, type PlaybackSourceKind } from '../utils/resolvePlaybackUrl';
import { setDeferHotCachePrefetch } from '../utils/hotCacheGate';
import { lastfmScrobble, lastfmUpdateNowPlaying, lastfmLoveTrack, lastfmUnloveTrack, lastfmGetTrackLoved, lastfmGetAllLovedTracks } from '../api/lastfm';
import { useAuthStore } from './authStore';
import { useOfflineStore } from './offlineStore';
import { useHotCacheStore } from './hotCacheStore';

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
  const artistId = seedTrack?.artistId?.trim() || null;
  const artistName = seedTrack?.artist?.trim() || null;

  const [similar, top] = await Promise.all([
    artistId ? getSimilarSongs2(artistId).catch(() => []) : Promise.resolve([]),
    artistName ? getTopSongs(artistName).catch(() => []) : Promise.resolve([]),
  ]);

  const seedId = seedTrack?.id ?? null;
  const mixCandidates = shuffleArray(
    [...top, ...similar]
      .map(songToTrack)
      .filter(t => t.id !== seedId && !existingIds.has(t.id)),
  )
    .slice(0, count)
    .map(t => ({ ...t, autoAdded: true as const }));

  if (mixCandidates.length > 0) return mixCandidates;

  const random = await getRandomSongs(count, seedTrack?.genre).catch(() => []);
  return random
    .map(songToTrack)
    .filter(t => t.id !== seedId && !existingIds.has(t.id))
    .slice(0, count)
    .map(t => ({ ...t, autoAdded: true as const }));
}

interface PlayerState {
  currentTrack: Track | null;
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
  playTrack: (track: Track, queue?: Track[], manual?: boolean) => void;
  /** Queue becomes `[track]` only; if already on this track, does not restart `audio_play`. */
  reseedQueueForInstantMix: (track: Track) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  togglePlay: () => void;
  next: (manual?: boolean) => void;
  previous: () => void;
  seek: (progress: number) => void;
  setVolume: (v: number) => void;
   updateReplayGainForCurrentTrack: () => void;
   setProgress: (t: number, duration: number) => void;
  enqueue: (tracks: Track[]) => void;
  enqueueAt: (tracks: Track[], insertIndex: number) => void;
  enqueueRadio: (tracks: Track[], artistId?: string) => void;
  setRadioArtistId: (artistId: string) => void;
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

// Debounce timer for seek slider drags.
let seekDebounce: ReturnType<typeof setTimeout> | null = null;
// Target time of the last seek — blocks stale Rust progress ticks until the
// engine has actually caught up to the new position.
let seekTarget: number | null = null;
let seekTargetSetAt = 0;
const SEEK_TARGET_GUARD_TIMEOUT_MS = 5000;
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
    useHotCacheStore.getState().setEntry(track.id, serverId, res.path, res.size || 0);
  } catch {
    // best-effort promotion; normal hot-cache prefetch remains fallback
  }
}

// Track ID that has already been sent to audio_chain_preload (gapless chain).
let gaplessPreloadingId: string | null = null;
// Track ID that has already been sent to audio_preload (byte pre-download).
let bytePreloadingId: string | null = null;

// ─── Server queue sync ─────────────────────────────────────────────────────────
let syncTimeout: ReturnType<typeof setTimeout> | null = null;
function syncQueueToServer(queue: Track[], currentTrack: Track | null, currentTime: number) {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    const ids = queue.slice(0, 1000).map(t => t.id);
    const pos = Math.floor(currentTime * 1000);
    savePlayQueue(ids, currentTrack?.id, pos).catch(err => {
      console.error('Failed to sync play queue to server', err);
    });
  }, 5000);
}

// ─── Audio event handlers (called from initAudioListeners) ───────────────────

function handleAudioPlaying(_duration: number) {
  setDeferHotCachePrefetch(false);
  usePlayerStore.setState({ isPlaying: true });
}

function handleAudioProgress(current_time: number, duration: number) {
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
  usePlayerStore.setState({ currentTime: displayTime, progress, buffered: 0 });

  // Scrobble at 50%: Last.fm + Navidrome (updates play_date / recently played)
  if (progress >= 0.5 && !store.scrobbled) {
    usePlayerStore.setState({ scrobbled: true });
    scrobbleSong(track.id, Date.now());
    const { scrobblingEnabled, lastfmSessionKey } = useAuthStore.getState();
    if (scrobblingEnabled && lastfmSessionKey) {
      lastfmScrobble(track, Date.now(), lastfmSessionKey);
    }
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
      invoke('audio_preload', { url: nextUrl, durationHint: nextTrack.duration }).catch(() => {});
    }

    // Gapless chain — decode + chain into Sink 30s before track boundary.
    if (shouldChainGapless && nextTrack.id !== gaplessPreloadingId) {
      gaplessPreloadingId = nextTrack.id;
      const authState = useAuthStore.getState();
      // Auto-mode neighbours for the *next* track: current track on its left,
      // queue[nextIdx+1] on its right.
      const nextNeighbour = nextIdx + 1 < queue.length
        ? queue[nextIdx + 1]
        : (repeatMode === 'all' && queue.length > 0 ? queue[0] : null);
      const replayGainDb = resolveReplayGainDb(
        nextTrack, track, nextNeighbour,
        authState.replayGainEnabled, authState.replayGainMode,
      );
      const replayGainPeak = authState.replayGainEnabled
        ? (nextTrack.replayGainPeak ?? null)
        : null;
      invoke('audio_chain_preload', {
        url: nextUrl,
        volume: store.volume,
        durationHint: nextTrack.duration,
        replayGainDb,
        replayGainPeak,
        preGainDb: authState.replayGainPreGainDb,
        fallbackDb: authState.replayGainFallbackDb,
        hiResEnabled: authState.enableHiRes,
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
  usePlayerStore.setState({ isPlaying: false, progress: 0, currentTime: 0, buffered: 0 });
  setTimeout(() => {
    if (repeatMode === 'one' && currentTrack) {
      usePlayerStore.getState().playTrack(currentTrack, queue, false);
    } else {
      usePlayerStore.getState().next(false);
    }
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

  usePlayerStore.setState({
    currentTrack: nextTrack,
    queueIndex: newIndex,
    isPlaying: true,
    progress: 0,
    currentTime: 0,
    buffered: 0,
    scrobbled: false,
    lastfmLoved: false,
  });

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
  if (audioOutputDevice) {
    invoke('audio_set_device', { deviceName: audioOutputDevice }).catch(() => {});
  }

  // Keep audio settings in sync whenever auth store changes.
  const unsubAuth = useAuthStore.subscribe((state) => {
    invoke('audio_set_crossfade', {
      enabled: state.crossfadeEnabled,
      secs: state.crossfadeSecs,
    }).catch(() => {});
    invoke('audio_set_gapless', { enabled: state.gaplessEnabled }).catch(() => {});
  });

  // ── MPRIS / OS media controls sync ───────────────────────────────────────
  // Whenever the current track or playback state changes, push updates to the
  // Rust souvlaki MediaControls so the OS media overlay stays accurate.
  let prevTrackId: string | null = null;
  let prevRadioId: string | null = null;
  let prevIsPlaying: boolean | null = null;
  let lastMprisPositionUpdate = 0;

  const unsubMpris = usePlayerStore.subscribe((state) => {
    const { currentTrack, currentRadio, isPlaying, currentTime } = state;

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

    // Update playback state on play/pause change
    const playbackChanged = isPlaying !== prevIsPlaying;
    if (playbackChanged) {
      prevIsPlaying = isPlaying;
      lastMprisPositionUpdate = Date.now();
      invoke('mpris_set_playback', {
        playing: isPlaying,
        positionSecs: currentTime > 0 ? currentTime : null,
      }).catch(() => {});
      invoke('update_taskbar_icon', { isPlaying }).catch(() => {});
      return;
    }

    // Keep position in sync while playing — update every ~500 ms so Plasma
    // always shows the correct time without interpolation gaps.
    // Radio streams have no meaningful position, so skip for radio.
    if (!currentRadio && isPlaying && Date.now() - lastMprisPositionUpdate >= 500) {
      lastMprisPositionUpdate = Date.now();
      invoke('mpris_set_playback', {
        playing: true,
        positionSecs: currentTime,
      }).catch(() => {});
    }
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

  function syncDiscord() {
    const { currentTrack, isPlaying, currentTime } = usePlayerStore.getState();
    const {
      discordRichPresence,
      enableAppleMusicCoversDiscord,
      discordTemplateDetails,
      discordTemplateState,
      discordTemplateLargeText,
    } = useAuthStore.getState();

    if (!discordRichPresence || !currentTrack) {
      if (discordPrevTrackId !== null) {
        discordPrevTrackId = null;
        discordPrevIsPlaying = null;
        discordPrevFetchCovers = null;
        discordPrevTemplateDetails = null;
        discordPrevTemplateState = null;
        discordPrevTemplateLargeText = null;
        invoke('discord_clear_presence').catch(() => {});
      }
      return;
    }

    const trackChanged = currentTrack.id !== discordPrevTrackId;
    const playingChanged = isPlaying !== discordPrevIsPlaying;
    const coversSettingChanged = enableAppleMusicCoversDiscord !== discordPrevFetchCovers;
    const detailsTemplateChanged = discordTemplateDetails !== discordPrevTemplateDetails;
    const stateTemplateChanged = discordTemplateState !== discordPrevTemplateState;
    const largeTextTemplateChanged = discordTemplateLargeText !== discordPrevTemplateLargeText;
    if (!trackChanged && !playingChanged && !coversSettingChanged && !detailsTemplateChanged && !stateTemplateChanged && !largeTextTemplateChanged) return;

    discordPrevTrackId = currentTrack.id;
    discordPrevIsPlaying = isPlaying;
    discordPrevFetchCovers = enableAppleMusicCoversDiscord;
    discordPrevTemplateDetails = discordTemplateDetails;
    discordPrevTemplateState = discordTemplateState;
    discordPrevTemplateLargeText = discordTemplateLargeText;

    invoke('discord_update_presence', {
      title: currentTrack.title,
      artist: currentTrack.artist ?? 'Unknown Artist',
      album: currentTrack.album ?? null,
      isPlaying,
      elapsedSecs: isPlaying ? currentTime : null,
      // coverArtUrl is intentionally not passed — Subsonic URLs require auth.
      // iTunes cover fetching is only done when explicitly opted in.
      coverArtUrl: null,
      fetchItunesCovers: enableAppleMusicCoversDiscord,
      detailsTemplate: discordTemplateDetails,
      stateTemplate: discordTemplateState,
      largeTextTemplate: discordTemplateLargeText,
    }).catch(() => {});
  }

  const unsubDiscordPlayer = usePlayerStore.subscribe(syncDiscord);
  const unsubDiscordAuth = useAuthStore.subscribe(syncDiscord);

  return () => {
    unsubAuth();
    unsubMpris();
    unsubDiscordPlayer();
    unsubDiscordAuth();
    pending.forEach(p => p.then(unlisten => unlisten()));
    radioMetaUnlisten.then(unlisten => unlisten());
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      currentTrack: null,
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
      isQueueVisible: true,
      isFullscreenOpen: false,
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

      toggleQueue: () => set(state => ({ isQueueVisible: !state.isQueueVisible })),
      setQueueVisible: (v: boolean) => set({ isQueueVisible: v }),
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
          currentPlaybackSource: null,
          enginePreloadedTrackId: null,
        });
      },

      // ── playRadio ────────────────────────────────────────────────────────────
      playRadio: async (station) => {
        const { volume } = get();
        ++playGeneration;
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
      playTrack: (track, queue, manual = true) => {
        // Ghost-command guard: if a gapless switch happened within 500 ms,
        // this playTrack call is likely a stale IPC echo — suppress it.
        if (Date.now() - lastGaplessSwitchTime < 500) {
          return;
        }

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
        const idx = newQueue.findIndex(t => t.id === track.id);
        const pendingVisualTarget = seekFallbackVisualTarget?.trackId === track.id
          ? seekFallbackVisualTarget.seconds
          : null;
        const initialTime = pendingVisualTarget !== null
          ? Math.max(0, Math.min(pendingVisualTarget, track.duration || pendingVisualTarget))
          : 0;
        const initialProgress =
          track.duration && track.duration > 0 ? Math.max(0, Math.min(1, initialTime / track.duration)) : 0;

        const authState = useAuthStore.getState();
        const url = resolvePlaybackUrl(track.id, authState.activeServerId ?? '');
        const preloadedTrackId = get().enginePreloadedTrackId;
        const keepPreloadHint = preloadedTrackId === track.id;
        const playbackSourceHint = getPlaybackSourceKind(
          track.id,
          authState.activeServerId ?? '',
          keepPreloadHint ? track.id : null,
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
          && prevTrack.id !== track.id
          && authState.hotCacheEnabled
          && authState.activeServerId
        ) {
          void promoteCompletedStreamToHotCache(
            prevTrack,
            authState.activeServerId,
            authState.hotCacheDownloadDir || null,
          );
        }
        setDeferHotCachePrefetch(true);
        const playIdx = idx >= 0 ? idx : 0;
        const nextNeighbour = playIdx + 1 < newQueue.length ? newQueue[playIdx + 1] : null;
        const replayGainDb = resolveReplayGainDb(
          track, prevTrack, nextNeighbour,
          authState.replayGainEnabled, authState.replayGainMode,
        );
        const replayGainPeak = authState.replayGainEnabled ? (track.replayGainPeak ?? null) : null;
        invoke('audio_play', {
          url,
          volume: state.volume,
          durationHint: track.duration,
          replayGainDb,
          replayGainPeak,
          preGainDb: authState.replayGainPreGainDb,
          fallbackDb: authState.replayGainFallbackDb,
          manual,
          hiResEnabled: authState.enableHiRes,
        })
          .then(() => {
            if (playGeneration !== gen) return;
            if (keepPreloadHint) {
              usePlayerStore.setState({ enginePreloadedTrackId: null });
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
        touchHotCacheOnPlayback(track.id, authState.activeServerId ?? '');
      },

      reseedQueueForInstantMix: (track) => {
        const s = get();
        if (s.currentTrack?.id !== track.id) {
          get().playTrack(track, [track]);
          return;
        }
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
        if (get().currentRadio) {
          radioAudio.pause();
        } else {
          invoke('audio_pause').catch(console.error);
          isAudioPaused = true;
        }
        set({ isPlaying: false });
      },

      resetAudioPause: () => {
        isAudioPaused = false;
      },

      resume: () => {
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
          // Cold start (app relaunch) — fetch fresh track data for replay gain, then play.
          const gen = ++playGeneration;
          const vol = get().volume;
          set({ isPlaying: true });
          
          // Fetch fresh track data from server to get replay gain metadata
          getSong(currentTrack.id).then(freshSong => {
            const trackToPlay = freshSong ? songToTrack(freshSong) : currentTrack;
            // Update store with fresh track data if available
            if (freshSong) set({ currentTrack: trackToPlay });
            const authStateCold = useAuthStore.getState();
            const replayGainDbCold = resolveReplayGainDb(
              trackToPlay, coldPrev, coldNext,
              authStateCold.replayGainEnabled, authStateCold.replayGainMode,
            );
            const replayGainPeakCold = authStateCold.replayGainEnabled ? (trackToPlay.replayGainPeak ?? null) : null;
            const coldServerId = useAuthStore.getState().activeServerId ?? '';
            setDeferHotCachePrefetch(true);
            const coldUrl = resolvePlaybackUrl(trackToPlay.id, coldServerId);
            touchHotCacheOnPlayback(trackToPlay.id, coldServerId);
            invoke('audio_play', {
              url: coldUrl,
              volume: vol,
              durationHint: trackToPlay.duration,
              replayGainDb: replayGainDbCold,
              replayGainPeak: replayGainPeakCold,
              preGainDb: authStateCold.replayGainPreGainDb,
              fallbackDb: authStateCold.replayGainFallbackDb,
              manual: false,
              hiResEnabled: useAuthStore.getState().enableHiRes,
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
               authStateCold.replayGainEnabled, authStateCold.replayGainMode,
             );
             const replayGainPeakCold = authStateCold.replayGainEnabled ? (currentTrack.replayGainPeak ?? null) : null;
             const coldServerId = useAuthStore.getState().activeServerId ?? '';
             setDeferHotCachePrefetch(true);
             const coldUrl = resolvePlaybackUrl(currentTrack.id, coldServerId);
             touchHotCacheOnPlayback(currentTrack.id, coldServerId);
             invoke('audio_play', {
               url: coldUrl,
               volume: vol,
               durationHint: currentTrack.duration,
               replayGainDb: replayGainDbCold,
               replayGainPeak: replayGainPeakCold,
               preGainDb: authStateCold.replayGainPreGainDb,
               fallbackDb: authStateCold.replayGainFallbackDb,
               manual: false,
               hiResEnabled: useAuthStore.getState().enableHiRes,
             }).catch((err: unknown) => {
               if (playGeneration !== gen) return;
               setDeferHotCachePrefetch(false);
               console.error('[psysonic] audio_play (cold resume) failed:', err);
               set({ isPlaying: false });
             });
             syncQueueToServer(queue, currentTrack, currentTime);
           });
        }
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
        const { queue, queueIndex, currentTime } = get();
        if (currentTime > 3) {
          // Restart current track from the beginning.
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
      enqueue: (tracks) => {
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
          return { queue: newQueue };
        });
      },

      setRadioArtistId: (artistId) => { currentRadioArtistId = artistId; },

      enqueueRadio: (tracks, artistId) => {
        if (artistId) currentRadioArtistId = artistId;
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

      enqueueAt: (tracks, insertIndex) => {
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

      removeTrack: (index) => {
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
           }
         } catch (e) {
           console.error('Failed to initialize queue from server', e);
         }
       },

       updateReplayGainForCurrentTrack: () => {
         const { currentTrack, queue, queueIndex, volume } = get();
         if (!currentTrack || !currentTrack.id) return;
         const authState = useAuthStore.getState();
         const prev = queueIndex > 0 ? queue[queueIndex - 1] : null;
         const next = queueIndex + 1 < queue.length ? queue[queueIndex + 1] : null;
         const replayGainDb = resolveReplayGainDb(
           currentTrack, prev, next,
           authState.replayGainEnabled, authState.replayGainMode,
         );
         const replayGainPeak = authState.replayGainEnabled
           ? (currentTrack.replayGainPeak ?? null)
           : null;
         
         invoke('audio_update_replay_gain', {
           volume,
           replayGainDb,
           replayGainPeak,
           preGainDb: authState.replayGainPreGainDb,
           fallbackDb: authState.replayGainFallbackDb,
         }).catch(console.error);
       },
    }),
    {
      name: 'psysonic-player',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        volume: state.volume,
        repeatMode: state.repeatMode,
        currentTrack: state.currentTrack,
        queue: state.queue,
        queueIndex: state.queueIndex,
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
