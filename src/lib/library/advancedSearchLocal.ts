/**
 * Advanced Search against the local library index (spec §5.13 / F2).
 *
 * Maps the SearchBrowsePage filter inputs to a `library_advanced_search` request and
 * the response back to the Subsonic shapes the existing rows render. The sync
 * engine stores each entity's original Subsonic JSON in `rawJson` (ADR-7), so
 * that's preferred verbatim; the flat hot columns are a fallback when a row's
 * `rawJson` is sparse.
 *
 * `runLocalAdvancedSearch` returns `null` when the index isn't ready or the
 * query can't be served locally — the caller then falls back to the network
 * path unchanged (§5.13.6).
 */
import {
  libraryAdvancedSearch,
  libraryScopeBrowse,
  type LibraryAdvancedSearchRequest,
  type LibraryAlbumDto,
  type LibraryArtistDto,
  type LibraryEntityType,
  type LibraryFilterClause,
} from '@/lib/api/library';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { search, searchForServer } from '@/lib/api/subsonicSearch';
import { libraryScopeForServer, libraryScopePairsForServer } from '@/lib/api/subsonicClient';
import { fetchAlbumBrowseNetwork } from './albumBrowseNetwork';
import type { AlbumBrowseQuery } from './albumBrowseTypes';
import { resolveAlbumYearBounds } from './albumYearFilter';
import {
  resolveReadyLibraryBrowseScope,
  type ReadyLibraryBrowseScope,
} from './libraryReady';
import { logLibrarySearch, timed } from './libraryDevLog';
import { isLosslessSuffix } from './losslessFormats';
import { albumIsCompilation, isVariousArtistsLabel } from './albumCompilation';
import { OXIMEDIA_MOOD_SEARCH_ENABLED } from './trackEnrichment';
import { trackToSong } from './trackDtoMapping';
import { getLibraryBrowseScope, type LibraryBrowseScope } from './libraryBrowseScope';
import { trackBrowseTimed } from './trackBrowseDebug';

export { resolveTrackCoverArtId, trackToSong } from './trackDtoMapping';

export const ADVANCED_SEARCH_YEAR_ALBUM_LIMIT = 100;

export type AdvancedResultType = 'all' | 'artists' | 'albums' | 'songs';

/** UI opts for Advanced Search — BPM/mood filters require local index. */
export interface LocalSearchOpts {
  query: string;
  genre: string;
  yearFrom: string;
  yearTo: string;
  bpmFrom: string;
  bpmTo: string;
  moodGroup: string;
  losslessOnly?: boolean;
  resultType: AdvancedResultType;
  /** When searching albums, match album title only (not album artist). */
  albumTitleOnly?: boolean;
  /** Artist browse credit mode (#1209). */
  artistCreditMode?: 'album' | 'track';
}

