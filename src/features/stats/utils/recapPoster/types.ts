import type { PlaySessionYearRecap, PlaySessionYearSummary } from '@/lib/api/library';
import type { RewindTypeScale } from './tokens';

export type RewindPosterFormat = 'story' | 'square';

/** §6–§9 of the design doc — the four poster layouts. */
export type RewindPosterLayout = 'overview' | 'artist' | 'album' | 'nerd';

/** Localised copy the posters draw. Kept as data so the renderer stays pure. */
export interface RewindStrings {
  kicker: string;
  overviewTitle: string;
  artistTitle: string;
  albumTitle: string;
  nerdTitle: string;
  /** Hero label when the year has ≥1 full hour ("Stunden Musik"). */
  hoursWord: string;
  /** Hero label fallback for a sub-hour year ("Minuten Musik"). */
  minutesWord: string;
  /** Short unit symbols for compact times ("1 h 43 min"). */
  hourUnit: string;
  minuteUnit: string;
  nerdHeroLabel: string;
  statDays: string;
  statPlays: string;
  statNewArtists: string;
  statUniqueTracks: string;
  statSessions: string;
  statListeningTime: string;
  statPlaysShort: string;
  topArtists: string;
  topAlbums: string;
  topTracks: string;
  topGenres: string;
  losslessWord: string;
  losslessSentence: string;
  hourlyHeading: string;
  personaTitle: string | null;
  personaBody: string | null;
  longestSession: string;
  localFirstTitle: string;
  localFirstBody: string;
  privacy: string;
}

export interface RewindData {
  recap: PlaySessionYearRecap;
  summary: PlaySessionYearSummary;
  year: number;
}

/** Everything a layout needs to draw — assembled once by the dispatcher. */
export interface RewindRenderContext {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  format: RewindPosterFormat;
  type: RewindTypeScale;
  strings: RewindStrings;
  data: RewindData;
  /** Deterministic seed for grain/waveform so previews are pixel-stable. */
  seed: number;
  /** Bitmaps by index into `recap.topAlbums`; missing = draw a fallback tile. */
  covers: Map<number, ImageBitmap>;
  wordmark: HTMLImageElement | null;
  pad: number;
  /** Content must stay above this line — the footer band is fixed. */
  contentBottom: number;
}
