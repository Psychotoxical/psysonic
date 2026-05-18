import type { ColDef } from '../useTracklistColumns';

export function codecLabel(song: { suffix?: string; bitRate?: number }, showBitrate: boolean): string {
  const parts: string[] = [];
  if (song.suffix) parts.push(song.suffix.toUpperCase());
  if (showBitrate && song.bitRate) parts.push(`${song.bitRate} kbps`);
  return parts.join(' · ');
}

export const COLUMNS: readonly ColDef[] = [
  { key: 'num',        i18nKey: null,              minWidth: 60,  defaultWidth: 60,  required: true  },
  { key: 'title',      i18nKey: 'trackTitle',      minWidth: 150, defaultWidth: 0,   required: true,  flex: true },
  { key: 'artist',     i18nKey: 'trackArtist',     minWidth: 80,  defaultWidth: 180, required: false },
  { key: 'favorite',   i18nKey: 'trackFavorite',   minWidth: 50,  defaultWidth: 70,  required: false },
  { key: 'rating',     i18nKey: 'trackRating',     minWidth: 80,  defaultWidth: 120, required: false },
  { key: 'duration',   i18nKey: 'trackDuration',   minWidth: 72,  defaultWidth: 92,  required: false },
  { key: 'format',     i18nKey: 'trackFormat',     minWidth: 60,  defaultWidth: 90,  required: false },
  { key: 'genre',      i18nKey: 'trackGenre',      minWidth: 60,  defaultWidth: 90,  required: false },
  { key: 'playCount',  i18nKey: 'trackPlayCount', minWidth: 60,  defaultWidth: 80,  required: false },
  { key: 'lastPlayed', i18nKey: 'trackLastPlayed', minWidth: 90,  defaultWidth: 130, required: false },
  { key: 'bpm',        i18nKey: 'trackBpm',        minWidth: 50,  defaultWidth: 70,  required: false },
];

export type ColKey = 'num' | 'title' | 'artist' | 'favorite' | 'rating' | 'duration' | 'format' | 'genre' | 'playCount' | 'lastPlayed' | 'bpm';

export const CENTERED_COLS = new Set<ColKey>(['favorite', 'rating', 'duration', 'playCount', 'bpm']);

export type SortKey = 'natural' | 'title' | 'artist' | 'album' | 'favorite' | 'rating' | 'duration' | 'playCount' | 'lastPlayed' | 'bpm';

export const SORTABLE_COLS = new Set<ColKey | 'album'>(['title', 'artist', 'album', 'favorite', 'rating', 'duration', 'playCount', 'lastPlayed', 'bpm']);

export function isSortable(key: ColKey | string): key is SortKey {
  return SORTABLE_COLS.has(key as ColKey);
}