export interface LocalAdvancedSearchPage {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
  /** Raw server/index rows consumed before client-side filtering. */
  songsConsumed: number;
  /** Full track match count (not page size) — drives "load more". */
  songsTotal: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function entityTypesFor(rt: AdvancedResultType): LibraryEntityType[] {
  switch (rt) {
    case 'artists':
      return ['artist'];
    case 'albums':
      return ['album'];
    case 'songs':
      return ['track'];
    default:
      return ['artist', 'album', 'track'];
  }
}

function buildFilters(opts: LocalSearchOpts): LibraryFilterClause[] {
  const filters: LibraryFilterClause[] = [];
  if (opts.genre) filters.push({ field: 'genre', op: 'eq', value: opts.genre });
  const from = opts.yearFrom ? parseInt(opts.yearFrom, 10) : null;
  const to = opts.yearTo ? parseInt(opts.yearTo, 10) : null;
  if (from !== null && to !== null) {
    filters.push({ field: 'year', op: 'between', value: from, valueTo: to });
  } else if (from !== null) {
    filters.push({ field: 'year', op: 'gte', value: from });
  } else if (to !== null) {
    filters.push({ field: 'year', op: 'lte', value: to });
  }
  const bpmFrom = opts.bpmFrom ? parseInt(opts.bpmFrom, 10) : null;
  const bpmTo = opts.bpmTo ? parseInt(opts.bpmTo, 10) : null;
  if (bpmFrom !== null && bpmTo !== null) {
    filters.push({ field: 'bpm', op: 'between', value: bpmFrom, valueTo: bpmTo });
  } else if (bpmFrom !== null) {
    filters.push({ field: 'bpm', op: 'gte', value: bpmFrom });
  } else if (bpmTo !== null) {
    filters.push({ field: 'bpm', op: 'lte', value: bpmTo });
  }
  if (OXIMEDIA_MOOD_SEARCH_ENABLED && opts.moodGroup) {
    filters.push({ field: 'mood_group', op: 'eq', value: opts.moodGroup });
  }
  if (opts.losslessOnly) {
    filters.push({ field: 'lossless', op: 'is_true' });
  }
  return filters;
}

function applyClientSongFilters(
  list: SubsonicSong[],
  opts: LocalSearchOpts,
): SubsonicSong[] {
  let r = list;
  const g = opts.genre;
  const from = opts.yearFrom ? parseInt(opts.yearFrom, 10) : null;
  const to = opts.yearTo ? parseInt(opts.yearTo, 10) : null;
  const bpmFrom = opts.bpmFrom ? parseInt(opts.bpmFrom, 10) : null;
  const bpmTo = opts.bpmTo ? parseInt(opts.bpmTo, 10) : null;
  if (g) r = r.filter(s => s.genre?.toLowerCase() === g.toLowerCase());
  if (from !== null) r = r.filter(s => !s.year || s.year >= from);
  if (to !== null) r = r.filter(s => !s.year || s.year <= to);
  if (bpmFrom !== null) r = r.filter(s => s.bpm != null && s.bpm > 0 && s.bpm >= bpmFrom);
  if (bpmTo !== null) r = r.filter(s => s.bpm != null && s.bpm > 0 && s.bpm <= bpmTo);
  if (opts.losslessOnly) r = r.filter(s => isLosslessSuffix(s.suffix));
  return r;
}

function buildRequest(
  readyScope: ReadyLibraryBrowseScope,
  opts: LocalSearchOpts,
  entityTypes: LibraryEntityType[],
  limit: number,
  offset: number,
  skipTotals = false,
): LibraryAdvancedSearchRequest {
  const q = opts.query.trim();
  const useBrowseScope = readyScope.pairs.length > 0;
  const libraryScope = useBrowseScope ? undefined : libraryScopeForServer(readyScope.anchorServerKey);
  const libraryScopes = useBrowseScope
    ? readyScope.pairs
    : libraryScopePairsForServer(readyScope.anchorServerKey);
  return {
    serverId: readyScope.anchorServerKey,
    libraryScope: libraryScope ?? undefined,
    libraryScopes,
    query: q || undefined,
    entityTypes,
    filters: buildFilters(opts),
    limit,
    offset,
    skipTotals,
    ...(opts.resultType === 'albums' && opts.albumTitleOnly
      ? { queryAlbumTitleOnly: true }
      : {}),
    ...(opts.artistCreditMode ? { artistCreditMode: opts.artistCreditMode } : {}),
  };
}

/**
 * `raw_json` augments the DTO, but the album-artist identity is not an augmentation
 * field — the backend resolves it into the hot `artist`/`artistId` columns for EVERY
 * album (`overlay_priority_album_row` + `pick_album_group_artist_id` run for VA and
 * non-VA alike), while `raw_json` still carries the server's legacy `artist`/`artistId`
 * (a representative performer on a compilation). So the hot columns are authoritative
 * for these two keys on all albums and must not be overwritten by the legacy pair;
 * this deliberately differs from every other raw key, which stays pure augmentation.
 * Trusting the hot columns here is exactly what keeps the frontend link in step with
 * the backend resolution — narrowing it to VA only would re-introduce a front/back
 * mismatch for non-VA albums.
 *
 * `artistId` has two empty-string cases that must be told apart: a Various Artists
 * album the backend deliberately left unlinked (keep it blank, do not open a guest)
 * versus a plain album whose id lives only in `raw_json` (fill it). So suppress the
 * raw `artistId` only when the hot id is already set or the credit is a VA label.
 */
function mergeAlbumRawJson(base: SubsonicAlbum, raw: Partial<SubsonicAlbum>): SubsonicAlbum {
  const merged = { ...base } as SubsonicAlbum & Record<string, unknown>;
  const artistNameSet = typeof base.artist === 'string' && base.artist.trim() !== '';
  const artistIdSet = typeof base.artistId === 'string' && base.artistId.trim() !== '';
  // Test the VA label against the *effective* credit — the hot column, or `raw_json`
  // when the hot column is empty. Otherwise an album with a blank hot artist but a
  // "Various Artists" credit only in raw_json would fill the name from raw and then
  // let raw's legacy performer id link it, the exact mislink this guard prevents.
  const rawArtist = typeof raw.artist === 'string' ? raw.artist : '';
  const effectiveArtist = artistNameSet ? base.artist : rawArtist;
  const isVariousArtists = isVariousArtistsLabel(effectiveArtist);
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'starred') continue;
    if (key === 'artist' && artistNameSet) continue;
    if (key === 'artistId' && (artistIdSet || isVariousArtists)) continue;
    if (value != null && value !== '') merged[key] = value;
  }
  return merged;
}

