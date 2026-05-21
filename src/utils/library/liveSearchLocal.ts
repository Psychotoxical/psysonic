/**
 * Live Search dropdown against the local library index (spec §5.9 / P24).
 * Uses column-scoped `library_live_search` FTS — not Advanced Search.
 * Falls back to search3 when the index isn't ready (caller orchestrates).
 */
import type { SearchResults } from '../../api/subsonicTypes';
import { search } from '../../api/subsonicSearch';
import { libraryScopeForServer } from '../../api/subsonicClient';
import { libraryLiveSearch } from '../../api/library';
import { filterSearchArtistsWithNoAlbums } from '../../api/subsonicSearch';
import {
  albumToAlbum,
  artistToArtist,
  trackToSong,
} from './advancedSearchLocal';
import { logLibrarySearch, timed } from './libraryDevLog';

export const LIVE_SEARCH_DEBOUNCE_LOCAL_MS = 200;
export const LIVE_SEARCH_DEBOUNCE_NETWORK_MS = 300;
/** Debounce when local + network run in parallel. */
export const LIVE_SEARCH_DEBOUNCE_RACE_MS = 200;

/** Local FTS skipped below this length — see `LOCAL_FTS_MIN_QUERY_CHARS` in Rust. */
export const LOCAL_FTS_MIN_QUERY_CHARS = 2;

const ARTIST_LIMIT = 5;
const ALBUM_LIMIT = 5;
const SONG_LIMIT = 10;

export function queryGraphemeCount(q: string): number {
  return [...q].length;
}

export function liveSearchQueryTooShort(query: string): boolean {
  const q = query.trim();
  return !q || queryGraphemeCount(q) < LOCAL_FTS_MIN_QUERY_CHARS;
}

export type LiveSearchStaleCheck = () => boolean;

export interface LiveSearchRunContext {
  epoch: number;
  isStale: LiveSearchStaleCheck;
  /** Skip per-path dev log when the caller logs the race winner. */
  suppressLog?: boolean;
}

export async function runLocalLiveSearch(
  serverId: string | null | undefined,
  query: string,
  ctx: LiveSearchRunContext,
): Promise<SearchResults | null> {
  if (!serverId || ctx.isStale()) return null;
  const q = query.trim();
  if (liveSearchQueryTooShort(q)) return null;
  const t0 = performance.now();
  try {
    const { result: resp, ms: invokeMs } = await timed(() =>
      libraryLiveSearch({
        serverId,
        query: q,
        libraryScope: libraryScopeForServer(serverId),
        artistLimit: ARTIST_LIMIT,
        albumLimit: ALBUM_LIMIT,
        songLimit: SONG_LIMIT,
        requestEpoch: ctx.epoch,
      }),
    );
    if (ctx.isStale()) return null;
    if (resp.source !== 'local') return null;
    const mapped: SearchResults = {
      artists: filterSearchArtistsWithNoAlbums(resp.artists.map(artistToArtist)).slice(
        0,
        ARTIST_LIMIT,
      ),
      albums: resp.albums.map(albumToAlbum).slice(0, ALBUM_LIMIT),
      songs: resp.tracks.map(trackToSong).slice(0, SONG_LIMIT),
    };
    if (!ctx.suppressLog) {
      logLibrarySearch({
        at: new Date().toISOString(),
        query: q,
        path: 'library_live_search',
        surface: 'live_search',
        source: 'local',
        durationMs: Math.round(performance.now() - t0),
        invokeMs,
        counts: {
          artists: mapped.artists.length,
          albums: mapped.albums.length,
          songs: mapped.songs.length,
        },
      });
    }
    return mapped;
  } catch (err) {
    if (ctx.isStale()) return null;
    if (!ctx.suppressLog) {
      logLibrarySearch({
        at: new Date().toISOString(),
        query: q,
        path: 'library_live_search',
        surface: 'live_search',
        source: 'local',
        durationMs: Math.round(performance.now() - t0),
        error: String(err),
        fallbackReason: 'invoke_failed',
      });
    }
    return null;
  }
}

export const EMPTY_SEARCH_RESULTS: SearchResults = {
  artists: [],
  albums: [],
  songs: [],
};

export async function runNetworkLiveSearch(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResults | null> {
  const q = query.trim();
  if (liveSearchQueryTooShort(q)) return null;
  try {
    return await search(q, { signal });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'CanceledError' || name === 'AbortError') return null;
    throw err;
  }
}
