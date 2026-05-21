/**
 * Advanced Search against the local library index (spec §5.13 / F2).
 *
 * Maps the AdvancedSearch UI inputs to a `library_advanced_search` request and
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
  type LibraryAdvancedSearchRequest,
  type LibraryAlbumDto,
  type LibraryArtistDto,
  type LibraryEntityType,
  type LibraryFilterClause,
  type LibraryTrackDto,
} from '../../api/library';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../../api/subsonicTypes';
import { search } from '../../api/subsonicSearch';
import { libraryScopeForServer } from '../../api/subsonicClient';
import { libraryIsReady } from './libraryReady';
import { logLibrarySearch, timed } from './libraryDevLog';

export type AdvancedResultType = 'all' | 'artists' | 'albums' | 'songs';

/** UI opts for Advanced Search — BPM filter hidden until enrichment ships. */
export interface LocalSearchOpts {
  query: string;
  genre: string;
  yearFrom: string;
  yearTo: string;
  resultType: AdvancedResultType;
}

export interface LocalAdvancedSearchPage {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
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
  return filters;
}

function buildRequest(
  serverId: string,
  opts: LocalSearchOpts,
  entityTypes: LibraryEntityType[],
  limit: number,
  offset: number,
  skipTotals = false,
): LibraryAdvancedSearchRequest {
  const q = opts.query.trim();
  const libraryScope = libraryScopeForServer(serverId);
  return {
    serverId,
    libraryScope: libraryScope ?? undefined,
    query: q || undefined,
    entityTypes,
    filters: buildFilters(opts),
    limit,
    offset,
    skipTotals,
  };
}

export function trackToSong(t: LibraryTrackDto): SubsonicSong {
  const raw = isObject(t.rawJson) ? t.rawJson : {};
  const base: SubsonicSong = {
    id: t.id,
    title: t.title,
    artist: t.artist ?? '',
    album: t.album,
    albumId: t.albumId ?? '',
    artistId: t.artistId ?? undefined,
    duration: t.durationSec,
    track: t.trackNumber ?? undefined,
    discNumber: t.discNumber ?? undefined,
    coverArt: t.coverArtId ?? undefined,
    year: t.year ?? undefined,
    genre: t.genre ?? undefined,
    suffix: t.suffix ?? undefined,
    bitRate: t.bitRate ?? undefined,
    size: t.sizeBytes ?? undefined,
    starred: t.starredAt != null ? new Date(t.starredAt).toISOString() : undefined,
    userRating: t.userRating ?? undefined,
    playCount: t.playCount ?? undefined,
    bpm: t.bpm ?? undefined,
    isrc: t.isrc ?? undefined,
    albumArtist: t.albumArtist ?? undefined,
  };
  // `rawJson` is the authoritative original song — let it override the
  // hot-column fallbacks (it carries OpenSubsonic extras too).
  return { ...base, ...(raw as Partial<SubsonicSong>) };
}

export function albumToAlbum(a: LibraryAlbumDto): SubsonicAlbum {
  const raw = isObject(a.rawJson) ? a.rawJson : {};
  const base: SubsonicAlbum = {
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
  return { ...base, ...(raw as Partial<SubsonicAlbum>) };
}

export function artistToArtist(ar: LibraryArtistDto): SubsonicArtist {
  const raw = isObject(ar.rawJson) ? ar.rawJson : {};
  const base: SubsonicArtist = {
    id: ar.id,
    name: ar.name,
    albumCount: ar.albumCount ?? undefined,
    coverArt: ar.id,
  };
  return { ...base, ...(raw as Partial<SubsonicArtist>) };
}

/**
 * Network search3 path for Advanced Search free-text (mirrors AdvancedSearch.tsx filters).
 */
export async function runNetworkAdvancedTextSearch(
  opts: LocalSearchOpts,
  songsLimit: number,
): Promise<LocalAdvancedSearchPage | null> {
  const q = opts.query.trim();
  if (!q) return null;
  const g = opts.genre;
  const from = opts.yearFrom ? parseInt(opts.yearFrom, 10) : null;
  const to = opts.yearTo ? parseInt(opts.yearTo, 10) : null;
  const rt = opts.resultType;

  const r = await search(q, {
    artistCount: 30,
    albumCount: 50,
    songCount: songsLimit,
  });

  let artists = r.artists;
  let albums = r.albums;
  let songs = r.songs;

  if (g) songs = songs.filter(s => s.genre?.toLowerCase() === g.toLowerCase());
  if (from !== null) songs = songs.filter(s => !s.year || s.year >= from);
  if (to !== null) songs = songs.filter(s => !s.year || s.year <= to);

  if (g) albums = albums.filter(a => a.genre?.toLowerCase() === g.toLowerCase());
  if (from !== null) albums = albums.filter(a => !a.year || a.year >= from);
  if (to !== null) albums = albums.filter(a => !a.year || a.year <= to);

  return {
    artists: rt === 'albums' || rt === 'songs' ? [] : artists,
    albums: rt === 'artists' || rt === 'songs' ? [] : albums,
    songs: rt === 'artists' || rt === 'albums' ? [] : songs,
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
  skipReadyCheck = false,
  skipTotals = true,
  suppressLog = false,
): Promise<LocalAdvancedSearchPage | null> {
  if (!serverId) return null;
  if (!skipReadyCheck && !(await libraryIsReady(serverId))) return null;
  const t0 = performance.now();
  try {
    const req = buildRequest(
      serverId,
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
): Promise<SubsonicSong[] | null> {
  if (!serverId) return null;
  if (!(await libraryIsReady(serverId))) return null;
  try {
    const resp = await libraryAdvancedSearch({
      serverId,
      libraryScope: libraryScopeForServer(serverId),
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
): Promise<SubsonicSong[]> {
  const req = buildRequest(serverId, opts, ['track'], pageSize, offset, true);
  const resp = await libraryAdvancedSearch(req);
  return resp.tracks.map(trackToSong);
}