export function albumToAlbum(a: LibraryAlbumDto): SubsonicAlbum {
  const raw = isObject(a.rawJson) ? a.rawJson : {};
  const base: SubsonicAlbum = {
    serverId: a.serverId,
    id: a.id,
    name: a.name,
    artist: a.artist ?? '',
    artistId: a.artistId ?? '',
    songCount: a.songCount ?? 0,
    duration: a.durationSec ?? 0,
    year: a.year ?? undefined,
    genre: a.genre ?? undefined,
    coverArt: a.coverArtId ?? a.id,
    starred: a.starredAt != null ? new Date(a.starredAt).toISOString() : undefined,
  };
  const merged = mergeAlbumRawJson(base, raw as Partial<SubsonicAlbum>);
  const createdMs = typeof raw.createdMs === 'number' && Number.isFinite(raw.createdMs)
    ? raw.createdMs
    : null;
  if (!merged.created && createdMs !== null) {
    merged.created = new Date(createdMs).toISOString();
  }
  if (albumIsCompilation(merged)) merged.isCompilation = true;
  return merged;
}

export function artistToArtist(ar: LibraryArtistDto): SubsonicArtist {
  const raw = isObject(ar.rawJson) ? ar.rawJson : {};
  const base: SubsonicArtist = {
    serverId: ar.serverId,
    id: ar.id,
    name: ar.name,
    nameSort: ar.nameSort ?? undefined,
    albumCount: ar.albumCount ?? undefined,
    coverArt: ar.id,
  };
  const merged = mergeArtistRawJson(base, raw as Partial<SubsonicArtist>);
  return merged;
}

/** Hot columns from SQLite win over sparse `raw_json` (ADR-7). */
function mergeArtistRawJson(base: SubsonicArtist, raw: Partial<SubsonicArtist>): SubsonicArtist {
  return { ...raw, ...base };
}

/**
 * Network search3 path for Advanced Search free-text (mirrors SearchBrowsePage.tsx filters).
 */
