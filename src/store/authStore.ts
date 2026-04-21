import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import type { EntityRatingSupportLevel } from '../api/subsonic';
import {
  isNavidromeAudiomuseSoftwareEligible,
  type InstantMixProbeResult,
  type SubsonicServerIdentity,
} from '../utils/subsonicServerIdentity';
import { usePlayerStore } from './playerStore';
import { IS_LINUX } from '../utils/platform';

export interface ServerProfile {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
}

export type SeekbarStyle = 'waveform' | 'linedot' | 'bar' | 'thick' | 'segmented' | 'neon' | 'pulsewave' | 'particletrail' | 'liquidfill' | 'retrotape';
export type LoggingMode = 'off' | 'normal' | 'debug';

export type LyricsSourceId = 'server' | 'lrclib' | 'netease';
export interface LyricsSourceConfig { id: LyricsSourceId; enabled: boolean; }

const DEFAULT_LYRICS_SOURCES: LyricsSourceConfig[] = [
  { id: 'server',  enabled: true  },
  { id: 'lrclib',  enabled: true  },
  { id: 'netease', enabled: false },
];

interface AuthState {
  // Multi-server
  servers: ServerProfile[];
  activeServerId: string | null;

  // Last.fm (global)
  lastfmApiKey: string;
  lastfmApiSecret: string;
  lastfmSessionKey: string;
  lastfmUsername: string;

  // Settings (global)
  scrobblingEnabled: boolean;
  maxCacheMb: number;
  downloadFolder: string;
  offlineDownloadDir: string;
  excludeAudiobooks: boolean;
  customGenreBlacklist: string[];
  replayGainEnabled: boolean;
  replayGainMode: 'track' | 'album' | 'auto';
  replayGainPreGainDb: number;   // added to RG gain for tagged files (0…+6 dB)
  replayGainFallbackDb: number;  // gain for untagged files / radio (-6…0 dB)
  crossfadeEnabled: boolean;
  crossfadeSecs: number;
  gaplessEnabled: boolean;
  preloadMode: 'off' | 'balanced' | 'early' | 'custom';
  preloadCustomSeconds: number;
  infiniteQueueEnabled: boolean;
  showArtistImages: boolean;
  showTrayIcon: boolean;
  minimizeToTray: boolean;
  discordRichPresence: boolean;
  enableAppleMusicCoversDiscord: boolean;
  discordTemplateDetails: string;
  discordTemplateState: string;
  discordTemplateLargeText: string;
  useCustomTitlebar: boolean;
  /** Pre-build the mini-player webview at app start on Linux/macOS so content is available instantly
   *  on first open. Ignored on Windows — that platform always pre-creates as a hang workaround. */
  preloadMiniPlayer: boolean;
  /** Linux WebKitGTK: smooth wheel on when true; off only after explicit opt-out in Settings. */
  linuxWebkitKineticScroll: boolean;
  /** Runtime backend logging level. */
  loggingMode: LoggingMode;
  nowPlayingEnabled: boolean;
  lyricsServerFirst: boolean;
  enableNeteaselyrics: boolean;
  lyricsSources: LyricsSourceConfig[];
  /**
   * `'standard'`  → server + lrclib + netease pipeline (configurable order).
   * `'lyricsplus'` → YouLyPlus / lyricsplus first, silent fallback to standard
   *                  pipeline when no data is returned.
   */
  lyricsMode: 'standard' | 'lyricsplus';
  /**
   * Render synced lines as static text (no auto-scroll, no word highlighting).
   * Honoured in both lyrics modes.
   */
  lyricsStaticOnly: boolean;
  showFullscreenLyrics: boolean;
  /** 'rail' = classic 5-line sliding rail; 'apple' = full-screen scrolling list */
  fsLyricsStyle: 'rail' | 'apple';
  /** Sidebar lyrics scroll style: 'classic' = scrollIntoView center; 'apple' = scroll to 35% */
  sidebarLyricsStyle: 'classic' | 'apple';
  showFsArtistPortrait: boolean;
  /** Portrait dimming 0–100 (percent), applied as CSS rgba alpha */
  fsPortraitDim: number;
  showChangelogOnUpdate: boolean;
  lastSeenChangelogVersion: string;

