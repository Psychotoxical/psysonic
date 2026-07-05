import type {
  LoudnessLufsPreset,
  LyricsSourceConfig,
  TrackPreviewLocation,
  TrackPreviewLocations,
} from './authStoreTypes';

export const LOUDNESS_LUFS_PRESETS: LoudnessLufsPreset[] = [-16, -14, -12, -10];

/** Settings default + Rust engine cold default until `audio_set_normalization` runs. */
export const DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB = -4.5;

export const TRACK_PREVIEW_LOCATIONS: readonly TrackPreviewLocation[] = [
  'suggestions',
  'albums',
  'playlists',
  'favorites',
  'artist',
  'randomMix',
];

export const DEFAULT_TRACK_PREVIEW_LOCATIONS: TrackPreviewLocations = {
  suggestions: true,
  albums: true,
  playlists: true,
  favorites: true,
  artist: true,
  randomMix: true,
};

// Fresh installs ship with every lyrics source off (issue #810 — users who
// don't want lyrics get none until they opt in). Existing users keep their
// persisted `lyricsSources`; the rehydrate migration preserves them.
export const DEFAULT_LYRICS_SOURCES: LyricsSourceConfig[] = [
  { id: 'server',  enabled: false },
  { id: 'lrclib',  enabled: false },
  { id: 'netease', enabled: false },
];

/** Upper bound for mix min-rating thresholds (UI shows five stars, only 1…this many are selectable). */
export const MIX_MIN_RATING_FILTER_MAX_STARS = 3;

export const RANDOM_MIX_SIZE_OPTIONS: readonly number[] = [50, 75, 100, 125, 150];

/**
 * Default + clamp bounds for album/artist/playlist card grids (Settings → Library).
 * Defined in lib/util/cardGridLayout (store-free layout math) and re-exported here
 * so the auth-store settings clamp/default and all existing consumers are unchanged.
 */
export {
  DEFAULT_LIBRARY_GRID_MAX_COLUMNS,
  LIBRARY_GRID_MAX_COLUMNS_MIN,
  LIBRARY_GRID_MAX_COLUMNS_MAX,
} from '@/lib/util/cardGridLayout';
