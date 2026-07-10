import { api } from '@/lib/api/subsonicClient';
import type { SubsonicStructuredLyrics } from '@/lib/api/subsonicTypes';

export interface GetLyricsOptions {
  /**
   * Request OpenSubsonic `songLyrics` v2 data (word/syllable cues, layer kinds,
   * multi-voice agents). Only pass this when the server advertises v2 — an
   * unknown query parameter is not guaranteed to be ignored by every server.
   */
  enhanced?: boolean;
}

/**
 * True for the primary lyric layer. `songLyrics` v1 has no `kind` at all and v2
 * omits it for the main layer, so a missing `kind` means main.
 */
export function isMainLyricsKind(lyrics: SubsonicStructuredLyrics): boolean {
  return !lyrics.kind || lyrics.kind === 'main';
}

/**
 * Choose the layer to display, preferring synced over unsynced.
 *
 * Without `enhanced` the server returns main-kind entries only, so the filter is
 * a no-op. With `enhanced=true` it also returns translation and pronunciation
 * layers, and those must never be shown in place of the original text. The
 * fallback to the unfiltered list only matters for a server that labels every
 * entry as non-main — showing something then beats showing nothing.
 */
export function pickMainStructuredLyrics(
  list: readonly SubsonicStructuredLyrics[],
): SubsonicStructuredLyrics | null {
  if (list.length === 0) return null;
  const main = list.filter(isMainLyricsKind);
  const pool = main.length > 0 ? main : list;
  return pool.find(l => l.synced || l.issynced) ?? pool[0] ?? null;
}

/**
 * Fetches structured lyrics from the server's embedded tags or sidecar files via
 * the OpenSubsonic `getLyricsBySongId` endpoint. Returns null when the server
 * doesn't support the endpoint or the track has no lyrics.
 */
export async function getLyricsBySongId(
  id: string,
  { enhanced = false }: GetLyricsOptions = {},
): Promise<SubsonicStructuredLyrics | null> {
  try {
    const data = await api<{ lyricsList: { structuredLyrics?: SubsonicStructuredLyrics[] } }>(
      'getLyricsBySongId.view',
      enhanced ? { id, enhanced: true } : { id },
    );
    return pickMainStructuredLyrics(data.lyricsList?.structuredLyrics ?? []);
  } catch {
    // Server doesn't support the endpoint or track has no embedded lyrics
    return null;
  }
}
