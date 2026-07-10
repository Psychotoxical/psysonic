/**
 * LRC parsing, shared by every provider that hands us an LRC string (embedded
 * file tags, LRCLIB, Netease).
 *
 * Enhanced LRC ("ELRC") carries per-word timing as inline `<mm:ss.xx>` markers
 * after the line timestamp:
 *
 *     [00:12.00]<00:12.00>Hello <00:12.90>world
 *
 * The markers must never reach the rendered text, and where they exist they can
 * drive the same word-by-word highlighting as the server's `songLyrics` v2 cues.
 */
import type { LrcLine, WordLyricsLine, WordLyricsWord } from '@/features/lyrics/types';

/** `[mm:ss]`, `[mm:ss.x]`, `[mm:ss.xx]`, `[mm:ss.xxx]` — the leading line stamp. */
const LINE_STAMP = /^\[(\d+):(\d+(?:\.\d*)?)\](.*)/;
/** `<mm:ss.xx>` — an inline word stamp (Enhanced LRC). */
const WORD_STAMP = /<(\d+):(\d+(?:\.\d*)?)>/g;

function toSeconds(minutes: string, seconds: string): number {
  return parseInt(minutes, 10) * 60 + parseFloat(seconds);
}

interface ScannedLine {
  time: number;
  text: string;
  /** Word stamps in source order; empty for a plain (non-enhanced) line. */
  cues: { time: number; text: string }[];
}

/**
 * Split one LRC body line into its timestamp, its marker-free text, and any
 * inline word cues. Text before the first word stamp has no timing of its own,
 * so it is folded into the first cue.
 */
function scanLine(line: string): ScannedLine | null {
  const stamp = line.match(LINE_STAMP);
  if (!stamp) return null;
  const time = toSeconds(stamp[1], stamp[2]);
  const rest = stamp[3];

  const cues: { time: number; text: string }[] = [];
  let plain = '';
  let cursor = 0;
  WORD_STAMP.lastIndex = 0;
  for (let m = WORD_STAMP.exec(rest); m !== null; m = WORD_STAMP.exec(rest)) {
    const between = rest.slice(cursor, m.index);
    plain += between;
    if (cues.length === 0) {
      // Leading text before the first marker carries no timing of its own.
      cues.push({ time: toSeconds(m[1], m[2]), text: between });
    } else {
      cues[cues.length - 1].text += between;
      cues.push({ time: toSeconds(m[1], m[2]), text: '' });
    }
    cursor = m.index + m[0].length;
  }
  const tail = rest.slice(cursor);
  plain += tail;
  if (cues.length > 0) cues[cues.length - 1].text += tail;

  return { time, text: plain.trim(), cues };
}

function scan(lrc: string): ScannedLine[] {
  const scanned: ScannedLine[] = [];
  for (const line of lrc.split('\n')) {
    const parsed = scanLine(line);
    if (parsed) scanned.push(parsed);
  }
  return scanned.sort((a, b) => a.time - b.time);
}

/**
 * Timed lines with the text stripped of any inline word markers.
 * Unstamped lines (metadata headers, blanks) are dropped.
 */
export function parseLrc(lrc: string): LrcLine[] {
  return scan(lrc).map(({ time, text }) => ({ time, text }));
}

export interface ParsedLrc {
  lines: LrcLine[];
  /** Null unless at least one line carries inline word markers. */
  wordLines: WordLyricsLine[] | null;
}

/**
 * Parse an LRC string once into both line-level and (when present) word-level
 * timing. A line without markers becomes a single full-line word, so enabling
 * word mode never drops a line from the pane.
 *
 * The last word of a line and the line itself end at the next line's start —
 * ELRC has no explicit end marker.
 */
export function parseEnhancedLrc(lrc: string): ParsedLrc {
  const scanned = scan(lrc);
  const lines: LrcLine[] = scanned.map(({ time, text }) => ({ time, text }));
  if (!scanned.some(line => line.cues.length > 0)) return { lines, wordLines: null };

  const wordLines = scanned.map((line, i) => {
    const nextStart = scanned[i + 1]?.time;
    const lineEnd = nextStart ?? line.time;
    const cues = line.cues.length > 0
      ? line.cues
      : [{ time: line.time, text: line.text }];

    const words: WordLyricsWord[] = cues.map((cue, j) => {
      const end = cues[j + 1]?.time ?? lineEnd;
      return { text: cue.text, time: cue.time, duration: Math.max(0, end - cue.time) };
    });

    return {
      time: line.time,
      duration: Math.max(0, lineEnd - line.time),
      text: line.text,
      words,
    };
  });

  return { lines, wordLines };
}