  seekbarStyle: SeekbarStyle;

  /** Alpha: native hi-res sample rate output (disabled = safe 44.1 kHz mode) */
  enableHiRes: boolean;
  /** Selected audio output device name. null = system default. */
  audioOutputDevice: string | null;

  /** Alpha: ephemeral queue prefetch cache on disk */
  hotCacheEnabled: boolean;
  hotCacheMaxMb: number;
  hotCacheDebounceSec: number;
  /** Parent directory; actual cache is `<dir>/psysonic-hot-cache/`. Empty = app data. */
  hotCacheDownloadDir: string;

  /** After this many manual skips of the same track, set track rating to 1 if still unrated (below 1 star). */
  skipStarOnManualSkipsEnabled: boolean;
  /** Manual skips per track before applying rating 1 (when enabled). */
  skipStarManualSkipThreshold: number;
  /**
   * Manual Next-count per track for skip→1★. Key = `${serverId}\\u001f${trackId}`
   * (empty serverId when none). Persisted; cleared when the track finishes naturally or when threshold is reached.
   */
  skipStarManualSkipCountsByKey: Record<string, number>;
  /** Increment skip count for current server + track; clears stored count when threshold reached. */
  recordSkipStarManualAdvance: (trackId: string) => { crossedThreshold: boolean } | null;
  /** Drop persisted skip count for this track on the active server (e.g. natural playback end). */
  clearSkipStarManualCountForTrack: (trackId: string) => void;

  /** Random mixes, random albums, home hero: drop non‑zero ratings at or below per‑axis thresholds (0 = unrated, kept). */
  mixMinRatingFilterEnabled: boolean;
  /** 0 = ignore; 1–3 = cutoff (UI); exclude track rating r when 0 < r ≤ cutoff. */
  mixMinRatingSong: number;
  /** 0 = ignore; album entity rating from payload or `getAlbum` when missing. */
  mixMinRatingAlbum: number;
  /** 0 = ignore; artist rating from payload / nested OpenSubsonic fields or `getArtist`. */
  mixMinRatingArtist: number;

  /** Subsonic music folders for the active server (not persisted; refetched on login / server change). */
  musicFolders: Array<{ id: string; name: string }>;
  /**
   * Per server: `all` = no musicFolderId param; otherwise a single folder id.
   * Only one library or all — no multi-folder merge.
   */
  musicLibraryFilterByServer: Record<string, 'all' | string>;
  /** Bumps when `setMusicLibraryFilter` runs so pages refetch catalog data. */
  musicLibraryFilterVersion: number;

  /**
   * Per server: whether `setRating` is assumed to work for album/artist ids (OpenSubsonic-style).
   * Absent key = not probed yet (`unknown` in UI).
   */
  entityRatingSupportByServer: Record<string, EntityRatingSupportLevel>;
  setEntityRatingSupport: (serverId: string, level: EntityRatingSupportLevel) => void;

  /**
   * Per server: Navidrome has the AudioMuse-AI plugin — use `getSimilarSongs` (Instant Mix) and
   * `getArtistInfo2` similar artists instead of Last.fm for discovery on this server.
   */
  audiomuseNavidromeByServer: Record<string, boolean>;
  setAudiomuseNavidromeEnabled: (serverId: string, enabled: boolean) => void;

  /** From `ping` — used to show the AudioMuse toggle only on Navidrome ≥ 0.60. */
  subsonicServerIdentityByServer: Record<string, SubsonicServerIdentity>;
  setSubsonicServerIdentity: (serverId: string, identity: SubsonicServerIdentity) => void;

  /** Instant Mix / similar path failed while this server had AudioMuse enabled (cleared on success or toggle off). */
  audiomuseNavidromeIssueByServer: Record<string, boolean>;
  setAudiomuseNavidromeIssue: (serverId: string, hasIssue: boolean) => void;

