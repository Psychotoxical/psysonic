import { TRACK_TITLE_FLEX_COL, type ColDef } from '@/lib/hooks/useTracklistColumns';

/**
 * Columns of the artist's full track list.
 *
 * Labels reuse the `albumDetail.track*` keys every other tracklist already uses,
 * so a column reads the same wherever it appears. `album` carries its weight here
 * in a way it never does on an album page: the list spans the whole discography,
 * so the record a track comes from is the main orientation and stays required.
 *
 * Star and rating are deliberately absent — both write to the server, which needs
 * handlers and optimistic state this read-only list does not have.
 */
export const ARTIST_ALL_TRACKS_COLUMNS: readonly ColDef[] = [
  { key: 'num',        i18nKey: null,              minWidth: 60,  defaultWidth: 60,  required: true  },
  { key: 'title',      i18nKey: 'trackTitle',      ...TRACK_TITLE_FLEX_COL, required: true },
  { key: 'album',      i18nKey: 'trackAlbum',      minWidth: 80,  defaultWidth: 200, required: true  },
  { key: 'duration',   i18nKey: 'trackDuration',   minWidth: 72,  defaultWidth: 92,  required: false },
  // Off by default — on an artist page the performer repeats down the whole
  // column, and it only says something on compilations and guest spots.
  { key: 'artist',     i18nKey: 'trackArtist',     minWidth: 80,  defaultWidth: 180, required: false, defaultHidden: true },
  // The rest are available but off, so the opening view fits the page width;
  // showing all of them at once overflows the artist page's content column.
  { key: 'format',     i18nKey: 'trackFormat',     minWidth: 60,  defaultWidth: 90,  required: false, defaultHidden: true },
  { key: 'genre',      i18nKey: 'trackGenre',      minWidth: 60,  defaultWidth: 90,  required: false, defaultHidden: true },
  { key: 'year',       i18nKey: 'trackYear',       minWidth: 60,  defaultWidth: 80,  required: false, defaultHidden: true },
  { key: 'playCount',  i18nKey: 'trackPlayCount',  minWidth: 60,  defaultWidth: 80,  required: false, defaultHidden: true },
  { key: 'lastPlayed', i18nKey: 'trackLastPlayed', minWidth: 90,  defaultWidth: 130, required: false, defaultHidden: true },
  { key: 'bpm',        i18nKey: 'trackBpm',        minWidth: 50,  defaultWidth: 70,  required: false, defaultHidden: true },
];

export type ArtistAllTracksColKey =
  | 'num' | 'title' | 'album' | 'artist' | 'duration'
  | 'format' | 'genre' | 'year' | 'playCount' | 'lastPlayed' | 'bpm';

/** Columns whose content is centred rather than left-aligned, as elsewhere. */
export const ARTIST_ALL_TRACKS_CENTERED_COLS = new Set<ArtistAllTracksColKey>([
  'duration', 'year', 'playCount', 'bpm',
]);

/** Persisted separately from the album tracklist so the two layouts stay independent. */
export const ARTIST_ALL_TRACKS_STORAGE_KEY = 'psysonic_artist_all_tracks_columns';

export type ArtistAllTracksSortKey =
  | 'natural' | 'title' | 'album' | 'artist' | 'duration' | 'year' | 'playCount' | 'lastPlayed' | 'bpm';

/** Column keys the header offers as a sort control. */
export const ARTIST_ALL_TRACKS_SORTABLE = new Set<string>([
  'title', 'album', 'artist', 'duration', 'year', 'playCount', 'lastPlayed', 'bpm',
]);
