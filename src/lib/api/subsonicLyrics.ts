import { api, apiForServer } from '@/lib/api/subsonicClient';
import type { SubsonicLyricCueLine, SubsonicStructuredLyrics } from '@/lib/api/subsonicTypes';

export interface GetLyricsOptions {
  /**
   * Request OpenSubsonic `songLyrics` v2 data (word/syllable cues, layer kinds,
   * multi-voice agents). Only pass this when the server advertises v2 — an
   * unknown query parameter is not guaranteed to be ignored by every server.
   */
  enhanced?: boolean;
  /** Explicit owning server for mixed-server playback. */
  serverId?: string;
}

/**
 * True for the primary lyric layer. `songLyrics` v1 has no `kind` at all and v2
 * omits it for the main layer, so a missing `kind` means main.
 */
export function isMainLyricsKind(lyrics: SubsonicStructuredLyrics): boolean {
  return !lyrics.kind || lyrics.kind === 'main';
}

function isSynced(lyrics: SubsonicStructuredLyrics): boolean {
  return !!(lyrics.synced ?? lyrics.issynced);
}

/**
 * Identity of the layer an entry belongs to. Entries sharing it are the same
 * layer arriving in pieces; anything else is a layer of its own. A missing
 * `kind` folds into `main` so v1 and v2 responses compare alike.
 */
function layerKey(lyrics: SubsonicStructuredLyrics): string {
  const kind = isMainLyricsKind(lyrics) ? 'main' : lyrics.kind;
  return `${kind}|${lyrics.lang ?? ''}|${isSynced(lyrics)}`;
}

/**
 * Merge sibling entries into the chosen one, keeping server order.
 *
 * `cueLine.index` addresses positions in `line`, so every appended entry shifts
 * its cue lines by the number of lines already collected — otherwise word
 * highlighting would point at the wrong text. Everything else, `agents`
 * included, is taken from the first entry: agent ids are local to the document
 * they were parsed from, so unioning rosters across entries would silently
 * reassign a cue line's `agentId` to a different voice.
 */
function mergeStructuredLyrics(
  entries: readonly SubsonicStructuredLyrics[],
): SubsonicStructuredLyrics {
  const line = [...entries[0].line];
  const cueLine: SubsonicLyricCueLine[] = [...(entries[0].cueLine ?? [])];

  for (const entry of entries.slice(1)) {
    const offset = line.length;
    line.push(...entry.line);
    for (const cue of entry.cueLine ?? []) cueLine.push({ ...cue, index: cue.index + offset });
  }

  return {
    ...entries[0],
    line,
    ...(cueLine.length > 0 ? { cueLine } : {}),
  };
}

/**
 * Choose the layer to display, preferring synced over unsynced.
 *
 * Without `enhanced` the server returns main-kind entries only, so the filter is
 * a no-op. With `enhanced=true` it also returns translation and pronunciation
 * layers, and those must never be shown in place of the original text. The
 * fallback to the unfiltered list only matters for a server that labels every
 * entry as non-main — showing something then beats showing nothing.
 *
 * One layer can arrive split across several entries: a server maps each lyrics
 * tag value to its own entry, and Vorbis comments (FLAC, Ogg) allow the tag to
 * repeat, so a taggant that writes one field per line yields one entry per line.
 * ID3 has a single frame and never splits, which is why this only shows up on
 * FLAC. Entries of the same layer are therefore concatenated; picking just the
 * first would drop all but its lines (issue #1472).
 *
 * Splitting is not per line — one field can hold a whole verse — so the pieces
 * are only recognisable by their shared kind, language and sync state, and any
 * count-based test for "is this a fragment" breaks a file whose fields are
 * unevenly sized. Line order is no signal either: LRC timestamps legitimately
 * step backwards at overlapping vocal lines.
 *
 * The accepted cost is that two distinct layers of one identity read as one.
 * Measured on Navidrome 0.63.2: a sidecar replaces the tag lyrics rather than
 * adding to them, and identical values across the aliased tags (`lyrics`,
 * `unsyncedlyrics`, `uslt:description`) collapse into a single entry — so the
 * duplicate-text case cannot arise. What remains is *differing* text in two of
 * those tags, which is genuinely indistinguishable from a split and gets
 * concatenated. Showing both beats the previous behaviour of silently keeping
 * whichever came first.
 */
export function pickMainStructuredLyrics(
  list: readonly SubsonicStructuredLyrics[],
): SubsonicStructuredLyrics | null {
  // Raw server JSON: `line` is required by the type but servers do omit it.
  // Dropping those entries up front keeps both the merge below and
  // `parseStructuredLyrics` from dereferencing an absent array — a throw there
  // escapes the fetch pipeline uncaught and leaves the pane loading forever.
  const usable = list.filter(l => Array.isArray(l.line));
  if (usable.length === 0) return null;
  const main = usable.filter(isMainLyricsKind);
  const pool = main.length > 0 ? main : usable;
  const chosen = pool.find(isSynced) ?? pool[0];

  const key = layerKey(chosen);
  const siblings = pool.filter(l => layerKey(l) === key);
  return siblings.length > 1 ? mergeStructuredLyrics(siblings) : chosen;
}

/**
 * Fetches structured lyrics from the server's embedded tags or sidecar files via
 * the OpenSubsonic `getLyricsBySongId` endpoint. Returns null when the server
 * doesn't support the endpoint or the track has no lyrics.
 */
export async function getLyricsBySongId(
  id: string,
  { enhanced = false, serverId }: GetLyricsOptions = {},
): Promise<SubsonicStructuredLyrics | null> {
  try {
    const endpoint = 'getLyricsBySongId.view';
    const params = enhanced ? { id, enhanced: true } : { id };
    const data = serverId
      ? await apiForServer<{ lyricsList: { structuredLyrics?: SubsonicStructuredLyrics[] } }>(
          serverId,
          endpoint,
          params,
        )
      : await api<{ lyricsList: { structuredLyrics?: SubsonicStructuredLyrics[] } }>(endpoint, params);
    return pickMainStructuredLyrics(data.lyricsList?.structuredLyrics ?? []);
  } catch {
    // Server doesn't support the endpoint or track has no embedded lyrics
    return null;
  }
}
