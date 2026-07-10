/**
 * Shared lyrics value types. They live here rather than in `hooks/useLyrics`
 * so the cache and the parsers can consume them without importing back into
 * the hook (dependency-cruiser counts type-only edges, and a back-edge would
 * close a cycle).
 */

export type LyricsSource = 'server' | 'lrclib' | 'netease' | 'embedded' | 'lyricsplus';

/** One timed line of lyrics. `time` is seconds. */
export interface LrcLine {
  time: number;
  text: string;
}

/**
 * Karaoke-style word/syllable timing inside a single line.
 * All times are seconds (aligned with `LrcLine.time`), converted from the
 * millisecond-based provider responses.
 */
export interface WordLyricsWord {
  text: string;
  time: number;
  duration: number;
}

export interface WordLyricsLine {
  time: number;
  duration: number;
  text: string;
  words: WordLyricsWord[];
}

export interface CachedLyrics {
  syncedLines: LrcLine[] | null;
  wordLines: WordLyricsLine[] | null;
  plainLyrics: string | null;
  source: LyricsSource | null;
  notFound: boolean;
}