  /**
   * `getSimilarSongs` probe per server (after ping). `empty` hides the AudioMuse row; re-run by testing connection.
   */
  instantMixProbeByServer: Record<string, InstantMixProbeResult>;
  setInstantMixProbe: (serverId: string, result: InstantMixProbeResult) => void;

  // Status
  isLoggedIn: boolean;
  isConnecting: boolean;
  connectionError: string | null;
  lastfmSessionError: boolean;

  // Actions
  addServer: (profile: Omit<ServerProfile, 'id'>) => string;
  updateServer: (id: string, data: Partial<Omit<ServerProfile, 'id'>>) => void;
  removeServer: (id: string) => void;
  setActiveServer: (id: string) => void;
  setLoggedIn: (v: boolean) => void;
  setConnecting: (v: boolean) => void;
  setConnectionError: (e: string | null) => void;
  setLastfm: (apiKey: string, apiSecret: string, sessionKey: string, username: string) => void;
  connectLastfm: (sessionKey: string, username: string) => void;
  disconnectLastfm: () => void;
  setLastfmSessionError: (v: boolean) => void;
  setScrobblingEnabled: (v: boolean) => void;
  setMaxCacheMb: (v: number) => void;
  setDownloadFolder: (v: string) => void;
  setOfflineDownloadDir: (v: string) => void;
  setExcludeAudiobooks: (v: boolean) => void;
  setCustomGenreBlacklist: (v: string[]) => void;
  setReplayGainEnabled: (v: boolean) => void;
  setReplayGainMode: (v: 'track' | 'album' | 'auto') => void;
  setReplayGainPreGainDb: (v: number) => void;
  setReplayGainFallbackDb: (v: number) => void;
  setCrossfadeEnabled: (v: boolean) => void;
  setCrossfadeSecs: (v: number) => void;
  setGaplessEnabled: (v: boolean) => void;
  setPreloadMode: (v: 'off' | 'balanced' | 'early' | 'custom') => void;
  setPreloadCustomSeconds: (v: number) => void;
  setInfiniteQueueEnabled: (v: boolean) => void;
  setShowArtistImages: (v: boolean) => void;
  setShowTrayIcon: (v: boolean) => void;
  setMinimizeToTray: (v: boolean) => void;
  setDiscordRichPresence: (v: boolean) => void;
  setEnableAppleMusicCoversDiscord: (v: boolean) => void;
  setDiscordTemplateDetails: (v: string) => void;
  setDiscordTemplateState: (v: string) => void;
  setDiscordTemplateLargeText: (v: string) => void;
  setUseCustomTitlebar: (v: boolean) => void;
  setPreloadMiniPlayer: (v: boolean) => void;
  setLinuxWebkitKineticScroll: (v: boolean) => void;
  setLoggingMode: (v: LoggingMode) => void;
  setNowPlayingEnabled: (v: boolean) => void;
  setLyricsServerFirst: (v: boolean) => void;
  setEnableNeteaselyrics: (v: boolean) => void;
  setLyricsSources: (sources: LyricsSourceConfig[]) => void;
  setLyricsMode: (v: 'standard' | 'lyricsplus') => void;
  setLyricsStaticOnly: (v: boolean) => void;
  setShowFullscreenLyrics: (v: boolean) => void;
  setFsLyricsStyle: (v: 'rail' | 'apple') => void;
  setSidebarLyricsStyle: (v: 'classic' | 'apple') => void;
  setShowFsArtistPortrait: (v: boolean) => void;
  setFsPortraitDim: (v: number) => void;
  setShowChangelogOnUpdate: (v: boolean) => void;
  setLastSeenChangelogVersion: (v: string) => void;
  setSeekbarStyle: (v: SeekbarStyle) => void;
  setEnableHiRes: (v: boolean) => void;
  setAudioOutputDevice: (v: string | null) => void;
  setHotCacheEnabled: (v: boolean) => void;
  setHotCacheMaxMb: (v: number) => void;
  setHotCacheDebounceSec: (v: number) => void;
  setHotCacheDownloadDir: (v: string) => void;
  setSkipStarOnManualSkipsEnabled: (v: boolean) => void;
  setSkipStarManualSkipThreshold: (v: number) => void;
  setMixMinRatingFilterEnabled: (v: boolean) => void;
  setMixMinRatingSong: (v: number) => void;
  setMixMinRatingAlbum: (v: number) => void;
  setMixMinRatingArtist: (v: number) => void;
  setMusicFolders: (folders: Array<{ id: string; name: string }>) => void;
  setMusicLibraryFilter: (folderId: 'all' | string) => void;