export async function runNetworkAdvancedTextSearch(
  opts: LocalSearchOpts,
  songsLimit: number,
  serverId?: string | null,
): Promise<LocalAdvancedSearchPage | null> {
  const q = opts.query.trim();
  if (!q) return null;
  const rt = opts.resultType;

  const searchOptions = {
    artistCount: 30,
    albumCount: 50,
    songCount: songsLimit,
  };
  const r = serverId
    ? await searchForServer(serverId, q, searchOptions)
    : await search(q, searchOptions);

  let artists = r.artists;
  let albums = r.albums;
  const songs = applyClientSongFilters(r.songs, opts);

  const g = opts.genre;
  const from = opts.yearFrom ? parseInt(opts.yearFrom, 10) : null;
  const to = opts.yearTo ? parseInt(opts.yearTo, 10) : null;
  if (g) albums = albums.filter(a => a.genre?.toLowerCase() === g.toLowerCase());
  if (from !== null) albums = albums.filter(a => !a.year || a.year >= from);
  if (to !== null) albums = albums.filter(a => !a.year || a.year <= to);
  if (opts.losslessOnly) {
    const albumIds = new Set(songs.map(s => s.albumId).filter(Boolean));
    albums = albums.filter(a => albumIds.has(a.id));
    const artistIds = new Set(songs.map(s => s.artistId).filter(Boolean));
    artists = artists.filter(a => artistIds.has(a.id));
  }

  return {
    artists: rt === 'albums' || rt === 'songs' ? [] : artists,
    albums: rt === 'artists' || rt === 'songs' ? [] : albums,
    songs: rt === 'artists' || rt === 'albums' ? [] : songs,
    songsConsumed: rt === 'artists' || rt === 'albums' ? 0 : r.songs.length,
    songsTotal: rt === 'artists' || rt === 'albums' ? 0 : songs.length,
  };
}

/**
 * Full first-page Advanced Search against the local index. Returns `null`
 * when the index isn't ready or the local query fails — caller falls back to
 * the network path.
 */
export async function runLocalAdvancedSearch(
  serverId: string | null | undefined,
  opts: LocalSearchOpts,
  songsLimit: number,
  skipTotals = true,
  suppressLog = false,
  browseScope: LibraryBrowseScope = getLibraryBrowseScope(),
): Promise<LocalAdvancedSearchPage | null> {
  if (!serverId) return null;
  const readyScope = await resolveReadyLibraryBrowseScope(
    browseScope.anchorServerId ?? serverId,
    browseScope,
  );
  if (!readyScope) return null;
  const t0 = performance.now();
  try {
    const req = buildRequest(
      readyScope,
      opts,
      entityTypesFor(opts.resultType),
      songsLimit,
      0,
      skipTotals,
    );
    const { result: resp, ms: invokeMs } = await timed(() => libraryAdvancedSearch(req));
    if (resp.source !== 'local') return null;
    const page = {
      artists: resp.artists.map(artistToArtist),
      albums: resp.albums.map(albumToAlbum),
      songs: resp.tracks.map(trackToSong),
      songsConsumed: resp.tracks.length,
      songsTotal: resp.totals.tracks,
    };
    if (!suppressLog) {
      logLibrarySearch({
        at: new Date().toISOString(),
        query: opts.query.trim(),
        path: 'library_advanced_search',
        surface: 'advanced_search',
        source: 'local',
        durationMs: Math.round(performance.now() - t0),
        invokeMs,
        counts: {
          artists: page.artists.length,
          albums: page.albums.length,
          songs: page.songs.length,
        },
      });
    }
    return page;
  } catch (err) {
    if (!suppressLog) {
      logLibrarySearch({
        at: new Date().toISOString(),
        query: opts.query.trim(),
        path: 'library_advanced_search',
        surface: 'advanced_search',
        source: 'local',
        durationMs: Math.round(performance.now() - t0),
        error: String(err),
      });
    }
    return null;
  }
}

/**
 * Browse-all songs against the local index for `VirtualSongList` (F1). An empty
 * query falls through to the Rust builder's default track order
 * (`t.title COLLATE NOCASE ASC`) — the same alphabetical browse as the network
 * `ndListSongs('title','ASC')` path, so paging stays coherent even if a later
 * page falls back to the network. Returns `null` when the index isn't ready or
 * the page can't be served locally; the caller then uses the network path
 * unchanged. Gated per page so a readiness flip mid-scroll degrades gracefully.
 */
