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

export const DEFAULT_LYRICS_SOURCES: LyricsSourceConfig[] = [
  { id: 'server',  enabled: true  },
  { id: 'lrclib',  enabled: true  },
  { id: 'netease', enabled: false },
];

/** Upper bound for mix min-rating thresholds (UI shows five stars, only 1…this many are selectable). */
export const MIX_MIN_RATING_FILTER_MAX_STARS = 3;

export const RANDOM_MIX_SIZE_OPTIONS: readonly number[] = [50, 75, 100, 125, 150];
