// lyricsplus backend powering YouLyPlus.
// Public mirrors — no auth required. Subscription costs for Apple/Spotify/
// Musixmatch are borne by the backend operator, not by us.
//
// Response semantics:
//   type: "Word" → syllabus[] contains per-word timings (karaoke-style)
//   type: "Line" → syllabus is empty/ignored; line-level sync only
//   No match / no data for the query → HTTP 503 with Cloudflare origin
//                                       error 1102. We treat any non-2xx as
//                                       a clean miss (silent caller fallback).
//
// All timings in the response are milliseconds.

const BASE_URLS: readonly string[] = [
  'https://lyricsplus.prjktla.my.id',
  'https://lyricsplus.atomix.one',
  'https://lyricsplus.binimum.org',
  'https://lyricsplus.prjktla.workers.dev',
  'https://lyricsplus-seven.vercel.app',
];

export interface LyricsPlusWord {
  /** Word / syllable text, including any trailing whitespace as returned by the API. */
  text: string;
  /** Absolute start time, ms. */
  time: number;
  /** Duration, ms. */
  duration: number;
}

export interface LyricsPlusLine {
  /** Absolute line start time, ms. */
  time: number;
  /** Full line duration, ms. */
  duration: number;
  /** Line text (concatenation of syllabus text when word-sync is present). */
  text: string;
  /** Per-word timings; empty/undefined for `type: "Line"` responses. */
  syllabus?: LyricsPlusWord[];
  element?: { singer?: string };
}

export interface LyricsPlusResult {
  /** `"Word"` (syllabus available) | `"Line"` (syllabus empty) | other. */
  type: 'Word' | 'Line' | string;
  lyrics: LyricsPlusLine[];
  metadata?: {
    source?: string;
    language?: string;
    songWriters?: string[];
    title?: string;
    album?: string;
    [k: string]: unknown;
  };
}

export interface LyricsPlusQuery {
  title: string;
  artist: string;
  album?: string;
  /** Track duration in seconds — the API expects seconds. */
  durationSec?: number;
  isrc?: string;
}

/**
 * Fetch lyrics from lyricsplus. Returns `null` for any miss or network
 * failure so callers can silently fall back to another provider without
 * seeing distinguishable error cases.
 *
 * Tries the primary endpoint first; on network failure (but NOT on HTTP
 * errors like 503 that indicate a clean miss) it walks the mirror list.
 */
export async function fetchLyricsPlus(q: LyricsPlusQuery): Promise<LyricsPlusResult | null> {
  if (!q.title.trim() || !q.artist.trim()) return null;

  const params = new URLSearchParams();
  params.set('title', q.title);
  params.set('artist', q.artist);
  if (q.album) params.set('album', q.album);
  if (q.durationSec && q.durationSec > 0) params.set('duration', String(Math.round(q.durationSec)));
  if (q.isrc) params.set('isrc', q.isrc);

  for (const base of BASE_URLS) {
    try {
      const res = await fetch(`${base}/v2/lyrics/get?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      // 503 + Cloudflare error 1102 = no data. Any non-2xx = miss (no retry).
      if (!res.ok) return null;

      const data = (await res.json()) as Partial<LyricsPlusResult> | null;
      if (!data || !Array.isArray(data.lyrics) || data.lyrics.length === 0) return null;

      return {
        type: data.type ?? 'Line',
        lyrics: data.lyrics as LyricsPlusLine[],
        metadata: data.metadata ?? undefined,
      };
    } catch {
      // Network / DNS failure → try next mirror.
      continue;
    }
  }

  return null;
}

/** `true` if any line has a non-empty syllabus array (i.e. karaoke-style). */
export function hasWordSync(result: LyricsPlusResult): boolean {
  return result.lyrics.some(l => Array.isArray(l.syllabus) && l.syllabus.length > 0);
}