  /** Navigation style for Mix pages: single hub ('hub') or separate sidebar entries ('separate'). */
  randomNavMode: 'hub' | 'separate';
  setRandomNavMode: (v: 'hub' | 'separate') => void;

  logout: () => void;

  // Derived
  getBaseUrl: () => string;
  getActiveServer: () => ServerProfile | undefined;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Upper bound for mix min-rating thresholds (UI shows five stars, only 1…this many are selectable). */
export const MIX_MIN_RATING_FILTER_MAX_STARS = 3;

function clampMixFilterMinStars(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MIX_MIN_RATING_FILTER_MAX_STARS, Math.round(v)));
}

function clampSkipStarThreshold(v: number): number {
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(99, Math.round(v)));
}

function skipStarCountStorageKey(serverId: string | null | undefined, trackId: string): string {
  return `${serverId ?? ''}\u001f${trackId}`;
}

function sanitizeSkipStarCounts(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) next[k] = Math.min(Math.floor(n), 1_000_000);
  }
  return next;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      servers: [],
      activeServerId: null,
      lastfmApiKey: '',
      lastfmApiSecret: '',
      lastfmSessionKey: '',
      lastfmUsername: '',
      scrobblingEnabled: true,
      maxCacheMb: 500,
      downloadFolder: '',
      offlineDownloadDir: '',
      excludeAudiobooks: false,
      customGenreBlacklist: [],
      replayGainEnabled: false,
      replayGainMode: 'auto',
      replayGainPreGainDb: 0,
      replayGainFallbackDb: 0,
      crossfadeEnabled: false,
      crossfadeSecs: 3,
      gaplessEnabled: false,
      preloadMode: 'balanced',
      preloadCustomSeconds: 30,
      infiniteQueueEnabled: false,
      showArtistImages: false,
      showTrayIcon: true,
      minimizeToTray: false,
      discordRichPresence: false,
      enableAppleMusicCoversDiscord: false,
      discordTemplateDetails: '{artist} - {title}',
      discordTemplateState: '{album}',
      discordTemplateLargeText: '{album}',
      useCustomTitlebar: false,
      preloadMiniPlayer: false,
      linuxWebkitKineticScroll: true,
      loggingMode: 'normal',
      nowPlayingEnabled: false,
      lyricsServerFirst: true,
      enableNeteaselyrics: false,
      lyricsSources: DEFAULT_LYRICS_SOURCES,
      lyricsMode: 'standard',
      lyricsStaticOnly: false,
      showFullscreenLyrics: true,
      fsLyricsStyle: 'rail',
      sidebarLyricsStyle: 'classic',
      showFsArtistPortrait: true,
      fsPortraitDim: 28,
      showChangelogOnUpdate: true,
      lastSeenChangelogVersion: '',
      seekbarStyle: 'waveform',
      enableHiRes: false,
      audioOutputDevice: null,
      hotCacheEnabled: false,
      hotCacheMaxMb: 256,
      hotCacheDebounceSec: 30,
      hotCacheDownloadDir: '',
      skipStarOnManualSkipsEnabled: false,
      skipStarManualSkipThreshold: 3,
      skipStarManualSkipCountsByKey: {},
      mixMinRatingFilterEnabled: false,
      mixMinRatingSong: 0,
      mixMinRatingAlbum: 0,
      mixMinRatingArtist: 0,
      randomNavMode: 'hub',
      musicFolders: [],
      musicLibraryFilterByServer: {},
      musicLibraryFilterVersion: 0,
      entityRatingSupportByServer: {},
      audiomuseNavidromeByServer: {},
      subsonicServerIdentityByServer: {},
      audiomuseNavidromeIssueByServer: {},
      instantMixProbeByServer: {},
      isLoggedIn: false,
      isConnecting: false,
      connectionError: null,
      lastfmSessionError: false,

      addServer: (profile) => {
        const id = generateId();
        set(s => ({ servers: [...s.servers, { ...profile, id }] }));
        return id;
      },

      updateServer: (id, data) => {
        set(s => ({
          servers: s.servers.map(srv => srv.id === id ? { ...srv, ...data } : srv),
        }));
      },

      removeServer: (id) => {
        set(s => {
          const newServers = s.servers.filter(srv => srv.id !== id);
          const switchedAway = s.activeServerId === id;
          const { [id]: _r, ...entityRatingRest } = s.entityRatingSupportByServer;
          const { [id]: _a, ...audiomuseRest } = s.audiomuseNavidromeByServer;
          const { [id]: _idn, ...identityRest } = s.subsonicServerIdentityByServer;
          const { [id]: _iss, ...issueRest } = s.audiomuseNavidromeIssueByServer;
          const { [id]: _pr, ...probeRest } = s.instantMixProbeByServer;
          return {
            servers: newServers,
            activeServerId: switchedAway ? (newServers[0]?.id ?? null) : s.activeServerId,
            isLoggedIn: switchedAway ? false : s.isLoggedIn,
            entityRatingSupportByServer: entityRatingRest,
            audiomuseNavidromeByServer: audiomuseRest,
            subsonicServerIdentityByServer: identityRest,
            audiomuseNavidromeIssueByServer: issueRest,
            instantMixProbeByServer: probeRest,
          };
        });
      },

      setActiveServer: (id) => set({ activeServerId: id, musicFolders: [] }),

      setLoggedIn: (v) => set({ isLoggedIn: v }),
      setConnecting: (v) => set({ isConnecting: v }),
      setConnectionError: (e) => set({ connectionError: e }),

      setLastfm: (apiKey, apiSecret, sessionKey, username) =>
        set({ lastfmApiKey: apiKey, lastfmApiSecret: apiSecret, lastfmSessionKey: sessionKey, lastfmUsername: username }),

      connectLastfm: (sessionKey, username) =>
        set({ lastfmSessionKey: sessionKey, lastfmUsername: username }),

      disconnectLastfm: () =>
        set({ lastfmSessionKey: '', lastfmUsername: '', lastfmSessionError: false }),

      setLastfmSessionError: (v) => set({ lastfmSessionError: v }),

      setScrobblingEnabled: (v) => set({ scrobblingEnabled: v }),
      setMaxCacheMb: (v) => set({ maxCacheMb: v }),
      setDownloadFolder: (v) => set({ downloadFolder: v }),
      setOfflineDownloadDir: (v) => set({ offlineDownloadDir: v }),
      setExcludeAudiobooks: (v) => set({ excludeAudiobooks: v }),
      setCustomGenreBlacklist: (v) => set({ customGenreBlacklist: v }),
      setReplayGainEnabled: (v) => {
        set({ replayGainEnabled: v });
        usePlayerStore.getState().updateReplayGainForCurrentTrack();
      },
      setReplayGainMode: (v) => {
        set({ replayGainMode: v });
        usePlayerStore.getState().updateReplayGainForCurrentTrack();
      },
      setReplayGainPreGainDb: (v) => {
        set({ replayGainPreGainDb: v });
        usePlayerStore.getState().updateReplayGainForCurrentTrack();
      },
      setReplayGainFallbackDb: (v) => {
        set({ replayGainFallbackDb: v });
        usePlayerStore.getState().updateReplayGainForCurrentTrack();
      },
      setCrossfadeEnabled: (v) => set({ crossfadeEnabled: v }),
      setCrossfadeSecs: (v) => set({ crossfadeSecs: v }),
      setGaplessEnabled: (v) => set({ gaplessEnabled: v }),
      setPreloadMode: (v: 'off' | 'balanced' | 'early' | 'custom') => set({ preloadMode: v }),
      setPreloadCustomSeconds: (v: number) => set({ preloadCustomSeconds: v }),
      setInfiniteQueueEnabled: (v) => set({ infiniteQueueEnabled: v }),
      setShowArtistImages: (v) => set({ showArtistImages: v }),
      setShowTrayIcon: (v) => set({ showTrayIcon: v }),
      setMinimizeToTray: (v) => set({ minimizeToTray: v }),
      setDiscordRichPresence: (v) => set({ discordRichPresence: v }),
      setEnableAppleMusicCoversDiscord: (v) => set({ enableAppleMusicCoversDiscord: v }),
      setDiscordTemplateDetails: (v) => set({ discordTemplateDetails: v }),
      setDiscordTemplateState: (v) => set({ discordTemplateState: v }),
      setDiscordTemplateLargeText: (v) => set({ discordTemplateLargeText: v }),
      setUseCustomTitlebar: (v) => set({ useCustomTitlebar: v }),
      setPreloadMiniPlayer: (v) => set({ preloadMiniPlayer: v }),
      setLinuxWebkitKineticScroll: (v) => set({ linuxWebkitKineticScroll: v }),
      setLoggingMode: (v) => set({ loggingMode: v }),
      setNowPlayingEnabled: (v) => set({ nowPlayingEnabled: v }),
      setLyricsServerFirst: (v: boolean) => set({ lyricsServerFirst: v }),
      setEnableNeteaselyrics: (v: boolean) => set({ enableNeteaselyrics: v }),
      setLyricsSources: (sources) => set({ lyricsSources: sources }),
      setLyricsMode: (v) => set({ lyricsMode: v }),
      setLyricsStaticOnly: (v) => set({ lyricsStaticOnly: v }),
      setShowFullscreenLyrics: (v: boolean) => set({ showFullscreenLyrics: v }),
      setFsLyricsStyle: (v) => set({ fsLyricsStyle: v }),
      setSidebarLyricsStyle: (v) => set({ sidebarLyricsStyle: v }),
      setShowFsArtistPortrait: (v: boolean) => set({ showFsArtistPortrait: v }),
      setFsPortraitDim: (v: number) => set({ fsPortraitDim: v }),
      setShowChangelogOnUpdate: (v) => set({ showChangelogOnUpdate: v }),
      setLastSeenChangelogVersion: (v) => set({ lastSeenChangelogVersion: v }),

      setSeekbarStyle: (v) => set({ seekbarStyle: v }),
      setEnableHiRes: (v) => set({ enableHiRes: v }),
      setAudioOutputDevice: (v) => set({ audioOutputDevice: v }),
      setHotCacheEnabled: (v) => set({ hotCacheEnabled: v }),
      setHotCacheMaxMb: (v) => set({ hotCacheMaxMb: v }),
      setHotCacheDebounceSec: (v) => set({ hotCacheDebounceSec: v }),
      setHotCacheDownloadDir: (v) => set({ hotCacheDownloadDir: v }),

      setSkipStarOnManualSkipsEnabled: (v) =>
        set({
          skipStarOnManualSkipsEnabled: v,
          ...(v ? {} : { skipStarManualSkipCountsByKey: {} }),
        }),
      setSkipStarManualSkipThreshold: (v) => set({ skipStarManualSkipThreshold: clampSkipStarThreshold(v) }),

      recordSkipStarManualAdvance: (trackId: string) => {
        const s = get();
        if (!s.skipStarOnManualSkipsEnabled || s.skipStarManualSkipThreshold < 1) return null;
        const key = skipStarCountStorageKey(s.activeServerId, trackId);
        const prev = s.skipStarManualSkipCountsByKey[key] ?? 0;
        const threshold = s.skipStarManualSkipThreshold;
        const next = prev + 1;
        if (next >= threshold) {
          const { [key]: _removed, ...rest } = s.skipStarManualSkipCountsByKey;
          set({ skipStarManualSkipCountsByKey: rest });
          return { crossedThreshold: true };
        }
        set({
          skipStarManualSkipCountsByKey: { ...s.skipStarManualSkipCountsByKey, [key]: next },
        });
        return { crossedThreshold: false };
      },

      clearSkipStarManualCountForTrack: (trackId: string) => {
        const s = get();
        const key = skipStarCountStorageKey(s.activeServerId, trackId);
        if (s.skipStarManualSkipCountsByKey[key] === undefined) return;
        const { [key]: _removed, ...rest } = s.skipStarManualSkipCountsByKey;
        set({ skipStarManualSkipCountsByKey: rest });
      },

      setMixMinRatingFilterEnabled: (v) => set({ mixMinRatingFilterEnabled: v }),
      setMixMinRatingSong: (v) => set({ mixMinRatingSong: clampMixFilterMinStars(v) }),
      setMixMinRatingAlbum: (v) => set({ mixMinRatingAlbum: clampMixFilterMinStars(v) }),
      setMixMinRatingArtist: (v) => set({ mixMinRatingArtist: clampMixFilterMinStars(v) }),
      setRandomNavMode: (v) => set({ randomNavMode: v }),

      setMusicFolders: (folders) => {
        const sid = get().activeServerId;
        set(s => {
          const f = sid ? s.musicLibraryFilterByServer[sid] : undefined;
          const invalidFilter = f && f !== 'all' && !folders.some(x => x.id === f);
          return {
            musicFolders: folders,
            ...(sid && invalidFilter
              ? { musicLibraryFilterByServer: { ...s.musicLibraryFilterByServer, [sid]: 'all' } }
              : {}),
          };
        });
      },

      setMusicLibraryFilter: (folderId) => {
        const sid = get().activeServerId;
        if (!sid) return;
        set(s => ({
          musicLibraryFilterByServer: { ...s.musicLibraryFilterByServer, [sid]: folderId },
          musicLibraryFilterVersion: s.musicLibraryFilterVersion + 1,
        }));
      },

      setEntityRatingSupport: (serverId, level) =>
        set(s => ({
          entityRatingSupportByServer: { ...s.entityRatingSupportByServer, [serverId]: level },
        })),

      setAudiomuseNavidromeEnabled: (serverId, enabled) =>
        set(s => {
          const audiomuseNavidromeByServer = enabled
            ? { ...s.audiomuseNavidromeByServer, [serverId]: true }
            : (() => {
                const { [serverId]: _removed, ...rest } = s.audiomuseNavidromeByServer;
                return rest;
              })();
          const { [serverId]: _issueRm, ...issueRest } = s.audiomuseNavidromeIssueByServer;
          return { audiomuseNavidromeByServer, audiomuseNavidromeIssueByServer: issueRest };
        }),

      setSubsonicServerIdentity: (serverId, identity) =>
        set(s => {
          const subsonicServerIdentityByServer = { ...s.subsonicServerIdentityByServer, [serverId]: { ...identity } };
          if (!isNavidromeAudiomuseSoftwareEligible(identity)) {
            const { [serverId]: _a, ...audiomuseRest } = s.audiomuseNavidromeByServer;
            const { [serverId]: _i, ...issueRest } = s.audiomuseNavidromeIssueByServer;
            const { [serverId]: _p, ...probeRest } = s.instantMixProbeByServer;
            return {
              subsonicServerIdentityByServer,
              audiomuseNavidromeByServer: audiomuseRest,
              audiomuseNavidromeIssueByServer: issueRest,
              instantMixProbeByServer: probeRest,
            };
          }
          return { subsonicServerIdentityByServer };
        }),

      setInstantMixProbe: (serverId, result) =>
        set(s => {
          const instantMixProbeByServer = { ...s.instantMixProbeByServer, [serverId]: result };
          if (result === 'empty') {
            const { [serverId]: _a, ...audiomuseRest } = s.audiomuseNavidromeByServer;
            const { [serverId]: _i, ...issueRest } = s.audiomuseNavidromeIssueByServer;
            return {
              instantMixProbeByServer,
              audiomuseNavidromeByServer: audiomuseRest,
              audiomuseNavidromeIssueByServer: issueRest,
            };
          }
          return { instantMixProbeByServer };
        }),

      setAudiomuseNavidromeIssue: (serverId, hasIssue) =>
        set(s =>
          hasIssue
            ? { audiomuseNavidromeIssueByServer: { ...s.audiomuseNavidromeIssueByServer, [serverId]: true } }
            : (() => {
                const { [serverId]: _rm, ...rest } = s.audiomuseNavidromeIssueByServer;
                return { audiomuseNavidromeIssueByServer: rest };
              })(),
        ),

      logout: () => set({ isLoggedIn: false, musicFolders: [] }),

      getBaseUrl: () => {
        const s = get();
        const server = s.servers.find(srv => srv.id === s.activeServerId);
        if (!server?.url) return '';
        const base = server.url.startsWith('http') ? server.url : `http://${server.url}`;
        return base.replace(/\/$/, '');
      },

      getActiveServer: () => {
        const s = get();
        return s.servers.find(srv => srv.id === s.activeServerId);
      },
    }),
    {
      name: 'psysonic-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: state => {
        const { musicFolders: _mf, musicLibraryFilterVersion: _fv, ...rest } = state;
        return rest;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        // If both hot cache and preload were enabled before mutual exclusion was enforced, reset both.
        const conflictingLegacyState =
          state.hotCacheEnabled && state.preloadMode !== 'off'
            ? { hotCacheEnabled: false, preloadMode: 'off' as const }
            : {};

        // Migrate lyricsServerFirst + enableNeteaselyrics → lyricsSources (one-time).
        let lyricsSourcesMigrated: { lyricsSources?: LyricsSourceConfig[] } = {};
        try {
          const raw = JSON.parse(localStorage.getItem('psysonic-auth') ?? '{}') as { state?: Record<string, unknown> };
          if (!raw?.state?.lyricsSources) {
            const serverFirst = (raw?.state?.lyricsServerFirst as boolean | undefined) ?? true;
            const neteaseOn   = (raw?.state?.enableNeteaselyrics as boolean | undefined) ?? false;
            const migrated: LyricsSourceConfig[] = serverFirst
              ? [{ id: 'server', enabled: true }, { id: 'lrclib', enabled: true }, { id: 'netease', enabled: neteaseOn }]
              : [{ id: 'lrclib', enabled: true }, { id: 'server', enabled: true }, { id: 'netease', enabled: neteaseOn }];
            lyricsSourcesMigrated = { lyricsSources: migrated };
          }
        } catch { /* ignore */ }

        // One-time: older builds could persist smooth=false as the default. Force smooth on once
        // so updates do not leave users on discrete scrolling; after this flag exists, only an
        // explicit toggle in Settings may turn it off (persisted in psysonic-auth).
        const wheelSmoothMigrationKey = 'psysonic-linux-webkit-smooth-v1';
        let wheelSmoothOneTime: { linuxWebkitKineticScroll?: boolean } = {};
        if (IS_LINUX) {
          try {
            if (!localStorage.getItem(wheelSmoothMigrationKey)) {
              wheelSmoothOneTime = { linuxWebkitKineticScroll: true };
              localStorage.setItem(wheelSmoothMigrationKey, '1');
            }
          } catch { /* ignore */ }
        }

        useAuthStore.setState({
          mixMinRatingSong: clampMixFilterMinStars(state.mixMinRatingSong as number),
          mixMinRatingAlbum: clampMixFilterMinStars(state.mixMinRatingAlbum as number),
          mixMinRatingArtist: clampMixFilterMinStars(state.mixMinRatingArtist as number),
          skipStarManualSkipCountsByKey: sanitizeSkipStarCounts(
            (state as { skipStarManualSkipCountsByKey?: unknown }).skipStarManualSkipCountsByKey,
          ),
          ...conflictingLegacyState,
          ...lyricsSourcesMigrated,
          ...wheelSmoothOneTime,
        });
      },
    }
  )
);
