import { invoke } from '@tauri-apps/api/core';

// ─── AzuraCast API types ──────────────────────────────────────────────────────

export interface AzuraCastSong {
  artist: string;
  title: string;
  album: string;
  art?: string;
  text?: string; // "Artist - Title" combined
}

export interface AzuraCastNowPlayingTrack {
  song: AzuraCastSong;
  duration: number;  // seconds
  elapsed: number;   // seconds played so far
  remaining: number; // seconds remaining
  played_at?: number;
}

export interface AzuraCastListeners {
  current: number;
  unique?: number;
  total?: number;
}

export interface AzuraCastNowPlaying {
  now_playing: AzuraCastNowPlayingTrack;
  playing_next?: { song: AzuraCastSong } | null;
  song_history: Array<{ song: AzuraCastSong; played_at?: number }>;
  listeners: AzuraCastListeners;
  station?: { name: string; shortcode: string };
}

// ─── Detection helpers ────────────────────────────────────────────────────────

/**
 * Try to derive an AzuraCast NowPlaying API URL from a stream URL.
 *
 * AzuraCast stream URLs follow the pattern:
 *   https://<host>/listen/<shortcode>/<bitrate>.<ext>
 *
 * Returns the candidate API URL or `null` if the pattern doesn't match.
 */
export function guessAzuraCastApiUrl(streamUrl: string): string | null {
  try {
    const u = new URL(streamUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    // Expect: ['listen', '<shortcode>', '<file>']
    if (parts.length >= 2 && parts[0] === 'listen') {
      const shortcode = parts[1];
      return `${u.origin}/api/nowplaying/${shortcode}`;
    }
  } catch {
    // ignore invalid URLs
  }
  return null;
}

/**
 * Check whether a homepage URL itself looks like an AzuraCast NowPlaying
 * API endpoint and return the canonical URL to use.
 *
 * Accepts:
 *   - https://<host>/api/nowplaying                  → all stations, we use as-is
 *   - https://<host>/api/nowplaying/<shortcode>      → single station, use as-is
 */
export function normaliseAzuraCastHomepageUrl(homepageUrl: string): string | null {
  try {
    const u = new URL(homepageUrl);
    if (/^\/api\/nowplaying(\/[^/]+)?$/.test(u.pathname)) {
      return homepageUrl;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Fetch AzuraCast NowPlaying data from the given API URL (bypasses CORS via
 * the Rust backend).  Returns `null` if the request fails or the response
 * does not look like a valid AzuraCast payload.
 *
 * When the API URL points to the `/api/nowplaying` (array) endpoint, the
 * first item in the array is returned.  Otherwise the single-object form is
 * used directly.
 */
export async function fetchAzuraCastNowPlaying(apiUrl: string): Promise<AzuraCastNowPlaying | null> {
  try {
    const raw: string = await invoke('fetch_json_url', { url: apiUrl });
    const parsed = JSON.parse(raw);

    // If the response is an array (all-stations endpoint), take the first item.
    const obj: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!obj || typeof obj !== 'object') return null;

    const np = obj as Record<string, unknown>;
    // Minimal validation: must have `now_playing` with a `song` inside.
    if (
      np.now_playing &&
      typeof np.now_playing === 'object' &&
      (np.now_playing as Record<string, unknown>).song
    ) {
      return np as unknown as AzuraCastNowPlaying;
    }
  } catch {
    // Network error, JSON parse error, etc.
  }
  return null;
}
