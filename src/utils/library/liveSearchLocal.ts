/**
 * Live Search dropdown against the local library index (spec §5.9 / P24).
 * Uses the lean `library_live_search` FTS path (one query) — not Advanced
 * Search. Falls back to search3 when the index isn't ready.
 */
import type { SearchResults } from '../../api/subsonicTypes';
import { libraryLiveSearch } from '../../api/library';
import { filterSearchArtistsWithNoAlbums } from '../../api/subsonicSearch';
import {
  albumToAlbum,
  artistToArtist,
  trackToSong,
} from './advancedSearchLocal';
import { logLibrarySearch, timed } from './libraryDevLog';

export const LIVE_SEARCH_DEBOUNCE_LOCAL_MS = 100;
export const LIVE_SEARCH_DEBOUNCE_NETWORK_MS = 300;

const ARTIST_LIMIT = 5;
const ALBUM_LIMIT = 5;
const SONG_LIMIT = 10;

export async function runLocalLiveSearch(
  serverId: string | null | undefined,
  query: string,
): Promise<SearchResults | null> {
  if (!serverId) return null;
  const q = query.trim();
  if (!q) return null;
  const t0 = performance.now();
  try {
    const { result: resp, ms: invokeMs } = await timed(() =>
      libraryLiveSearch({
        serverId,
        query: q,
        artistLimit: ARTIST_LIMIT,
        albumLimit: ALBUM_LIMIT,
        songLimit: SONG_LIMIT,
      }),
    );
    if (resp.source !== 'local') return null;
    const mapped: SearchResults = {
      artists: filterSearchArtistsWithNoAlbums(resp.artists.map(artistToArtist)).slice(
        0,
        ARTIST_LIMIT,
      ),
      albums: resp.albums.map(albumToAlbum).slice(0, ALBUM_LIMIT),
      songs: resp.tracks.map(trackToSong).slice(0, SONG_LIMIT),
    };
    logLibrarySearch({
      at: new Date().toISOString(),
      query: q,
      path: 'library_live_search',
      durationMs: Math.round(performance.now() - t0),
      invokeMs,
      counts: {
        artists: mapped.artists.length,
        albums: mapped.albums.length,
        songs: mapped.songs.length,
      },
    });
    return mapped;
  } catch (err) {
    logLibrarySearch({
      at: new Date().toISOString(),
      query: q,
      path: 'library_live_search',
      durationMs: Math.round(performance.now() - t0),
      error: String(err),
      fallbackReason: 'invoke_failed',
    });
    return null;
  }
}
