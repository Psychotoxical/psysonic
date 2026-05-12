import type { InternetRadioStation } from '../api/subsonicTypes';
import type { PlaybackSourceKind } from '../utils/resolvePlaybackUrl';

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
