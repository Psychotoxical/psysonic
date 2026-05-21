/**
 * Browse-page text search — local index vs network race (LiveSearch / AdvancedSearch pattern).
 */
import { search, searchSongsPaged } from '../../api/subsonicSearch';
import type { SearchResults, SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../../api/subsonicTypes';
import { libraryAdvancedSearch } from '../../api/library';
import { libraryScopeForServer } from '../../api/subsonicClient';
import {
  LIVE_SEARCH_DEBOUNCE_NETWORK_MS,
  LIVE_SEARCH_DEBOUNCE_RACE_MS,
} from './liveSearchLocal';
import type { LibraryFilterClause, LibrarySortClause } from '../../api/library';
import { dedupeById } from '../dedupeById';
import {
  albumToAlbum,
  artistToArtist,
  loadMoreLocalSongs,
  runLocalAdvancedSearch,
  runNetworkAdvancedTextSearch,
  trackToSong,
  type LocalSearchOpts,
} from './advancedSearchLocal';
import {
  logLibrarySearch,
  timed,
  type LibrarySearchDebugEntry,
  type LibrarySearchSurface,
} from './libraryDevLog';
import { libraryIsReady } from './libraryReady';
import { raceSearchSources, type SearchRaceWinner } from './searchRace';

export type { LibrarySearchSurface };

export interface BrowseRaceLogOptions {
  surface: LibrarySearchSurface;
  query: string;
  indexEnabled?: boolean;
  counts?: (result: unknown) => LibrarySearchDebugEntry['counts'];
}

function logBrowseRaceOutcome(
  log: BrowseRaceLogOptions | undefined,
  path: LibrarySearchDebugEntry['path'],
  winner: SearchRaceWinner<unknown> | null,
  durationMs: number,
  fallbackReason?: string,
): void {
  if (!log) return;
  logLibrarySearch({
    at: new Date().toISOString(),
    query: log.query,
    path,
    durationMs,
    indexEnabled: log.indexEnabled,
    surface: log.surface,
    raceWinner: winner?.source,
    raceWinnerMs: winner?.durationMs,
    counts: winner && log.counts ? log.counts(winner.result) : undefined,
    fallbackReason,
  });
}

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
  log?: BrowseRaceLogOptions,
): Promise<SearchRaceWinner<T> | null> {
  if (isStale()) return null;

  const t0 = performance.now();
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

  if (winner && !isStale()) {
    logBrowseRaceOutcome(log, 'browse_race', winner, Math.round(performance.now() - t0));
    return winner;
  }

  const { result: localResult, ms: localMs } = await timed(local);
  if (localResult != null && !isStale()) {
    const outcome: SearchRaceWinner<T> = {
      source: 'local',
      result: localResult,
      durationMs: localMs,
    };
    logBrowseRaceOutcome(
      log,
      'browse_local_fallback',
      outcome,
      Math.round(performance.now() - t0),
      'race_no_winner',
    );
    return outcome;
  }

  const { result: networkResult, ms: networkMs } = await timed(() => safeNetwork(network));
  if (networkResult != null && !isStale()) {
    const outcome: SearchRaceWinner<T> = {
      source: 'network',
      result: networkResult,
      durationMs: networkMs,
    };
    logBrowseRaceOutcome(
      log,
      'browse_network_fallback',
      outcome,
      Math.round(performance.now() - t0),
      'local_unavailable',
    );
    return outcome;
  }

  logBrowseRaceOutcome(
    log,
    'browse_race_miss',
    null,
    Math.round(performance.now() - t0),
    'all_sources_empty',
  );
  return null;
}

export function browseRaceCountsArtists(result: unknown): LibrarySearchDebugEntry['counts'] {
  const n = Array.isArray(result) ? result.length : 0;
  return { artists: n, albums: 0, songs: 0 };
}

export function browseRaceCountsSongs(result: unknown): LibrarySearchDebugEntry['counts'] {
  const n = Array.isArray(result) ? result.length : 0;
  return { artists: 0, albums: 0, songs: n };
}

export function browseRaceCountsFullSearch(result: unknown): LibrarySearchDebugEntry['counts'] {
  const r = result as SearchResults;
  return {
    artists: r.artists?.length ?? 0,
    albums: r.albums?.length ?? 0,
    songs: r.songs?.length ?? 0,
  };
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

export type AlbumBrowseSort = 'alphabeticalByName' | 'alphabeticalByArtist';

function albumSortClauses(sort: AlbumBrowseSort): LibrarySortClause[] {
  if (sort === 'alphabeticalByArtist') {
    return [{ field: 'artist', dir: 'asc' }];
  }
  return [{ field: 'name', dir: 'asc' }];
}

/** Paginated All Albums browse from the local `album` table (F1). */
export async function runLocalAlbumBrowsePage(
  serverId: string | null | undefined,
  sort: AlbumBrowseSort,
  offset: number,
  pageSize: number,
  yearFilter?: { from: number; to: number },
): Promise<SubsonicAlbum[] | null> {
  if (!serverId || !(await libraryIsReady(serverId))) return null;
  const filters: LibraryFilterClause[] = [];
  if (yearFilter) {
    filters.push({
      field: 'year',
      op: 'between',
      value: yearFilter.from,
      valueTo: yearFilter.to,
    });
  }
  try {
    const resp = await libraryAdvancedSearch({
      serverId,
      libraryScope: libraryScopeForServer(serverId) ?? undefined,
      entityTypes: ['album'],
      filters,
      sort: yearFilter
        ? [{ field: 'year', dir: 'desc' }, { field: 'name', dir: 'asc' }]
        : albumSortClauses(sort),
      limit: pageSize,
      offset,
      skipTotals: true,
    });
    if (resp.source !== 'local') return null;
    return resp.albums.map(albumToAlbum);
  } catch {
    return null;
  }
}

const GENRE_ALBUM_FETCH_LIMIT = 500;

/** Genre-filtered album union for All Albums / Random Albums genre bar. */
export async function runLocalAlbumsByGenres(
  serverId: string | null | undefined,
  genres: string[],
  sort: AlbumBrowseSort,
  limitPerGenre = GENRE_ALBUM_FETCH_LIMIT,
): Promise<SubsonicAlbum[] | null> {
  if (!serverId || !(await libraryIsReady(serverId)) || genres.length === 0) return null;
  try {
    const pages = await Promise.all(
      genres.map(genre =>
        libraryAdvancedSearch({
          serverId,
          libraryScope: libraryScopeForServer(serverId) ?? undefined,
          entityTypes: ['album'],
          filters: [{ field: 'genre', op: 'eq', value: genre }],
          sort: albumSortClauses(sort),
          limit: limitPerGenre,
          offset: 0,
          skipTotals: true,
        }),
      ),
    );
    if (pages.some(p => p.source !== 'local')) return null;
    const merged = dedupeById(pages.flatMap(p => p.albums.map(albumToAlbum)));
    return merged.sort((a, b) =>
      sort === 'alphabeticalByArtist'
        ? a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name)
        : a.name.localeCompare(b.name) || a.artist.localeCompare(b.artist),
    );
  } catch {
    return null;
  }
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
