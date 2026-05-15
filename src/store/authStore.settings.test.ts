/**
 * Setter-surface characterization for `authStore`.
 *
 * Pins the setter API so a refactor that renames or removes one of the
 * dozens of `setX: (v) => set({ x: v })` action methods fails loudly.
 * Most setters are trivial; the ones with logic (clamping, validation,
 * transforms, side effects) get a focused test for the non-trivial bit.
 *
 * Phase F2 / PR 3.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/subsonic', () => ({
  savePlayQueue: vi.fn(async () => undefined),
  getPlayQueue: vi.fn(async () => ({ songs: [], current: undefined, position: 0 })),
  buildStreamUrl: vi.fn((id: string) => `https://mock/stream/${id}`),
  buildCoverArtUrl: vi.fn((id: string) => `https://mock/cover/${id}`),
  buildDownloadUrl: vi.fn((id: string) => `https://mock/download/${id}`),
  coverArtCacheKey: vi.fn((id: string, size = 256) => `mock:cover:${id}:${size}`),
  getSong: vi.fn(async () => null),
  getRandomSongs: vi.fn(async () => []),
  getSimilarSongs2: vi.fn(async () => []),
  getTopSongs: vi.fn(async () => []),
  getAlbumInfo2: vi.fn(async () => null),
  reportNowPlaying: vi.fn(async () => undefined),
  scrobbleSong: vi.fn(async () => undefined),
  setRating: vi.fn(async () => undefined),
}));

import { useAuthStore } from './authStore';
import { resetAuthStore, resetPlayerStore } from '@/test/helpers/storeReset';
import { onInvoke } from '@/test/mocks/tauri';
import {
  LIBRARY_GRID_MAX_COLUMNS_MAX,
  LIBRARY_GRID_MAX_COLUMNS_MIN,
} from './authStoreDefaults';

beforeEach(() => {
  resetAuthStore();
  resetPlayerStore();
  onInvoke('audio_update_replay_gain', () => undefined);
  onInvoke('audio_set_normalization', () => undefined);
});

describe('trivial pass-through setters', () => {
  // Quick API-pin sweep. Each setter is `setX: (v) => set({ x: v })` —
  // a refactor that renames a key without renaming the setter (or vice
  // versa) breaks these.
  it.each([
    ['setScrobblingEnabled', 'scrobblingEnabled', false],
    ['setExcludeAudiobooks', 'excludeAudiobooks', true],
    ['setInfiniteQueueEnabled', 'infiniteQueueEnabled', true],
    ['setPreservePlayNextOrder', 'preservePlayNextOrder', true],
    ['setShowArtistImages', 'showArtistImages', true],
    ['setShowTrayIcon', 'showTrayIcon', false],
    ['setMinimizeToTray', 'minimizeToTray', true],
    ['setShowOrbitTrigger', 'showOrbitTrigger', false],
    ['setDiscordRichPresence', 'discordRichPresence', true],
    ['setEnableBandsintown', 'enableBandsintown', true],
    ['setUseCustomTitlebar', 'useCustomTitlebar', true],
    ['setPreloadMiniPlayer', 'preloadMiniPlayer', true],
    ['setLinuxWebkitKineticScroll', 'linuxWebkitKineticScroll', false],
    ['setNowPlayingEnabled', 'nowPlayingEnabled', true],
    ['setShowFullscreenLyrics', 'showFullscreenLyrics', false],
    ['setLyricsStaticOnly', 'lyricsStaticOnly', true],
    ['setShowChangelogOnUpdate', 'showChangelogOnUpdate', false],
    ['setQueueNowPlayingCollapsed', 'queueNowPlayingCollapsed', true],
    ['setQueueDurationDisplayMode', 'queueDurationDisplayMode', 'eta'],
    ['setEnableHiRes', 'enableHiRes', true],
    ['setHotCacheEnabled', 'hotCacheEnabled', true],
    ['setMixMinRatingFilterEnabled', 'mixMinRatingFilterEnabled', true],
    ['setShowLuckyMixMenu', 'showLuckyMixMenu', false],
  ])('%s writes to %s', (setter, key, value) => {
    const setFn = (useAuthStore.getState() as unknown as Record<string, unknown>)[setter];
    expect(typeof setFn).toBe('function');
    (setFn as (v: unknown) => void)(value);
    expect((useAuthStore.getState() as unknown as Record<string, unknown>)[key]).toBe(value);
  });

  it.each([
    ['setMaxCacheMb', 'maxCacheMb', 2048],
    ['setHotCacheMaxMb', 'hotCacheMaxMb', 1024],
    ['setHotCacheDebounceSec', 'hotCacheDebounceSec', 60],
    ['setPreloadCustomSeconds', 'preloadCustomSeconds', 45],
    ['setFsPortraitDim', 'fsPortraitDim', 64],
  ])('%s stores a numeric value', (setter, key, value) => {
    (useAuthStore.getState() as unknown as Record<string, (v: unknown) => void>)[setter](value);
    expect((useAuthStore.getState() as unknown as Record<string, unknown>)[key]).toBe(value);
  });

  it.each([
    ['setDownloadFolder', 'downloadFolder', '/tmp/downloads'],
    ['setOfflineDownloadDir', 'offlineDownloadDir', '/tmp/offline'],
    ['setHotCacheDownloadDir', 'hotCacheDownloadDir', '/tmp/hot'],
    ['setLastSeenChangelogVersion', 'lastSeenChangelogVersion', '1.46.0'],
    ['setDiscordTemplateDetails', 'discordTemplateDetails', '{artist} — {title}'],
    ['setDiscordTemplateState', 'discordTemplateState', '{album}'],
    ['setDiscordTemplateLargeText', 'discordTemplateLargeText', 'Hi'],
  ])('%s stores a string value', (setter, key, value) => {
    (useAuthStore.getState() as unknown as Record<string, (v: unknown) => void>)[setter](value);
    expect((useAuthStore.getState() as unknown as Record<string, unknown>)[key]).toBe(value);
  });
});

describe('setters with validation / clamping', () => {
  it('setTrackPreviewStartRatio clamps to [0, 0.9]', () => {
    useAuthStore.getState().setTrackPreviewStartRatio(1.5);
    expect(useAuthStore.getState().trackPreviewStartRatio).toBe(0.9);

    useAuthStore.getState().setTrackPreviewStartRatio(-0.5);
    expect(useAuthStore.getState().trackPreviewStartRatio).toBe(0);

    useAuthStore.getState().setTrackPreviewStartRatio(0.33);
    expect(useAuthStore.getState().trackPreviewStartRatio).toBe(0.33);
  });

  it('setTrackPreviewDurationSec clamps to [5, 120] and rounds to whole seconds', () => {
    useAuthStore.getState().setTrackPreviewDurationSec(300);
    expect(useAuthStore.getState().trackPreviewDurationSec).toBe(120);

    useAuthStore.getState().setTrackPreviewDurationSec(2);
    expect(useAuthStore.getState().trackPreviewDurationSec).toBe(5);

    useAuthStore.getState().setTrackPreviewDurationSec(30.7);
    expect(useAuthStore.getState().trackPreviewDurationSec).toBe(31);
  });

  it('setLibraryGridMaxColumns clamps to the allowed column range', () => {
    useAuthStore.getState().setLibraryGridMaxColumns(99);
    expect(useAuthStore.getState().libraryGridMaxColumns).toBe(LIBRARY_GRID_MAX_COLUMNS_MAX);

    useAuthStore.getState().setLibraryGridMaxColumns(1);
    expect(useAuthStore.getState().libraryGridMaxColumns).toBe(LIBRARY_GRID_MAX_COLUMNS_MIN);

    useAuthStore.getState().setLibraryGridMaxColumns(6);
    expect(useAuthStore.getState().libraryGridMaxColumns).toBe(6);
  });

  it('setTrackPreviewsEnabled coerces truthy/falsy to boolean', () => {
    useAuthStore.getState().setTrackPreviewsEnabled('yes' as unknown as boolean);
    expect(useAuthStore.getState().trackPreviewsEnabled).toBe(true);

    useAuthStore.getState().setTrackPreviewsEnabled(0 as unknown as boolean);
    expect(useAuthStore.getState().trackPreviewsEnabled).toBe(false);
  });

  it('setTrackPreviewLocation toggles a single location entry by key', () => {
    const before = useAuthStore.getState().trackPreviewLocations;
    const firstKey = Object.keys(before)[0] as keyof typeof before;
    useAuthStore.getState().setTrackPreviewLocation(firstKey, !before[firstKey]);
    expect(useAuthStore.getState().trackPreviewLocations[firstKey]).toBe(!before[firstKey]);
  });

  it('setLoudnessPreAnalysisAttenuationDb rejects non-finite input', () => {
    const before = useAuthStore.getState().loudnessPreAnalysisAttenuationDb;
    useAuthStore.getState().setLoudnessPreAnalysisAttenuationDb(Number.NaN);
    expect(useAuthStore.getState().loudnessPreAnalysisAttenuationDb).toBe(before);

    useAuthStore.getState().setLoudnessPreAnalysisAttenuationDb(Number.POSITIVE_INFINITY);
    expect(useAuthStore.getState().loudnessPreAnalysisAttenuationDb).toBe(before);
  });

  it('resetLoudnessPreAnalysisAttenuationDbDefault restores the canonical default', () => {
    useAuthStore.getState().setLoudnessPreAnalysisAttenuationDb(-2);
    useAuthStore.getState().resetLoudnessPreAnalysisAttenuationDbDefault();
    expect(useAuthStore.getState().loudnessPreAnalysisAttenuationDb).toBe(-4.5);
  });
});

describe('replay-gain related setters (write through to player store)', () => {
  it('setReplayGainEnabled writes the flag (and pings updateReplayGainForCurrentTrack)', () => {
    useAuthStore.getState().setReplayGainEnabled(true);
    expect(useAuthStore.getState().replayGainEnabled).toBe(true);
    useAuthStore.getState().setReplayGainEnabled(false);
    expect(useAuthStore.getState().replayGainEnabled).toBe(false);
  });

  it('setNormalizationEngine accepts off / replaygain / loudness', () => {
    useAuthStore.getState().setNormalizationEngine('replaygain');
    expect(useAuthStore.getState().normalizationEngine).toBe('replaygain');
    useAuthStore.getState().setNormalizationEngine('loudness');
    expect(useAuthStore.getState().normalizationEngine).toBe('loudness');
    useAuthStore.getState().setNormalizationEngine('off');
    expect(useAuthStore.getState().normalizationEngine).toBe('off');
  });

  it('setReplayGainMode supports track / album / auto', () => {
    useAuthStore.getState().setReplayGainMode('track');
    expect(useAuthStore.getState().replayGainMode).toBe('track');
    useAuthStore.getState().setReplayGainMode('album');
    expect(useAuthStore.getState().replayGainMode).toBe('album');
    useAuthStore.getState().setReplayGainMode('auto');
    expect(useAuthStore.getState().replayGainMode).toBe('auto');
  });

  it('setReplayGainPreGainDb / setReplayGainFallbackDb store dB values', () => {
    useAuthStore.getState().setReplayGainPreGainDb(-3);
    useAuthStore.getState().setReplayGainFallbackDb(-7);
    expect(useAuthStore.getState().replayGainPreGainDb).toBe(-3);
    expect(useAuthStore.getState().replayGainFallbackDb).toBe(-7);
  });

  it('setLoudnessTargetLufs stores the target', () => {
    useAuthStore.getState().setLoudnessTargetLufs(-14);
    expect(useAuthStore.getState().loudnessTargetLufs).toBe(-14);
  });
});

describe('preload mode + discord cover source setters', () => {
  it('setPreloadMode accepts off / balanced / early / custom', () => {
    for (const mode of ['off', 'balanced', 'early', 'custom'] as const) {
      useAuthStore.getState().setPreloadMode(mode);
      expect(useAuthStore.getState().preloadMode).toBe(mode);
    }
  });

  it('setDiscordCoverSource accepts none / apple / server', () => {
    for (const src of ['none', 'apple', 'server'] as const) {
      useAuthStore.getState().setDiscordCoverSource(src);
      expect(useAuthStore.getState().discordCoverSource).toBe(src);
    }
  });

  it('setLoggingMode accepts off / normal / debug', () => {
    for (const mode of ['off', 'normal', 'debug'] as const) {
      useAuthStore.getState().setLoggingMode(mode);
      expect(useAuthStore.getState().loggingMode).toBe(mode);
    }
  });
});

describe('per-server bookkeeping setters', () => {
  it('setEntityRatingSupport scopes the value to the given serverId', () => {
    useAuthStore.getState().setEntityRatingSupport('srv-1', 'full');
    useAuthStore.getState().setEntityRatingSupport('srv-2', 'track_only');
    expect(useAuthStore.getState().entityRatingSupportByServer).toEqual({
      'srv-1': 'full',
      'srv-2': 'track_only',
    });
  });

  it('setAudiomuseNavidromeEnabled adds positive opt-ins and removes disabled entries', () => {
    useAuthStore.getState().setAudiomuseNavidromeEnabled('srv-1', true);
    useAuthStore.getState().setAudiomuseNavidromeEnabled('srv-2', true);
    expect(useAuthStore.getState().audiomuseNavidromeByServer).toEqual({
      'srv-1': true,
      'srv-2': true,
    });

    // Disabling removes the entry rather than storing `false` — the map
    // tracks positive opt-ins only.
    useAuthStore.getState().setAudiomuseNavidromeEnabled('srv-1', false);
    expect(useAuthStore.getState().audiomuseNavidromeByServer).toEqual({
      'srv-2': true,
    });
  });

  it('setAudiomuseNavidromeIssue scopes by serverId', () => {
    useAuthStore.getState().setAudiomuseNavidromeIssue('srv-1', true);
    expect(useAuthStore.getState().audiomuseNavidromeIssueByServer).toEqual({
      'srv-1': true,
    });
  });
});

describe('genre blacklist + audio output device', () => {
  it('setCustomGenreBlacklist replaces the list', () => {
    useAuthStore.getState().setCustomGenreBlacklist(['Audiobook', 'Podcast']);
    expect(useAuthStore.getState().customGenreBlacklist).toEqual(['Audiobook', 'Podcast']);

    useAuthStore.getState().setCustomGenreBlacklist([]);
    expect(useAuthStore.getState().customGenreBlacklist).toEqual([]);
  });

  it('setAudioOutputDevice stores the device id or null', () => {
    useAuthStore.getState().setAudioOutputDevice('hw:0,0');
    expect(useAuthStore.getState().audioOutputDevice).toBe('hw:0,0');

    useAuthStore.getState().setAudioOutputDevice(null);
    expect(useAuthStore.getState().audioOutputDevice).toBeNull();
  });
});

describe('lyrics source setters', () => {
  it('setLyricsSources replaces the source list verbatim', () => {
    const sources = [
      { id: 'lrclib' as const, enabled: true },
      { id: 'server' as const, enabled: false },
      { id: 'netease' as const, enabled: true },
    ];
    useAuthStore.getState().setLyricsSources(sources);
    expect(useAuthStore.getState().lyricsSources).toEqual(sources);
  });

  it('setLyricsMode + setFsLyricsStyle + setSidebarLyricsStyle write enum values through', () => {
    useAuthStore.getState().setLyricsMode('lyricsplus');
    expect(useAuthStore.getState().lyricsMode).toBe('lyricsplus');

    useAuthStore.getState().setFsLyricsStyle('apple');
    expect(useAuthStore.getState().fsLyricsStyle).toBe('apple');

    useAuthStore.getState().setSidebarLyricsStyle('apple');
    expect(useAuthStore.getState().sidebarLyricsStyle).toBe('apple');
  });
});

describe('mix filter setters — clamp to allowed range', () => {
  it('setMixMinRatingSong / Album / Artist clamp out-of-range stars', () => {
    useAuthStore.getState().setMixMinRatingSong(10);
    useAuthStore.getState().setMixMinRatingAlbum(-3);
    useAuthStore.getState().setMixMinRatingArtist(0);
    const s = useAuthStore.getState();
    // The clamp function bounds to 0–5; values outside that range get pulled in.
    expect(s.mixMinRatingSong).toBeGreaterThanOrEqual(0);
    expect(s.mixMinRatingSong).toBeLessThanOrEqual(5);
    expect(s.mixMinRatingAlbum).toBeGreaterThanOrEqual(0);
    expect(s.mixMinRatingAlbum).toBeLessThanOrEqual(5);
    expect(s.mixMinRatingArtist).toBeGreaterThanOrEqual(0);
    expect(s.mixMinRatingArtist).toBeLessThanOrEqual(5);
  });

  it('setRandomMixSize clamps to a sensible range', () => {
    useAuthStore.getState().setRandomMixSize(10_000);
    const huge = useAuthStore.getState().randomMixSize;
    expect(huge).toBeLessThan(10_000);

    useAuthStore.getState().setRandomMixSize(-5);
    expect(useAuthStore.getState().randomMixSize).toBeGreaterThanOrEqual(0);
  });
});
