/**
 * Adapters from the OpenSubsonic `getLyricsBySongId` response to the shapes the
 * lyrics pane renders. Pure — every timing decision is made here so the fetch
 * hook stays a pipeline.
 *
 * Server timings are milliseconds; `LrcLine` / `WordLyricsLine` are seconds.
 */
import type {
  SubsonicLyricCueLine,
  SubsonicStructuredLyrics,
} from '@/lib/api/subsonicTypes';
import type { CachedLyrics, LrcLine, WordLyricsLine, WordLyricsWord } from '@/features/lyrics/types';

const MS_PER_SECOND = 1000;

function isSyncedLyrics(lyrics: SubsonicStructuredLyrics): boolean {
  // Accept both `synced` (OpenSubsonic spec) and `issynced` (legacy servers).
  return !!(lyrics.synced ?? lyrics.issynced);
}

/** Convert structured Subsonic lyrics (ms timestamps) into LrcLine[] or plain text. */
export function parseStructuredLyrics(
  lyrics: SubsonicStructuredLyrics,
): Pick<CachedLyrics, 'syncedLines' | 'plainLyrics'> {
  if (isSyncedLyrics(lyrics) && lyrics.line.length > 0) {
    const lines: LrcLine[] = lyrics.line
      .filter(l => l.start !== undefined)
      .map(l => ({ time: l.start! / MS_PER_SECOND, text: l.value.trim() }))
      .sort((a, b) => a.time - b.time);
    if (lines.length > 0) return { syncedLines: lines, plainLyrics: null };
  }
  const plain = lyrics.line.map(l => l.value).join('\n').trim();
  return { syncedLines: null, plainLyrics: plain || null };
}

/**
 * Multi-voice lyrics emit one cue line per agent, all sharing the same `index`,
 * with the main-role agent first. The pane renders a single layer, so the first
 * cue line per index wins and backing vocals are dropped.
 */
function firstCueLinePerIndex(
  cueLines: readonly SubsonicLyricCueLine[],
): Map<number, SubsonicLyricCueLine> {
  const byIndex = new Map<number, SubsonicLyricCueLine>();
  for (const cueLine of cueLines) {
    if (!byIndex.has(cueLine.index)) byIndex.set(cueLine.index, cueLine);
  }
  return byIndex;
}

interface TimedFragment {
  text: string;
  /** Milliseconds. */
  start: number;
  end: number;
}

/**
 * Word fragments for one line. `cue[].end` is all-or-nothing across a cue line,
 * so when it is absent the end is taken from the next cue, then from the line's
 * own end — otherwise the last word of a line would never stop highlighting.
 *
 * A line without cues (an instrumental break, or a server that timed only some
 * lines) becomes a single full-line fragment, so no line disappears from the
 * pane just because it carries no word timing.
 */
function fragmentsForLine(
  cueLine: SubsonicLyricCueLine | undefined,
  text: string,
  lineStart: number,
  lineEnd: number | undefined,
): TimedFragment[] {
  const cues = (cueLine?.cue ?? []).filter(cue => Number.isFinite(cue.start));
  if (cues.length === 0) {
    return [{ text, start: lineStart, end: lineEnd ?? lineStart }];
  }
  return cues.map((cue, i) => {
    const end = cue.end ?? cues[i + 1]?.start ?? lineEnd ?? cue.start;
    return { text: cue.value, start: cue.start, end: Math.max(cue.start, end) };
  });
}

function toWord(fragment: TimedFragment): WordLyricsWord {
  return {
    text: fragment.text,
    time: fragment.start / MS_PER_SECOND,
    duration: Math.max(0, fragment.end - fragment.start) / MS_PER_SECOND,
  };
}

/**
 * Convert `songLyrics` v2 cue lines into karaoke word lines, or null when the
 * response cannot drive word highlighting. Callers fall back to line-level sync.
 *
 * Null is returned for unsynced lyrics, for a response without cue lines, and
 * for line timings that are missing or out of order — a half-timed pane desyncs
 * far more visibly than plain line highlighting.
 */
export function parseStructuredWordLines(
  lyrics: SubsonicStructuredLyrics,
): WordLyricsLine[] | null {
  const cueLines = lyrics.cueLine ?? [];
  if (!isSyncedLyrics(lyrics) || cueLines.length === 0 || lyrics.line.length === 0) return null;

  const starts = lyrics.line.map(l => l.start);
  if (starts.some(start => start === undefined)) return null;
  const ordered = starts as number[];
  if (ordered.some((start, i) => i > 0 && start < ordered[i - 1])) return null;

  // `cueLine.index` addresses the original `line[]` positions, so this list must
  // keep the server's order — unlike `parseStructuredLyrics`, which may sort.
  const byIndex = firstCueLinePerIndex(cueLines);

  return lyrics.line.map((line, index) => {
    const cueLine = byIndex.get(index);
    const lineStart = ordered[index];
    const lineEnd = cueLine?.end ?? ordered[index + 1];
    const text = cueLine?.value ?? line.value;
    const fragments = fragmentsForLine(cueLine, text, lineStart, lineEnd);
    const end = lineEnd ?? fragments[fragments.length - 1].end;
    return {
      time: lineStart / MS_PER_SECOND,
      duration: Math.max(0, end - lineStart) / MS_PER_SECOND,
      text,
      words: fragments.map(toWord),
    };
  });
}