export async function runLocalSongBrowse(
  serverId: string | null | undefined,
  offset: number,
  pageSize: number,
  browseScope: LibraryBrowseScope = getLibraryBrowseScope(),
): Promise<SubsonicSong[] | null> {
  if (!serverId) return null;
  const readyScope = await resolveReadyLibraryBrowseScope(
    browseScope.anchorServerId ?? serverId,
    browseScope,
  );
  if (!readyScope) return null;
  try {
    const resp = await libraryAdvancedSearch({
      serverId: readyScope.anchorServerKey,
      libraryScope: readyScope.pairs.length > 0 ? undefined : libraryScopeForServer(readyScope.anchorServerKey),
      libraryScopes: readyScope.pairs.length > 0 ? readyScope.pairs : libraryScopePairsForServer(readyScope.anchorServerKey),
      query: undefined,
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

/** Indexed candidate-first page for the ordinary unfiltered Tracks catalogue. */
export async function runLocalSongScopeBrowse(
  serverId: string | null | undefined,
  pageSize: number,
  cursor?: string | null,
  browseScope: LibraryBrowseScope = getLibraryBrowseScope(),
): Promise<{ songs: SubsonicSong[]; hasMore: boolean; nextCursor?: string | null } | null> {
  if (!serverId) return null;
  const readyScope = await trackBrowseTimed(
    'library_is_ready',
    () => resolveReadyLibraryBrowseScope(browseScope.anchorServerId ?? serverId, browseScope),
    { serverId },
  );
  if (!readyScope || readyScope.pairs.length === 0) return null;
  try {
    const response = await trackBrowseTimed(
      'scope_browse',
      () => libraryScopeBrowse(readyScope.anchorServerKey, {
        entity: 'track',
        scopes: readyScope.pairs,
        sort: [{ field: 'title', dir: 'asc' }],
        limit: pageSize,
        cursor,
      }),
      { scopeCount: readyScope.pairs.length, limit: pageSize, cursor: cursor != null },
    );
    if (response.source !== 'local') return null;
    return {
      songs: response.tracks.map(trackToSong),
      hasMore: response.hasMore,
      nextCursor: response.nextCursor,
    };
  } catch {
    return null;
  }
}

/**
 * Songs-only next page for the local path (mirrors the network
 * `searchSongsPaged` pagination). Throws are surfaced so the caller can stop
 * the infinite-scroll loop, matching the network branch's behaviour.
 */
export async function loadMoreLocalSongs(
  serverId: string,
  opts: LocalSearchOpts,
  offset: number,
  pageSize: number,
  browseScope: LibraryBrowseScope = getLibraryBrowseScope(),
): Promise<SubsonicSong[]> {
  const readyScope = await resolveReadyLibraryBrowseScope(
    browseScope.anchorServerId ?? serverId,
    browseScope,
  );
  if (!readyScope) throw new Error('local library index is not ready');
  const req = buildRequest(readyScope, opts, ['track'], pageSize, offset, true);
  const resp = await libraryAdvancedSearch(req);
  return resp.tracks.map(trackToSong);
}

/** Local index first when every selected server is physically readable. */
export async function tryRunLocalAdvancedSearch(
  serverId: string | null | undefined,
  opts: LocalSearchOpts,
  songsLimit: number,
  suppressLog = false,
  browseScope: LibraryBrowseScope = getLibraryBrowseScope(),
): Promise<LocalAdvancedSearchPage | null> {
  return runLocalAdvancedSearch(
    serverId,
    opts,
    songsLimit,
    true,
    suppressLog,
    browseScope,
  );
}

function yearOnlyAlbumBrowseQuery(opts: LocalSearchOpts): AlbumBrowseQuery | null {
  const { active, bounds } = resolveAlbumYearBounds(opts.yearFrom, opts.yearTo);
  if (!active) return null;
  return {
    sort: 'alphabeticalByName',
    genres: [],
    year: bounds,
    losslessOnly: !!opts.losslessOnly,
    starredOnly: false,
    compFilter: 'all',
  };
}

/** Network fallback for year-only Advanced Search albums (open-ended year bounds). */
export async function runNetworkAdvancedYearAlbums(
  opts: LocalSearchOpts,
  pageSize = ADVANCED_SEARCH_YEAR_ALBUM_LIMIT,
  serverId?: string | null,
): Promise<SubsonicAlbum[]> {
  const query = yearOnlyAlbumBrowseQuery(opts);
  if (!query) return [];
  const page = await fetchAlbumBrowseNetwork(query, 0, pageSize, serverId);
  return page.albums;
}
