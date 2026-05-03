import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import { ndLogin } from './navidromeAdmin';
import type { SubsonicSong } from './subsonic';

/** Server-keyed Bearer token cache. Cheap to keep — Navidrome tokens are long-lived. */
let cachedToken: { serverUrl: string; token: string } | null = null;

async function getToken(force = false): Promise<string> {
  const { getActiveServer, getBaseUrl } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  if (!server || !baseUrl) throw new Error('No active server configured');
  if (!force && cachedToken?.serverUrl === baseUrl) return cachedToken.token;
  const result = await ndLogin(baseUrl, server.username, server.password);
  cachedToken = { serverUrl: baseUrl, token: result.token };
  return result.token;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : fallback);
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

function mapNdSong(o: Record<string, unknown>): SubsonicSong {
  // Navidrome's REST shape differs from Subsonic — flatten into the SubsonicSong contract.
  const id = asString(o.id ?? o.mediaFileId);
  const albumId = asString(o.albumId);
  return {
    id,
    title: asString(o.title),
    artist: asString(o.artist),
    album: asString(o.album),
    albumId,
    artistId: asString(o.artistId) || undefined,
    duration: asNumber(o.duration) !== undefined ? Math.round(asNumber(o.duration)!) : 0,
    track: asNumber(o.trackNumber),
    discNumber: asNumber(o.discNumber),
    // Navidrome usually exposes coverArtId; many builds also accept the song id directly.
    coverArt: asString(o.coverArtId) || albumId || id || undefined,
    year: asNumber(o.year),
    userRating: asNumber(o.rating),
    starred: o.starred ? asString(o.starredAt) || 'true' : undefined,
    genre: typeof o.genre === 'string' ? o.genre : undefined,
    bitRate: asNumber(o.bitRate),
    suffix: typeof o.suffix === 'string' ? o.suffix : undefined,
    contentType: typeof o.contentType === 'string' ? o.contentType : undefined,
    size: asNumber(o.size),
    samplingRate: asNumber(o.sampleRate),
    bitDepth: asNumber(o.bitDepth),
  };
}

export type NdSongSort = 'title' | 'artist' | 'album' | 'recently_added' | 'play_count' | 'rating';

/** Optional opt-in cache for `ndListSongs` — keyed by call signature + active server. */
type SongsCacheEntry = { data: SubsonicSong[]; expiresAt: number };
const songsCache = new Map<string, SongsCacheEntry>();

function songsCacheKey(
  baseUrl: string, start: number, end: number, sort: string, order: string,
): string {
  return `${baseUrl}|${start}-${end}|${sort}|${order}`;
}

/**
 * Fetch a sorted, paginated slice of all songs via Navidrome's native REST API.
 * Returns mapped SubsonicSong objects. Throws on auth failure or non-Navidrome.
 *
 * `cacheMs` (> 0) opts in to a per-call-signature in-memory cache. Skip for
 * paginated browsing — only useful for stable-list rails (e.g. Highly Rated)
 * where a brief staleness window is acceptable in exchange for skipping the
 * roundtrip on every page revisit.
 */
export async function ndListSongs(
  start: number,
  end: number,
  sort: NdSongSort = 'title',
  order: 'ASC' | 'DESC' = 'ASC',
  cacheMs?: number,
): Promise<SubsonicSong[]> {
  const baseUrl = useAuthStore.getState().getBaseUrl();
  if (!baseUrl) throw new Error('No server configured');

  const cacheKey = (cacheMs && cacheMs > 0)
    ? songsCacheKey(baseUrl, start, end, sort, order)
    : null;
  if (cacheKey) {
    const hit = songsCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.data;
  }

  const callOnce = async (token: string): Promise<unknown> =>
    invoke<unknown>('nd_list_songs', { serverUrl: baseUrl, token, sort, order, start, end });

  let token = await getToken();
  let raw: unknown;
  try {
    raw = await callOnce(token);
  } catch (err) {
    const msg = String(err);
    // Token rejected → re-auth once and retry
    if (msg.includes('401') || msg.includes('403')) {
      token = await getToken(true);
      raw = await callOnce(token);
    } else {
      throw err;
    }
  }

  if (!Array.isArray(raw)) return [];
  const data = raw.map(s => mapNdSong(s as Record<string, unknown>));

  if (cacheKey && cacheMs && cacheMs > 0) {
    songsCache.set(cacheKey, { data, expiresAt: Date.now() + cacheMs });
  }
  return data;
}

/** Drop the cached token AND the songs cache — call when the active server changes. */
export function ndClearTokenCache(): void {
  cachedToken = null;
  songsCache.clear();
}

/** Drop the songs cache only (e.g. after a rating mutation). */
export function ndInvalidateSongsCache(): void {
  songsCache.clear();
}
