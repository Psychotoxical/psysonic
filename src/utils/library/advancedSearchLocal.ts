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
import { fetchAlbumBrowseNetwork } from './albumBrowseNetwork';
import type { AlbumBrowseQuery } from './albumBrowseTypes';
import { resolveAlbumYearBounds } from './albumYearFilter';
import { libraryIsReady } from './libraryReady';
import { logLibrarySearch, timed } from './libraryDevLog';
import { isLosslessSuffix } from './losslessFormats';
import { albumIsCompilation } from './albumCompilation';
import { OXIMEDIA_MOOD_SEARCH_ENABLED } from './trackEnrichment';

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
    ...(opts.resultType === 'albums' && opts.albumTitleOnly
      ? { queryAlbumTitleOnly: true }
      : {}),
  };
}

/**
 * Cover art id for a library track — mirrors Rust cover backfill
 * (`COALESCE(cover_art_id, album_id)`). Many servers only expose album art.
 */
export function resolveTrackCoverArtId(
  hot: Pick<LibraryTrackDto, 'coverArtId' | 'albumId'>,
  song: Partial<SubsonicSong> = {},
): string | undefined {
  const songArt = typeof song.coverArt === 'string' ? song.coverArt.trim() : '';
  const hotArt = typeof hot.coverArtId === 'string' ? hot.coverArtId.trim() : '';
  // `raw_json` per-disc `coverArt` wins over a stale index `cover_art_id` (often disc 1).
  if (songArt && hotArt && songArt !== hotArt && songArt.startsWith('mf-')) {
    return songArt;
  }
  for (const c of [hot.coverArtId, song.coverArt, hot.albumId, song.albumId]) {
    const id = typeof c === 'string' ? c.trim() : '';
    if (id) return id;
  }
  return undefined;
}

export function trackToSong(t: LibraryTrackDto): SubsonicSong {
  const raw = isObject(t.rawJson) ? t.rawJson : {};
  const resolvedBpm = t.bpm != null && t.bpm > 0 ? t.bpm : undefined;
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
    coverArt: resolveTrackCoverArtId(t),
    year: t.year ?? undefined,
    genre: t.genre ?? undefined,
    suffix: t.suffix ?? undefined,
    bitRate: t.bitRate ?? undefined,
    size: t.sizeBytes ?? undefined,
    starred: t.starredAt != null ? new Date(t.starredAt).toISOString() : undefined,
    userRating: t.userRating ?? undefined,
    playCount: t.playCount ?? undefined,
    bpm: resolvedBpm,
    isrc: t.isrc ?? undefined,
    albumArtist: t.albumArtist ?? undefined,
  };
  // `rawJson` is the authoritative original song — let it override the
  // hot-column fallbacks (it carries OpenSubsonic extras too).
  const merged: SubsonicSong = { ...base, ...(raw as Partial<SubsonicSong>) };
  const coverArt = resolveTrackCoverArtId(t, merged);
  if (coverArt) merged.coverArt = coverArt;
  if (resolvedBpm != null) merged.bpm = resolvedBpm;
  if (t.bpmSource === 'analysis' || t.bpmSource === 'tag') {
    merged.localBpmSource = t.bpmSource;
  }
  if (t.serverId) merged.serverId = t.serverId;
  return merged;
}

/** Merge `raw_json` without nullish Subsonic fields wiping hot columns (e.g. year). */
function mergeAlbumRawJson(base: SubsonicAlbum, raw: Partial<SubsonicAlbum>): SubsonicAlbum {
  const merged = { ...base } as SubsonicAlbum & Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (value != null && value !== '') merged[key] = value;
  }
  return merged;
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
  const merged = mergeAlbumRawJson(base, raw as Partial<SubsonicAlbum>);
  if (albumIsCompilation(merged)) merged.isCompilation = true;
  return merged;
}

export function artistToArtist(ar: LibraryArtistDto): SubsonicArtist {
  const raw = isObject(ar.rawJson) ? ar.rawJson : {};
  const base: SubsonicArtist = {
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
): Promise<LocalAdvancedSearchPage | null> {
  const q = opts.query.trim();
  if (!q) return null;
  const rt = opts.resultType;

  const r = await search(q, {
    artistCount: 30,
    albumCount: 50,
    songCount: songsLimit,
  });

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

/** Local index first; retry without the ready gate when sync is still catching up. */
export async function tryRunLocalAdvancedSearch(
  serverId: string | null | undefined,
  opts: LocalSearchOpts,
  songsLimit: number,
  suppressLog = false,
): Promise<LocalAdvancedSearchPage | null> {
  const readyPage = await runLocalAdvancedSearch(
    serverId,
    opts,
    songsLimit,
    false,
    true,
    suppressLog,
  );
  if (readyPage) return readyPage;
  return runLocalAdvancedSearch(serverId, opts, songsLimit, true, true, suppressLog);
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
): Promise<SubsonicAlbum[]> {
  const query = yearOnlyAlbumBrowseQuery(opts);
  if (!query) return [];
  const page = await fetchAlbumBrowseNetwork(query, 0, pageSize);
  return page.albums;
}
