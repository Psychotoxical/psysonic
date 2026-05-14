import type { ColDef } from '../useTracklistColumns';

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function codecLabel(song: { suffix?: string; bitRate?: number }, showBitrate: boolean): string {
  const parts: string[] = [];
  if (song.suffix) parts.push(song.suffix.toUpperCase());
  if (showBitrate && song.bitRate) parts.push(`${song.bitRate} kbps`);
  return parts.join(' · ');
}

export const COLUMNS: readonly ColDef[] = [
  { key: 'num',      i18nKey: null,            minWidth: 60,  defaultWidth: 60,  required: true  },
  { key: 'title',    i18nKey: 'trackTitle',    minWidth: 150, defaultWidth: 0,   required: true,  flex: true },
  { key: 'artist',   i18nKey: 'trackArtist',   minWidth: 80,  defaultWidth: 180, required: false },
  { key: 'favorite', i18nKey: 'trackFavorite', minWidth: 50,  defaultWidth: 70,  required: false },
  { key: 'rating',   i18nKey: 'trackRating',   minWidth: 80,  defaultWidth: 120, required: false },
  { key: 'duration', i18nKey: 'trackDuration', minWidth: 72,  defaultWidth: 92,  required: false },
  { key: 'format',   i18nKey: 'trackFormat',   minWidth: 60,  defaultWidth: 90,  required: false },
  { key: 'genre',    i18nKey: 'trackGenre',    minWidth: 60,  defaultWidth: 90,  required: false },
];

export type ColKey = 'num' | 'title' | 'artist' | 'favorite' | 'rating' | 'duration' | 'format' | 'genre';

export const CENTERED_COLS = new Set<ColKey>(['favorite', 'rating', 'duration']);

export type SortKey = 'natural' | 'title' | 'artist' | 'album' | 'favorite' | 'rating' | 'duration';

export const SORTABLE_COLS = new Set<ColKey | 'album'>(['title', 'artist', 'album', 'favorite', 'rating', 'duration']);

export function isSortable(key: ColKey | string): key is SortKey {
  return SORTABLE_COLS.has(key as ColKey);
}
