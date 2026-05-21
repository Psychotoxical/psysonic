/**
 * Browse-page text search — local index vs network race (LiveSearch / AdvancedSearch pattern).
 */
import { search, searchSongsPaged } from '../../api/subsonicSearch';
import type { SearchResults, SubsonicArtist, SubsonicSong } from '../../api/subsonicTypes';
import { libraryAdvancedSearch } from '../../api/library';
import { libraryScopeForServer } from '../../api/subsonicClient';
import {
  LIVE_SEARCH_DEBOUNCE_NETWORK_MS,
  LIVE_SEARCH_DEBOUNCE_RACE_MS,
} from './liveSearchLocal';
import {
  artistToArtist,
  loadMoreLocalSongs,
  runLocalAdvancedSearch,
  runNetworkAdvancedTextSearch,
  trackToSong,
  type LocalSearchOpts,
} from './advancedSearchLocal';
import { libraryIsReady } from './libraryReady';
import { raceSearchSources, type SearchRaceWinner } from './searchRace';

export {
  LIVE_SEARCH_DEBOUNCE_RACE_MS as BROWSE_TEXT_DEBOUNCE_RACE_MS,
  LIVE_SEARCH_DEBOUNCE_NETWORK_MS as BROWSE_TEXT_DEBOUNCE_NETWORK_MS,
};

/** Network arm for browse races — errors become null, never reject the race. */
async function safeNetwork<T>(run: () => Promise<T | null>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

/**
 * Parallel local vs network browse search. Network failures are swallowed. When
 * the race does not pick a winner (or rejects because local threw), local is
 * tried again so a down remote server does not block a ready index.
 */
export async function raceBrowseWithLocalFallback<T>(
  isStale: () => boolean,
  local: () => Promise<T | null>,
  network: () => Promise<T | null>,
): Promise<SearchRaceWinner<T> | null> {
  if (isStale()) return null;

  let winner: SearchRaceWinner<T> | null = null;
  try {
    winner = await raceSearchSources(
      [
        { source: 'local', run: local },
        { source: 'network', run: () => safeNetwork(network) },
      ],
      isStale,
    );
  } catch {
    // Local threw — fall through to explicit local retry below.
  }

  if (winner && !isStale()) return winner;

  const localResult = await local();
  if (localResult != null && !isStale()) {
    return { source: 'local', result: localResult, durationMs: 0 };
  }

  const networkResult = await safeNetwork(network);
  if (networkResult != null && !isStale()) {
    return { source: 'network', result: networkResult, durationMs: 0 };
  }

  return null;
}

const ARTIST_BROWSE_LIMIT = 500;

const emptyBrowseOpts = (query: string): LocalSearchOpts => ({
  query,
  genre: '',
  yearFrom: '',
  yearTo: '',
  resultType: 'artists',
});

const songBrowseOpts = (query: string): LocalSearchOpts => ({
  query,
  genre: '',
  yearFrom: '',
  yearTo: '',
  resultType: 'songs',
});

const fullSearchOpts = (query: string): LocalSearchOpts => ({
  query,
  genre: '',
  yearFrom: '',
  yearTo: '',
  resultType: 'all',
});

/** Local artist name search for Artists / Composers browse pages. */
export async function runLocalBrowseArtists(
  serverId: string | null | undefined,
  query: string,
  limit = ARTIST_BROWSE_LIMIT,
): Promise<SubsonicArtist[] | null> {
  const page = await runLocalAdvancedSearch(
    serverId,
    emptyBrowseOpts(query),
    limit,
    false,
    true,
    true,
  );
  if (!page) return null;
  return page.artists;
}

/** Network search3 artist slice for browse pages. */
export async function runNetworkBrowseArtists(
  query: string,
  limit = ARTIST_BROWSE_LIMIT,
): Promise<SubsonicArtist[] | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    const r = await search(q, { artistCount: limit, albumCount: 0, songCount: 0 });
    return r.artists;
  } catch {
    return null;
  }
}

/** Paginated local track text search (Tracks browse / VirtualSongList). */
export async function runLocalBrowseSongPage(
  serverId: string | null | undefined,
  query: string,
  offset: number,
  pageSize: number,
): Promise<SubsonicSong[] | null> {
  if (!serverId || !(await libraryIsReady(serverId))) return null;
  const q = query.trim();
  if (!q) return null;
  try {
    const resp = await libraryAdvancedSearch({
      serverId,
      libraryScope: libraryScopeForServer(serverId) ?? undefined,
      query: q,
      entityTypes: ['track'],
      limit: pageSize,
      offset,
      skipTotals: true,
    });
    if (resp.source !== 'local') return null;
    return resp.tracks.map(trackToSong);
  } catch {
    return null;
  }
}

/** Paginated network track text search. */
export async function runNetworkBrowseSongPage(
  query: string,
  offset: number,
  pageSize: number,
): Promise<SubsonicSong[] | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    return await searchSongsPaged(q, pageSize, offset);
  } catch {
    return null;
  }
}

/** Full SearchResults page — local advanced search (all entity types). */
export async function runLocalBrowseFullSearch(
  serverId: string | null | undefined,
  query: string,
  songsLimit: number,
): Promise<SearchResults | null> {
  const page = await runLocalAdvancedSearch(
    serverId,
    fullSearchOpts(query),
    songsLimit,
    false,
    true,
    true,
  );
  if (!page) return null;
  return {
    artists: page.artists,
    albums: page.albums,
    songs: page.songs,
  };
}

/** Full SearchResults page — network search3. */
export async function runNetworkBrowseFullSearch(
  query: string,
  songsLimit: number,
): Promise<SearchResults | null> {
  try {
    const page = await runNetworkAdvancedTextSearch(fullSearchOpts(query), songsLimit);
    if (!page) return null;
    return {
      artists: page.artists,
      albums: page.albums,
      songs: page.songs,
    };
  } catch {
    return null;
  }
}

/** Next song page when the race winner was local (SearchResults / Tracks). */
export async function loadMoreLocalBrowseSongs(
  serverId: string,
  query: string,
  offset: number,
  pageSize: number,
): Promise<SubsonicSong[]> {
  return loadMoreLocalSongs(serverId, songBrowseOpts(query), offset, pageSize);
}

/** Local artist table browse-all when the index is ready (optional fast path). */
export async function runLocalBrowseAllArtists(
  serverId: string | null | undefined,
  limit = 10_000,
): Promise<SubsonicArtist[] | null> {
  if (!serverId || !(await libraryIsReady(serverId))) return null;
  try {
    const resp = await libraryAdvancedSearch({
      serverId,
      libraryScope: libraryScopeForServer(serverId) ?? undefined,
      entityTypes: ['artist'],
      limit,
      offset: 0,
      skipTotals: true,
    });
    if (resp.source !== 'local') return null;
    return resp.artists.map(artistToArtist);
  } catch {
    return null;
  }
}
