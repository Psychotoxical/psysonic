import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { showToast } from '../utils/toast';
import { buildStreamUrl, buildCoverArtUrl, getPlayQueue, savePlayQueue, reportNowPlaying, scrobbleSong, SubsonicSong, getSong, getRandomSongs, getSimilarSongs2, getTopSongs, InternetRadioStation } from '../api/subsonic';
import { lastfmScrobble, lastfmUpdateNowPlaying, lastfmLoveTrack, lastfmUnloveTrack, lastfmGetTrackLoved, lastfmGetAllLovedTracks } from '../api/lastfm';
import { useAuthStore } from './authStore';
import { useOfflineStore } from './offlineStore';

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
  };
}

interface PlayerState {
  currentTrack: Track | null;
  currentRadio: InternetRadioStation | null;
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

  playRadio: (station: InternetRadioStation) => void;
  playTrack: (track: Track, queue?: Track[], manual?: boolean) => void;
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

  initializeFromServerQueue: () => Promise<void>;

  contextMenu: {
    isOpen: boolean;
    x: number;
    y: number;
    item: any;
    type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song' | null;
    queueIndex?: number;
  };
  openContextMenu: (x: number, y: number, item: any, type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song', queueIndex?: number) => void;
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

// Guard against rapid double-click play/pause sending two state transitions
// to the Rust backend before it has finished the previous one.
let togglePlayLock = false;

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

function clearRadioReconnectTimer() {
  if (radioReconnectTimer) { clearTimeout(radioReconnectTimer); radioReconnectTimer = null; }
}

radioAudio.addEventListener('ended', () => {
  // Stream disconnected unexpectedly — clear radio state.
  clearRadioReconnectTimer();
  usePlayerStore.setState({ isPlaying: false, currentRadio: null, progress: 0, currentTime: 0 });
});
radioAudio.addEventListener('error', () => {
  clearRadioReconnectTimer();
  if (radioStopping) { radioStopping = false; return; }
  usePlayerStore.setState({ isPlaying: false, currentRadio: null });
  showToast('Radio stream error', 3000, 'error');
});
// Stalled: stream stopped delivering data — try to reconnect after 4 s.
radioAudio.addEventListener('stalled', () => {
  if (radioReconnectTimer) return; // already scheduled
  radioReconnectTimer = setTimeout(() => {
    radioReconnectTimer = null;
    if (!usePlayerStore.getState().currentRadio) return;
    // Re-assign src to force a fresh connection, then resume playback.
    const src = radioAudio.src;
    radioAudio.src = src;
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

// Track ID that has already been sent to audio_chain_preload / audio_preload.
// Prevents the 100ms progress ticker from firing 300 identical IPC calls over
// the last 30 seconds of a track, each spawning its own HTTP download.
let gaplessPreloadingId: string | null = null;

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
  }, 1500);
}

// ─── Audio event handlers (called from initAudioListeners) ───────────────────

function handleAudioPlaying(_duration: number) {
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
    if (Math.abs(current_time - seekTarget) > 2.0) return;
    seekTarget = null;
  }

  const store = usePlayerStore.getState();
  const track = store.currentTrack;
  if (!track) return;
  const dur = duration > 0 ? duration : track.duration;
  if (dur <= 0) return;
  const progress = current_time / dur;
  usePlayerStore.setState({ currentTime: current_time, progress, buffered: 0 });

  // Scrobble at 50%: Last.fm + Navidrome (updates play_date / recently played)
  if (progress >= 0.5 && !store.scrobbled) {
    usePlayerStore.setState({ scrobbled: true });
    scrobbleSong(track.id, Date.now());
    const { scrobblingEnabled, lastfmSessionKey } = useAuthStore.getState();
    if (scrobblingEnabled && lastfmSessionKey) {
      lastfmScrobble(track, Date.now(), lastfmSessionKey);
    }
  }

  // Pre-buffer / pre-chain next track based on preload mode.
  const { gaplessEnabled, preloadMode, preloadCustomSeconds } = useAuthStore.getState();
  const remaining = dur - current_time;
  const shouldPreload = preloadMode === 'early'
    ? current_time >= 5
    : preloadMode === 'custom'
      ? remaining < preloadCustomSeconds && remaining > 0
      : remaining < 30 && remaining > 0; // balanced (default)
  if (shouldPreload) {
    const { queue, queueIndex, repeatMode } = store;
    const nextIdx = queueIndex + 1;
    const nextTrack = repeatMode === 'one'
      ? track
      : (nextIdx < queue.length ? queue[nextIdx] : (repeatMode === 'all' ? queue[0] : null));
    if (nextTrack && nextTrack.id !== track.id && nextTrack.id !== gaplessPreloadingId) {
      gaplessPreloadingId = nextTrack.id;
      const serverId = useAuthStore.getState().activeServerId ?? '';
      const nextUrl = useOfflineStore.getState().getLocalUrl(nextTrack.id, serverId) ?? buildStreamUrl(nextTrack.id);
      if (gaplessEnabled) {
        // Gapless ON: decode + chain directly into the Sink now, 30 s in
        // advance. By the time the track boundary arrives, the next source is
        // already live — no IPC round-trip at the gap point.
        const authState = useAuthStore.getState();
        const replayGainDb = authState.replayGainEnabled
          ? (authState.replayGainMode === 'album'
              ? nextTrack.replayGainAlbumDb
              : nextTrack.replayGainTrackDb) ?? null
          : null;
        const replayGainPeak = authState.replayGainEnabled
          ? (nextTrack.replayGainPeak ?? null)
          : null;
        invoke('audio_chain_preload', {
          url: nextUrl,
          volume: store.volume,
          durationHint: nextTrack.duration,
          replayGainDb,
          replayGainPeak,
        }).catch(() => {});
      } else {
        // Gapless OFF: just pre-download bytes so audio_play finds them cached.
        invoke('audio_preload', { url: nextUrl, durationHint: nextTrack.duration }).catch(() => {});
      }
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
  gaplessPreloadingId = null; // allow preloading for the track after this one
  isAudioPaused = false;

  const store = usePlayerStore.getState();
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
  const pending = [
    listen<number>('audio:playing', ({ payload }) => handleAudioPlaying(payload)),
    listen<{ current_time: number; duration: number }>('audio:progress', ({ payload }) =>
      handleAudioProgress(payload.current_time, payload.duration)
    ),
    listen<void>('audio:ended', () => handleAudioEnded()),
    listen<string>('audio:error', ({ payload }) => handleAudioError(payload)),
    listen<number>('audio:track_switched', ({ payload }) => handleAudioTrackSwitched(payload)),
  ];

  // Sync Last.fm loved tracks cache on startup.
  usePlayerStore.getState().syncLastfmLovedTracks();

  // Initial sync of audio settings to Rust engine on startup.
  const { crossfadeEnabled, crossfadeSecs, gaplessEnabled } = useAuthStore.getState();
  invoke('audio_set_crossfade', { enabled: crossfadeEnabled, secs: crossfadeSecs }).catch(() => {});
  invoke('audio_set_gapless', { enabled: gaplessEnabled }).catch(() => {});

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
  let prevIsPlaying: boolean | null = null;
  let lastMprisPositionUpdate = 0;

  const unsubMpris = usePlayerStore.subscribe((state) => {
    const { currentTrack, isPlaying, currentTime } = state;

    // Update metadata when track changes
    if (currentTrack && currentTrack.id !== prevTrackId) {
      prevTrackId = currentTrack.id;
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

    // Update playback state on play/pause change
    const playbackChanged = isPlaying !== prevIsPlaying;
    if (playbackChanged) {
      prevIsPlaying = isPlaying;
      lastMprisPositionUpdate = Date.now();
      invoke('mpris_set_playback', {
        playing: isPlaying,
        positionSecs: currentTime > 0 ? currentTime : null,
      }).catch(() => {});
      return;
    }

    // Keep position in sync while playing — update every ~500 ms so Plasma
    // always shows the correct time without interpolation gaps.
    if (isPlaying && Date.now() - lastMprisPositionUpdate >= 500) {
      lastMprisPositionUpdate = Date.now();
      invoke('mpris_set_playback', {
        playing: true,
        positionSecs: currentTime,
      }).catch(() => {});
    }
  });

  // ── Discord Rich Presence sync ────────────────────────────────────────────
  // Updates on track change or play/pause toggle. No per-tick updates needed —
  // Discord auto-counts up the elapsed timer from the start_timestamp we set.
  let discordPrevTrackId: string | null = null;
  let discordPrevIsPlaying: boolean | null = null;

  function syncDiscord() {
    const { currentTrack, isPlaying, currentTime } = usePlayerStore.getState();
    const { discordRichPresence } = useAuthStore.getState();

    if (!discordRichPresence || !currentTrack) {
      if (discordPrevTrackId !== null) {
        discordPrevTrackId = null;
        discordPrevIsPlaying = null;
        invoke('discord_clear_presence').catch(() => {});
      }
      return;
    }

    const trackChanged = currentTrack.id !== discordPrevTrackId;
    const playingChanged = isPlaying !== discordPrevIsPlaying;
    if (!trackChanged && !playingChanged) return;

    discordPrevTrackId = currentTrack.id;
    discordPrevIsPlaying = isPlaying;

    invoke('discord_update_presence', {
      title: currentTrack.title,
      artist: currentTrack.artist ?? 'Unknown Artist',
      album: currentTrack.album ?? null,
      // Pass elapsed when playing so Discord shows a live running timer.
      // Pass null when paused — Discord shows the song/artist without a timer.
      elapsedSecs: isPlaying ? currentTime : null,
      // coverArtUrl is intentionally not passed — Subsonic URLs require auth.
      // Backend will fetch artwork from iTunes Search API instead.
      coverArtUrl: null,
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
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      currentTrack: null,
      currentRadio: null,
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
      isQueueVisible: true,
      isFullscreenOpen: false,
      repeatMode: 'off',
      contextMenu: { isOpen: false, x: 0, y: 0, item: null, type: null },

      openContextMenu: (x, y, item, type, queueIndex) => set({
        contextMenu: { isOpen: true, x, y, item, type, queueIndex },
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
        if (seekDebounce) { clearTimeout(seekDebounce); seekDebounce = null; } seekTarget = null;
        set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0, currentRadio: null });
      },

      // ── playRadio ────────────────────────────────────────────────────────────
      playRadio: (station) => {
        const { volume } = get();
        ++playGeneration;
        isAudioPaused = false;
        clearRadioReconnectTimer();
        gaplessPreloadingId = null;
        if (seekDebounce) { clearTimeout(seekDebounce); seekDebounce = null; } seekTarget = null;
        // Stop Rust engine in case a regular track was playing.
        invoke('audio_stop').catch(() => {});
        // Play via HTML5 audio — browser handles reconnects, codec negotiation, buffering.
        radioAudio.src = station.streamUrl;
        radioAudio.volume = volume;
        radioAudio.play().catch((err: unknown) => {
          console.error('[psysonic] radio HTML5 play failed:', err);
          showToast('Radio stream error', 3000, 'error');
          set({ isPlaying: false, currentRadio: null });
        });
        set({
          currentRadio: station,
          currentTrack: null,
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
        gaplessPreloadingId = null; // new track — allow fresh preload for next
        if (seekDebounce) { clearTimeout(seekDebounce); seekDebounce = null; } seekTarget = null;

        // If a radio stream is active, stop it before the new track starts so
        // the PlayerBar clears radio mode immediately and the stream is released.
        if (get().currentRadio) {
          clearRadioReconnectTimer();
          radioStopping = true;
          radioAudio.pause();
          radioAudio.src = '';
        }

        const state = get();
        const newQueue = queue ?? state.queue;
        const idx = newQueue.findIndex(t => t.id === track.id);

        // Set state immediately so the UI updates before the download completes.
        // currentRadio: null ensures the PlayerBar switches out of radio mode right away.
        set({
          currentTrack: track,
          currentRadio: null,
          queue: newQueue,
          queueIndex: idx >= 0 ? idx : 0,
          progress: 0,
          buffered: 0,
          currentTime: 0,
          scrobbled: false,
          lastfmLoved: false,
          isPlaying: true, // optimistic — reverted on error
        });

        const authState = useAuthStore.getState();
        const url = useOfflineStore.getState().getLocalUrl(track.id, authState.activeServerId ?? '') ?? buildStreamUrl(track.id);
        const replayGainDb = authState.replayGainEnabled
          ? (authState.replayGainMode === 'album' ? track.replayGainAlbumDb : track.replayGainTrackDb) ?? null
          : null;
        const replayGainPeak = authState.replayGainEnabled ? (track.replayGainPeak ?? null) : null;
        invoke('audio_play', {
          url,
          volume: state.volume,
          durationHint: track.duration,
          replayGainDb,
          replayGainPeak,
          manual,
        }).catch((err: unknown) => {
          if (playGeneration !== gen) return;
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
        syncQueueToServer(newQueue, track, 0);
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

      resume: () => {
        if (get().currentRadio) {
          radioAudio.play().catch(console.error);
          set({ isPlaying: true });
          return;
        }
        const { currentTrack, queue, currentTime } = get();
        if (!currentTrack) return;

        if (isAudioPaused) {
          // Rust engine has audio loaded but paused — just resume it.
          invoke('audio_resume').catch(console.error);
          isAudioPaused = false;
          set({ isPlaying: true });
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
            const replayGainDbCold = authStateCold.replayGainEnabled
              ? (authStateCold.replayGainMode === 'album' ? trackToPlay.replayGainAlbumDb : trackToPlay.replayGainTrackDb) ?? null
              : null;
            const replayGainPeakCold = authStateCold.replayGainEnabled ? (trackToPlay.replayGainPeak ?? null) : null;
            const coldServerId = useAuthStore.getState().activeServerId ?? '';
            const coldUrl = useOfflineStore.getState().getLocalUrl(trackToPlay.id, coldServerId) ?? buildStreamUrl(trackToPlay.id);
            invoke('audio_play', {
              url: coldUrl,
              volume: vol,
              durationHint: trackToPlay.duration,
              replayGainDb: replayGainDbCold,
              manual: false,
              replayGainPeak: replayGainPeakCold,
            }).then(() => {
              if (playGeneration === gen && currentTime > 1) {
                invoke('audio_seek', { seconds: currentTime }).catch(console.error);
              }
            }).catch((err: unknown) => {
              if (playGeneration !== gen) return;
              console.error('[psysonic] audio_play (cold resume) failed:', err);
              set({ isPlaying: false });
            });
            syncQueueToServer(queue, trackToPlay, currentTime);
          }).catch(() => {
             if (playGeneration !== gen) return;
             // Fallback to currentTrack if fetch fails
             const authStateCold = useAuthStore.getState();
             const replayGainDbCold = authStateCold.replayGainEnabled
               ? (authStateCold.replayGainMode === 'album' ? currentTrack.replayGainAlbumDb : currentTrack.replayGainTrackDb) ?? null
               : null;
             const replayGainPeakCold = authStateCold.replayGainEnabled ? (currentTrack.replayGainPeak ?? null) : null;
             const coldServerId = useAuthStore.getState().activeServerId ?? '';
             const coldUrl = useOfflineStore.getState().getLocalUrl(currentTrack.id, coldServerId) ?? buildStreamUrl(currentTrack.id);
             invoke('audio_play', {
               url: coldUrl,
               volume: vol,
               durationHint: currentTrack.duration,
               replayGainDb: replayGainDbCold,
               replayGainPeak: replayGainPeakCold,
               manual: false,
             }).catch((err: unknown) => {
               if (playGeneration !== gen) return;
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
              getRandomSongs(5, currentTrack?.genre).then(songs => {
                if (songs.length > 0) {
                  const newTracks: Track[] = songs.map(s => ({ ...songToTrack(s), autoAdded: true }));
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
                      set(state => ({ queue: [...state.queue, ...fresh] }));
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
            getRandomSongs(5, currentTrack?.genre).then(songs => {
              infiniteQueueFetching = false;
              if (songs.length === 0) {
                invoke('audio_stop').catch(console.error);
                isAudioPaused = false;
                set({ isPlaying: false, progress: 0, buffered: 0, currentTime: 0 });
                return;
              }
              const newTracks: Track[] = songs.map(s => ({ ...songToTrack(s), autoAdded: true }));
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
          seekTarget = time;
          invoke('audio_seek', { seconds: time }).catch(console.error);
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
        if (seekDebounce) { clearTimeout(seekDebounce); seekDebounce = null; } seekTarget = null;
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
         const { currentTrack, volume } = get();
         if (!currentTrack || !currentTrack.id) return;
         const authState = useAuthStore.getState();
         const replayGainDb = authState.replayGainEnabled
           ? (authState.replayGainMode === 'album' 
               ? currentTrack.replayGainAlbumDb 
               : currentTrack.replayGainTrackDb) ?? null
           : null;
         const replayGainPeak = authState.replayGainEnabled 
           ? (currentTrack.replayGainPeak ?? null) 
           : null;
         
         invoke('audio_update_replay_gain', { 
           volume, 
           replayGainDb, 
           replayGainPeak 
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
        currentTime: state.currentTime,
        lastfmLovedCache: state.lastfmLovedCache,
      }),
    }
  )
);
