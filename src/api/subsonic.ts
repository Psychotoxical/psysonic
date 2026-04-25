import axios from 'axios';
import md5 from 'md5';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import { version } from '../../package.json';
import {
  isNavidromeAudiomuseSoftwareEligible,
  type InstantMixProbeResult,
  type SubsonicServerIdentity,
} from '../utils/subsonicServerIdentity';

const SUBSONIC_CLIENT = `psysonic/${version}`;

// ─── Secure random salt ────────────────────────────────────────
function secureRandomSalt(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Token Auth ───────────────────────────────────────────────
function getAuthParams(username: string, password: string) {
  const salt = secureRandomSalt();
  const token = md5(password + salt);
  return { u: username, t: token, s: salt, v: '1.16.1', c: SUBSONIC_CLIENT, f: 'json' };
}

export function getClient() {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  if (!baseUrl) throw new Error('No server configured');
  const params = getAuthParams(server?.username ?? '', server?.password ?? '');
  return { baseUrl: `${baseUrl}/rest`, params };
}

async function api<T>(endpoint: string, extra: Record<string, unknown> = {}, timeout = 15000): Promise<T> {
  const { baseUrl, params } = getClient();
  const resp = await axios.get(`${baseUrl}/${endpoint}`, {
    params: { ...params, ...extra },
    paramsSerializer: { indexes: null },
    timeout,
  });
  const data = resp.data?.['subsonic-response'];
  if (!data) throw new Error('Invalid response from server (possibly not a Subsonic server)');
  if (data.status !== 'ok') throw new Error(data.error?.message ?? 'Subsonic API error');
  return data as T;
}

/** Optional `musicFolderId` when the user narrowed browsing to one Subsonic library (see `getMusicFolders`). */
export function libraryFilterParams(): Record<string, string | number> {
  const { activeServerId, musicLibraryFilterByServer } = useAuthStore.getState();
  if (!activeServerId) return {};
  const f = musicLibraryFilterByServer[activeServerId];
  if (f === undefined || f === 'all') return {};
  return { musicFolderId: f };
}

// ─── Types ────────────────────────────────────────────────────
export interface SubsonicAlbum {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  coverArt?: string;
  songCount: number;
  duration: number;
  playCount?: number;
  year?: number;
  genre?: string;
  starred?: string;
  recordLabel?: string;
  created?: string;
  /** Present on some servers (e.g. OpenSubsonic) for album-level rating. */
  userRating?: number;
  /** OpenSubsonic: true when the album is tagged as a compilation. */
  isCompilation?: boolean;
}

/** OpenSubsonic `artists` / `albumArtists` entries on a child song (may include `userRating`). */
export interface SubsonicOpenArtistRef {
  id?: string;
  name?: string;
  userRating?: number;
}

export interface SubsonicSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumId: string;
  artistId?: string;
  duration: number;
  track?: number;
  discNumber?: number;
  coverArt?: string;
  year?: number;
  userRating?: number;
  /** Some OpenSubsonic responses attach parent ratings on child songs. */
  albumUserRating?: number;
  artistUserRating?: number;
  artists?: SubsonicOpenArtistRef[];
  albumArtists?: SubsonicOpenArtistRef[];
  // Audio technical info
  bitRate?: number;
  suffix?: string;
  contentType?: string;
  size?: number;
  samplingRate?: number;
  bitDepth?: number;
  channelCount?: number;
  starred?: string;
  genre?: string;
  path?: string;
  albumArtist?: string;
  /** ISRC code when available (e.g., Navidrome) */
  isrc?: string;
  replayGain?: {
    trackGain?: number;
    albumGain?: number;
    trackPeak?: number;
    albumPeak?: number;
  };
  /** OpenSubsonic: structured composer credit (string for back-compat). */
  displayComposer?: string;
  /** OpenSubsonic: structured contributors list — Navidrome ≥ 0.55. */
  contributors?: Array<{
    role: string;
    subRole?: string;
    artist: { id?: string; name: string };
  }>;
}

export interface InternetRadioStation {
  id: string;
  name: string;
  streamUrl: string;
  homepageUrl?: string;
  coverArt?: string; // Navidrome v0.61.0+
}

export interface RadioBrowserStation {
  stationuuid: string;
  name: string;
  url: string;
  favicon: string;
  tags: string;
}

export interface SubsonicPlaylist {
  id: string;
  name: string;
  songCount: number;
  duration: number;
  created: string;
  changed: string;
  owner?: string;
  public?: boolean;
  comment?: string;
  coverArt?: string;
}

export interface SubsonicNowPlaying extends SubsonicSong {
  username: string;
  minutesAgo: number;
  playerId: number;
  playerName: string;
}

export interface SubsonicArtist {
  id: string;
  name: string;
  albumCount?: number;
  coverArt?: string;
  starred?: string;
  /** Present on some servers (e.g. OpenSubsonic) for artist-level rating. */
  userRating?: number;
}

export interface SubsonicGenre {
  value: string;
  songCount: number;
  albumCount: number;
}

export interface SubsonicMusicFolder {
  id: string;
  name: string;
}

export interface SubsonicArtistInfo {
  biography?: string;
  musicBrainzId?: string;
  lastFmUrl?: string;
  smallImageUrl?: string;
  mediumImageUrl?: string;
  largeImageUrl?: string;
  similarArtist?: Array<{ id: string; name: string; albumCount?: number }>;
}

// ─── API Methods ──────────────────────────────────────────────
export interface SubsonicDirectoryEntry {
  id: string;
  parent?: string;
  title: string;
  isDir: boolean;
  album?: string;
  artist?: string;
  albumId?: string;
  artistId?: string;
  coverArt?: string;
  duration?: number;
  track?: number;
  year?: number;
  bitRate?: number;
  suffix?: string;
  size?: number;
  genre?: string;
  starred?: string;
  userRating?: number;
}

export interface SubsonicDirectory {
  id: string;
  parent?: string;
  name: string;
  child: SubsonicDirectoryEntry[];
}

export async function getMusicDirectory(id: string): Promise<SubsonicDirectory> {
  const data = await api<{ directory: { id: string; parent?: string; name: string; child?: SubsonicDirectoryEntry | SubsonicDirectoryEntry[] } }>(
    'getMusicDirectory.view',
    { id },
  );
  const dir = data.directory;
  const raw = dir.child;
  const child: SubsonicDirectoryEntry[] = !raw ? [] : Array.isArray(raw) ? raw : [raw];
  return { id: dir.id, parent: dir.parent, name: dir.name, child };
}

/** Returns the top-level artist/directory entries for a music folder root.
 *  Music folder IDs from getMusicFolders() are NOT valid getMusicDirectory IDs —
 *  use getIndexes.view with musicFolderId instead. */
export async function getMusicIndexes(musicFolderId: string): Promise<SubsonicDirectoryEntry[]> {
  type IndexArtist = { id: string; name: string; coverArt?: string };
  type IndexEntry  = { name: string; artist?: IndexArtist | IndexArtist[] };
  const data = await api<{ indexes: { index?: IndexEntry | IndexEntry[] } }>(
    'getIndexes.view',
    { musicFolderId },
  );
  const raw = data.indexes?.index;
  if (!raw) return [];
  const indices = Array.isArray(raw) ? raw : [raw];
  const entries: SubsonicDirectoryEntry[] = [];
  for (const idx of indices) {
    const artists = idx.artist ? (Array.isArray(idx.artist) ? idx.artist : [idx.artist]) : [];
    for (const a of artists) {
      entries.push({ id: a.id, title: a.name, isDir: true, coverArt: a.coverArt });
    }
  }
  return entries;
}

export async function getMusicFolders(): Promise<SubsonicMusicFolder[]> {
  const data = await api<{ musicFolders: { musicFolder: SubsonicMusicFolder | SubsonicMusicFolder[] } }>(
    'getMusicFolders.view',
  );
  const raw = data.musicFolders?.musicFolder;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(f => ({
    id: String((f as { id: string | number }).id),
    name: (f as { name?: string }).name ?? 'Library',
  }));
}

export async function ping(): Promise<boolean> {
  try {
    await api('ping.view');
    return true;
  } catch {
    return false;
  }
}

export type PingWithCredentialsResult = SubsonicServerIdentity & { ok: boolean };

/** Test a connection with explicit credentials — does NOT depend on store state. */
export async function pingWithCredentials(
  serverUrl: string,
  username: string,
  password: string,
): Promise<PingWithCredentialsResult> {
  try {
    const base = serverUrl.startsWith('http') ? serverUrl.replace(/\/$/, '') : `http://${serverUrl.replace(/\/$/, '')}`;
    const salt = secureRandomSalt();
    const token = md5(password + salt);
    const resp = await axios.get(`${base}/rest/ping.view`, {
      params: { u: username, t: token, s: salt, v: '1.16.1', c: SUBSONIC_CLIENT, f: 'json' },
      paramsSerializer: { indexes: null },
      timeout: 15000,
    });
    const data = resp.data?.['subsonic-response'];
    const ok = data?.status === 'ok';
    return {
      ok,
      type: typeof data?.type === 'string' ? data.type : undefined,
      serverVersion: typeof data?.serverVersion === 'string' ? data.serverVersion : undefined,
      openSubsonic: data?.openSubsonic === true,
    };
  } catch {
    return { ok: false };
  }
}

function restBaseFromUrl(serverUrl: string): string {
  const base = serverUrl.startsWith('http') ? serverUrl.replace(/\/$/, '') : `http://${serverUrl.replace(/\/$/, '')}`;
  return `${base}/rest`;
}

async function apiWithCredentials<T>(
  serverUrl: string,
  username: string,
  password: string,
  endpoint: string,
  extra: Record<string, unknown> = {},
  timeout = 15000,
): Promise<T> {
  const params = { ...getAuthParams(username, password), ...extra };
  const resp = await axios.get(`${restBaseFromUrl(serverUrl)}/${endpoint}`, {
    params,
    paramsSerializer: { indexes: null },
    timeout,
  });
  const data = resp.data?.['subsonic-response'];
  if (!data) throw new Error('Invalid response from server (possibly not a Subsonic server)');
  if (data.status !== 'ok') throw new Error(data.error?.message ?? 'Subsonic API error');
  return data as T;
}

const INSTANT_MIX_PROBE_RANDOM_SIZE = 8;
const INSTANT_MIX_PROBE_SIMILAR_COUNT = 12;
const INSTANT_MIX_PROBE_MAX_TRACKS = 4;

/**
 * Probes whether `getSimilarSongs` returns any tracks (Instant Mix / Navidrome agent chain).
 * Does not pass `musicFolderId` — probes the whole library as seen by the account.
 * Note: if `ND_AGENTS` includes Last.fm, a positive result does not prove AudioMuse alone.
 */
export async function probeInstantMixWithCredentials(
  serverUrl: string,
  username: string,
  password: string,
): Promise<InstantMixProbeResult> {
  try {
    const data = await apiWithCredentials<{ randomSongs: { song: SubsonicSong | SubsonicSong[] } }>(
      serverUrl,
      username,
      password,
      'getRandomSongs.view',
      { size: INSTANT_MIX_PROBE_RANDOM_SIZE, _t: Date.now() },
      12000,
    );
    const raw = data.randomSongs?.song;
    const songs: SubsonicSong[] = !raw ? [] : Array.isArray(raw) ? raw : [raw];
    if (songs.length === 0) return 'skipped';

    let anyError = false;
    for (const song of songs.slice(0, INSTANT_MIX_PROBE_MAX_TRACKS)) {
      try {
        const simData = await apiWithCredentials<{ similarSongs: { song: SubsonicSong | SubsonicSong[] } }>(
          serverUrl,
          username,
          password,
          'getSimilarSongs.view',
          { id: song.id, count: INSTANT_MIX_PROBE_SIMILAR_COUNT },
          12000,
        );
        const sRaw = simData.similarSongs?.song;
        const list: SubsonicSong[] = !sRaw ? [] : Array.isArray(sRaw) ? sRaw : [sRaw];
        if (list.some(s => s.id !== song.id)) return 'ok';
      } catch {
        anyError = true;
      }
    }
    return anyError ? 'error' : 'empty';
  } catch {
    return 'error';
  }
}

/** After a successful ping, probe Instant Mix in the background (Navidrome ≥ 0.60 only). */
export function scheduleInstantMixProbeForServer(
  serverId: string,
  serverUrl: string,
  username: string,
  password: string,
  identity: SubsonicServerIdentity,
): void {
  if (!isNavidromeAudiomuseSoftwareEligible(identity)) return;
  void probeInstantMixWithCredentials(serverUrl, username, password).then(result =>
    useAuthStore.getState().setInstantMixProbe(serverId, result),
  );
}

export async function getRandomAlbums(size = 6): Promise<SubsonicAlbum[]> {
  const data = await api<{ albumList2: { album: SubsonicAlbum[] } }>('getAlbumList2.view', {
    type: 'random',
    size,
    ...libraryFilterParams(),
  });
  return data.albumList2?.album ?? [];
}

export async function getAlbumList(
  type: 'random' | 'newest' | 'alphabeticalByName' | 'alphabeticalByArtist' | 'byYear' | 'recent' | 'starred' | 'frequent' | 'highest',
  size = 30,
  offset = 0,
  extra: Record<string, unknown> = {}
): Promise<SubsonicAlbum[]> {
  const data = await api<{ albumList2: { album: SubsonicAlbum[] } }>('getAlbumList2.view', {
    type,
    size,
    offset,
    _t: Date.now(),
    ...libraryFilterParams(),
    ...extra,
  });
  return data.albumList2?.album ?? [];
}

/**
 * Navidrome (and some servers) ignore `musicFolderId` on getSimilarSongs / getSimilarSongs2 / getTopSongs,
 * so similar tracks can leak from other libraries. When the user scoped to one folder, we keep a set of
 * album ids in that scope (paginated getAlbumList2) and drop songs whose albumId is not in the set.
 */
let scopedLibraryAlbumIdCache: {
  serverId: string;
  folderId: string;
  filterVersion: number;
  ids: Set<string>;
} | null = null;

async function albumIdsInActiveLibraryScope(): Promise<Set<string> | null> {
  const { activeServerId, musicLibraryFilterByServer, musicLibraryFilterVersion } = useAuthStore.getState();
  if (!activeServerId) return null;
  const folder = musicLibraryFilterByServer[activeServerId];
  if (folder === undefined || folder === 'all') {
    scopedLibraryAlbumIdCache = null;
    return null;
  }
  const hit = scopedLibraryAlbumIdCache;
  if (
    hit &&
    hit.serverId === activeServerId &&
    hit.folderId === folder &&
    hit.filterVersion === musicLibraryFilterVersion
  ) {
    return hit.ids;
  }
  const ids = new Set<string>();
  const pageSize = 500;
  let offset = 0;
  for (;;) {
    const albums = await getAlbumList('alphabeticalByName', pageSize, offset);
    for (const a of albums) ids.add(a.id);
    if (albums.length < pageSize) break;
    offset += pageSize;
    if (offset > 500_000) break;
  }
  scopedLibraryAlbumIdCache = {
    serverId: activeServerId,
    folderId: folder,
    filterVersion: musicLibraryFilterVersion,
    ids,
  };
  return ids;
}

export async function filterSongsToActiveLibrary(songs: SubsonicSong[]): Promise<SubsonicSong[]> {
  const allowed = await albumIdsInActiveLibraryScope();
  if (!allowed || allowed.size === 0) return songs;
  return songs.filter(s => s.albumId && allowed.has(s.albumId));
}

/** When scoped to one library, ask the server for more similar tracks — many will be filtered out client-side. */
function similarSongsRequestCount(desired: number): number {
  const { activeServerId, musicLibraryFilterByServer } = useAuthStore.getState();
  const f = activeServerId ? musicLibraryFilterByServer[activeServerId] : undefined;
  if (f === undefined || f === 'all') return desired;
  return Math.min(300, Math.max(desired, desired * 4));
}

export async function getRandomSongs(size = 50, genre?: string, timeout = 15000): Promise<SubsonicSong[]> {
  const params: Record<string, string | number> = { size, _t: Date.now(), ...libraryFilterParams() };
  if (genre) params.genre = genre;
  const data = await api<{ randomSongs: { song: SubsonicSong[] } }>('getRandomSongs.view', params, timeout);
  return data.randomSongs?.song ?? [];
}

export interface RandomSongsFilters {
  size?: number;
  genre?: string;
  fromYear?: number;
  toYear?: number;
}

/** Extended random song fetch with server-side year/genre filtering. */
export async function getRandomSongsFiltered(
  filters: RandomSongsFilters,
  timeout = 15000,
): Promise<SubsonicSong[]> {
  const params: Record<string, string | number> = {
    size: filters.size ?? 50,
    _t: Date.now(),
    ...libraryFilterParams(),
  };
  if (filters.genre) params.genre = filters.genre;
  if (typeof filters.fromYear === 'number') params.fromYear = filters.fromYear;
  if (typeof filters.toYear === 'number') params.toYear = filters.toYear;
  const data = await api<{ randomSongs: { song: SubsonicSong[] } }>('getRandomSongs.view', params, timeout);
  return data.randomSongs?.song ?? [];
}

export async function getSong(id: string): Promise<SubsonicSong | null> {
  try {
    const data = await api<{ song: SubsonicSong }>('getSong.view', { id });
    return data.song ?? null;
  } catch {
    return null;
  }
}

export async function getAlbum(id: string): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] }> {
  const data = await api<{ album: SubsonicAlbum & { song: SubsonicSong[] } }>('getAlbum.view', { id });
  const { song, ...album } = data.album;
  return { album, songs: song ?? [] };
}

const MIX_RATING_PREFETCH_CONCURRENCY = 8;
const RATING_CACHE_TTL = 7 * 60 * 1000; // 7 minutes
const ratingCache = new Map<string, { value: number | undefined; expiresAt: number }>();

function getCachedRating(key: string): number | undefined | null {
  const entry = ratingCache.get(key);
  if (!entry) return null; // cache miss
  if (Date.now() > entry.expiresAt) { ratingCache.delete(key); return null; }
  return entry.value;
}

function setCachedRating(key: string, value: number | undefined): void {
  ratingCache.set(key, { value, expiresAt: Date.now() + RATING_CACHE_TTL });
}

function parseEntityUserRating(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/** Parallel `getArtist` calls to fill mix/album filters when list endpoints omit ratings. */
export async function prefetchArtistUserRatings(
  ids: string[],
  concurrency = MIX_RATING_PREFETCH_CONCURRENCY,
): Promise<Map<string, number>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, number>();
  if (!unique.length) return out;
  const uncached: string[] = [];
  for (const id of unique) {
    const cached = getCachedRating(`artist:${id}`);
    if (cached !== null) { if (cached !== undefined) out.set(id, cached); }
    else uncached.push(id);
  }
  if (!uncached.length) return out;
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= uncached.length) return;
      const id = uncached[i];
      try {
        const { artist } = await getArtist(id);
        const r = parseEntityUserRating(artist.userRating);
        setCachedRating(`artist:${id}`, r);
        if (r !== undefined) out.set(id, r);
      } catch {
        /* ignore */
      }
    }
  }
  const nWorkers = Math.min(concurrency, uncached.length);
  await Promise.all(Array.from({ length: nWorkers }, () => worker()));
  return out;
}

/** Parallel `getAlbum` calls when `albumList2` entries lack `userRating`. */
export async function prefetchAlbumUserRatings(
  ids: string[],
  concurrency = MIX_RATING_PREFETCH_CONCURRENCY,
): Promise<Map<string, number>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, number>();
  if (!unique.length) return out;
  const uncached: string[] = [];
  for (const id of unique) {
    const cached = getCachedRating(`album:${id}`);
    if (cached !== null) { if (cached !== undefined) out.set(id, cached); }
    else uncached.push(id);
  }
  if (!uncached.length) return out;
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= uncached.length) return;
      const id = uncached[i];
      try {
        const { album } = await getAlbum(id);
        const r = parseEntityUserRating(album.userRating);
        setCachedRating(`album:${id}`, r);
        if (r !== undefined) out.set(id, r);
      } catch {
        /* ignore */
      }
    }
  }
  const nWorkers = Math.min(concurrency, uncached.length);
  await Promise.all(Array.from({ length: nWorkers }, () => worker()));
  return out;
}

/** Paginated album stats for Statistics (playtime, counts, genre breakdown). Same TTL as rating prefetch. */
export interface StatisticsLibraryAggregates {
  playtimeSec: number;
  albumsCounted: number;
  songsCounted: number;
  capped: boolean;
  genres: SubsonicGenre[];
}

/** Key `prefix:serverId:folder` — Statistics caches share scope with `libraryFilterParams()`. */
function statisticsPageCacheKey(prefix: string): string | null {
  const { activeServerId, musicLibraryFilterByServer } = useAuthStore.getState();
  if (!activeServerId) return null;
  const folder = musicLibraryFilterByServer[activeServerId] ?? 'all';
  const folderPart = folder === 'all' ? 'all' : folder;
  return `${prefix}:${activeServerId}:${folderPart}`;
}

const statisticsAggregatesCache = new Map<string, { value: StatisticsLibraryAggregates; expiresAt: number }>();

/**
 * Walks up to 5000 newest albums (scoped by library filter). Cached per server + music folder for
 * 7 minutes (same `RATING_CACHE_TTL` as album/artist rating prefetch).
 * Unknown/missing album genre is stored as `value: ''`; UI should map to i18n.
 */
export async function fetchStatisticsLibraryAggregates(): Promise<StatisticsLibraryAggregates> {
  const key = statisticsPageCacheKey('statsAgg');
  if (key) {
    const hit = statisticsAggregatesCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
  }

  let playtimeSec = 0;
  let albumsCounted = 0;
  let songsCounted = 0;
  const genreAgg = new Map<string, { songCount: number; albumCount: number }>();
  const pageSize = 500;
  const capped = false;
  let offset = 0;
  let nextPage = getAlbumList('alphabeticalByName', pageSize, 0);
  for (;;) {
    try {
      const albums = await nextPage;
      for (const a of albums) {
        playtimeSec += a.duration ?? 0;
        albumsCounted += 1;
        const sc = a.songCount ?? 0;
        songsCounted += sc;
        const label = (a.genre?.trim()) ? a.genre.trim() : '';
        let g = genreAgg.get(label);
        if (!g) {
          g = { songCount: 0, albumCount: 0 };
          genreAgg.set(label, g);
        }
        g.songCount += sc;
        g.albumCount += 1;
      }
      if (albums.length < pageSize) break;
      offset += pageSize;
      nextPage = getAlbumList('alphabeticalByName', pageSize, offset);
    } catch {
      break;
    }
  }

  const genres: SubsonicGenre[] = [...genreAgg.entries()]
    .map(([value, c]) => ({ value, songCount: c.songCount, albumCount: c.albumCount }))
    .sort((a, b) => b.songCount - a.songCount);

  const result: StatisticsLibraryAggregates = {
    playtimeSec,
    albumsCounted,
    songsCounted,
    capped,
    genres,
  };
  if (key) {
    statisticsAggregatesCache.set(key, { value: result, expiresAt: Date.now() + RATING_CACHE_TTL });
  }
  return result;
}

/** Recent / frequent / highest album strips + artist count for Statistics. */
export interface StatisticsOverviewData {
  recent: SubsonicAlbum[];
  frequent: SubsonicAlbum[];
  highest: SubsonicAlbum[];
  artistCount: number;
}

const statisticsOverviewCache = new Map<string, { value: StatisticsOverviewData; expiresAt: number }>();

export async function fetchStatisticsOverview(): Promise<StatisticsOverviewData> {
  const key = statisticsPageCacheKey('statsOverview');
  if (key) {
    const hit = statisticsOverviewCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
  }
  const [recent, frequent, highest, artists] = await Promise.all([
    getAlbumList('recent', 20).catch(() => [] as SubsonicAlbum[]),
    getAlbumList('frequent', 12).catch(() => [] as SubsonicAlbum[]),
    getAlbumList('highest', 12).catch(() => [] as SubsonicAlbum[]),
    getArtists().catch(() => [] as SubsonicArtist[]),
  ]);
  const result: StatisticsOverviewData = {
    recent,
    frequent,
    highest,
    artistCount: artists.length,
  };
  if (key) {
    statisticsOverviewCache.set(key, { value: result, expiresAt: Date.now() + RATING_CACHE_TTL });
  }
  return result;
}

/** Format (suffix) histogram from a random sample for Statistics. */
export interface StatisticsFormatSample {
  rows: { format: string; count: number }[];
  sampleSize: number;
}

const statisticsFormatCache = new Map<string, { value: StatisticsFormatSample; expiresAt: number }>();

export async function fetchStatisticsFormatSample(): Promise<StatisticsFormatSample> {
  const key = statisticsPageCacheKey('statsFormat');
  if (key) {
    const hit = statisticsFormatCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
  }
  const songs = await getRandomSongs(500).catch(() => [] as SubsonicSong[]);
  const counts: Record<string, number> = {};
  for (const song of songs) {
    const fmt = song.suffix?.toUpperCase() ?? 'Unknown';
    counts[fmt] = (counts[fmt] ?? 0) + 1;
  }
  const rows = Object.entries(counts)
    .map(([format, count]) => ({ format, count }))
    .sort((a, b) => b.count - a.count);
  const result: StatisticsFormatSample = { rows, sampleSize: songs.length };
  if (key) {
    statisticsFormatCache.set(key, { value: result, expiresAt: Date.now() + RATING_CACHE_TTL });
  }
  return result;
}

export async function getArtists(): Promise<SubsonicArtist[]> {
  const data = await api<{ artists: { index: any } }>('getArtists.view', {
    ...libraryFilterParams(),
  });
  const rawIdx = data.artists?.index;
  const indices = Array.isArray(rawIdx) ? rawIdx : (rawIdx ? [rawIdx] : []);
  const artists: SubsonicArtist[] = [];
  for (const idx of indices) {
    const rawArt = idx.artist;
    const arr = Array.isArray(rawArt) ? rawArt : (rawArt ? [rawArt] : []);
    artists.push(...arr);
  }
  return artists;
}

export async function getArtist(id: string): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] }> {
  const data = await api<{ artist: SubsonicArtist & { album: SubsonicAlbum[] } }>('getArtist.view', { id });
  const { album, ...artist } = data.artist;
  return { artist, albums: album ?? [] };
}

export async function getArtistInfo(id: string, options?: { similarArtistCount?: number }): Promise<SubsonicArtistInfo> {
  const count = options?.similarArtistCount ?? 5;
  const data = await api<{ artistInfo2: SubsonicArtistInfo }>('getArtistInfo2.view', { id, count, ...libraryFilterParams() });
  return data.artistInfo2 ?? {};
}

export async function getTopSongs(artist: string): Promise<SubsonicSong[]> {
  try {
    const { activeServerId, musicLibraryFilterByServer } = useAuthStore.getState();
    const scoped = activeServerId && musicLibraryFilterByServer[activeServerId] && musicLibraryFilterByServer[activeServerId] !== 'all';
    const topCount = scoped ? 20 : 5;
    const data = await api<{ topSongs: { song: SubsonicSong[] } }>('getTopSongs.view', { artist, count: topCount, ...libraryFilterParams() });
    const raw = data.topSongs?.song ?? [];
    const filtered = await filterSongsToActiveLibrary(raw);
    return filtered.slice(0, 5);
  } catch {
    return [];
  }
}

export async function getSimilarSongs2(id: string, count = 50): Promise<SubsonicSong[]> {
  try {
    const requestCount = similarSongsRequestCount(count);
    const data = await api<{ similarSongs2: { song: SubsonicSong[] } }>('getSimilarSongs2.view', { id, count: requestCount, ...libraryFilterParams() });
    const raw = data.similarSongs2?.song ?? [];
    const filtered = await filterSongsToActiveLibrary(raw);
    return filtered.slice(0, count);
  } catch {
    return [];
  }
}

/** Similar tracks for a song id (Subsonic `getSimilarSongs`) — Navidrome + AudioMuse Instant Mix. */
export async function getSimilarSongs(id: string, count = 50): Promise<SubsonicSong[]> {
  try {
    const requestCount = similarSongsRequestCount(count);
    const data = await api<{ similarSongs: { song: SubsonicSong | SubsonicSong[] } }>('getSimilarSongs.view', { id, count: requestCount, ...libraryFilterParams() });
    const raw = data.similarSongs?.song;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const filtered = await filterSongsToActiveLibrary(list);
    return filtered.slice(0, count);
  } catch {
    return [];
  }
}

export async function getGenres(): Promise<SubsonicGenre[]> {
  const data = await api<{ genres: { genre: SubsonicGenre | SubsonicGenre[] } }>('getGenres.view');
  const raw = data.genres?.genre;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export async function getAlbumsByGenre(genre: string, size = 50, offset = 0): Promise<SubsonicAlbum[]> {
  const data = await api<{ albumList2: { album: SubsonicAlbum | SubsonicAlbum[] } }>('getAlbumList2.view', {
    type: 'byGenre',
    genre,
    size,
    offset,
    _t: Date.now(),
    ...libraryFilterParams(),
  });
  const raw = data.albumList2?.album;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export interface SearchResults {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
}

export interface StarredResults {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
}

export async function getStarred(): Promise<StarredResults> {
  const data = await api<{
    starred2: {
      artist?: SubsonicArtist[];
      album?: SubsonicAlbum[];
      song?: SubsonicSong[];
    }
  }>('getStarred2.view', { ...libraryFilterParams() });
  const r = data.starred2 ?? {};
  return { artists: r.artist ?? [], albums: r.album ?? [], songs: r.song ?? [] };
}

export async function star(id: string, type: 'song' | 'album' | 'artist' = 'album'): Promise<void> {
  const params: Record<string, string> = {};
  if (type === 'song') params.id = id;
  if (type === 'album') params.albumId = id;
  if (type === 'artist') params.artistId = id;
  await api('star.view', params);
}

export async function unstar(id: string, type: 'song' | 'album' | 'artist' = 'album'): Promise<void> {
  const params: Record<string, string> = {};
  if (type === 'song') params.id = id;
  if (type === 'album') params.albumId = id;
  if (type === 'artist') params.artistId = id;
  await api('unstar.view', params);
}

export async function search(query: string, options?: { albumCount?: number; artistCount?: number; songCount?: number }): Promise<SearchResults> {
  if (!query.trim()) return { artists: [], albums: [], songs: [] };
  const data = await api<{
    searchResult3: {
      artist?: SubsonicArtist[];
      album?: SubsonicAlbum[];
      song?: SubsonicSong[];
    };
  }>('search3.view', {
    query,
    artistCount: options?.artistCount ?? 5,
    albumCount: options?.albumCount ?? 5,
    songCount: options?.songCount ?? 10,
    ...libraryFilterParams(),
  });
  const r = data.searchResult3 ?? {};
  return { artists: r.artist ?? [], albums: r.album ?? [], songs: r.song ?? [] };
}

/**
 * Song-only paginated search3. Tolerates empty query — Navidrome returns all songs
 * ordered by title in that case; strict Subsonic implementations may return nothing.
 * Caller handles empty results gracefully (Tracks page falls back to its random pool).
 */
export async function searchSongsPaged(query: string, songCount: number, songOffset: number): Promise<SubsonicSong[]> {
  const data = await api<{ searchResult3: { song?: SubsonicSong[] } }>('search3.view', {
    query,
    artistCount: 0,
    albumCount: 0,
    songCount,
    songOffset,
    ...libraryFilterParams(),
  });
  return data.searchResult3?.song ?? [];
}

export async function setRating(id: string, rating: number): Promise<void> {
  await api('setRating.view', { id, rating });
}

/** How aggressively we assume `setRating` accepts album/artist ids (OpenSubsonic-style). */
export type EntityRatingSupportLevel = 'track_only' | 'full';

/**
 * Probe server for OpenSubsonic extensions. When `openSubsonic: true`, we treat album/artist
 * rating as supported (same `setRating.view` + entity id); otherwise track-only.
 */
export async function probeEntityRatingSupport(): Promise<EntityRatingSupportLevel> {
  try {
    const data = await api<{ openSubsonic?: boolean; openSubsonicExtensions?: unknown[] }>(
      'getOpenSubsonicExtensions.view',
      {},
      8000,
    );
    if (data.openSubsonic === true) return 'full';
    if (Array.isArray(data.openSubsonicExtensions)) return 'full';
    return 'track_only';
  } catch {
    return 'track_only';
  }
}

export async function scrobbleSong(id: string, time: number): Promise<void> {
  try {
    await api('scrobble.view', { id, time, submission: true });
  } catch {
    // best effort
  }
}

export async function reportNowPlaying(id: string): Promise<void> {
  try {
    await api('scrobble.view', { id, submission: false });
  } catch {
    // best effort
  }
}

// ─── Stream URL ───────────────────────────────────────────────
export function buildStreamUrl(id: string): string {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const salt = secureRandomSalt();
  const token = md5((server?.password ?? '') + salt);
  const p = new URLSearchParams({
    id,
    u: server?.username ?? '',
    t: token, s: salt, v: '1.16.1', c: SUBSONIC_CLIENT, f: 'json',
  });
  return `${baseUrl}/rest/stream.view?${p.toString()}`;
}

/** Stable cache key for cover art — does not include ephemeral auth params. */
export function coverArtCacheKey(id: string, size = 256): string {
  const server = useAuthStore.getState().getActiveServer();
  return `${server?.id ?? '_'}:cover:${id}:${size}`;
}

export function buildCoverArtUrl(id: string, size = 256): string {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const salt = secureRandomSalt();
  const token = md5((server?.password ?? '') + salt);
  const p = new URLSearchParams({
    id, size: String(size),
    u: server?.username ?? '',
    t: token, s: salt, v: '1.16.1', c: SUBSONIC_CLIENT, f: 'json',
  });
  return `${baseUrl}/rest/getCoverArt.view?${p.toString()}`;
}

export function buildDownloadUrl(id: string): string {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const salt = secureRandomSalt();
  const token = md5((server?.password ?? '') + salt);
  const p = new URLSearchParams({
    id,
    u: server?.username ?? '',
    t: token, s: salt, v: '1.16.1', c: SUBSONIC_CLIENT, f: 'json',
  });
  return `${baseUrl}/rest/download.view?${p.toString()}`;
}

// ─── Playlists ────────────────────────────────────────────────
export async function getPlaylists(): Promise<SubsonicPlaylist[]> {
  const data = await api<{ playlists: { playlist: SubsonicPlaylist[] } }>('getPlaylists.view', { _t: Date.now() });
  return data.playlists?.playlist ?? [];
}

export async function getPlaylist(id: string): Promise<{ playlist: SubsonicPlaylist; songs: SubsonicSong[] }> {
  const data = await api<{ playlist: SubsonicPlaylist & { entry: SubsonicSong[] } }>('getPlaylist.view', { id });
  const { entry, ...playlist } = data.playlist;
  return { playlist, songs: entry ?? [] };
}

export async function createPlaylist(name: string, songIds?: string[]): Promise<SubsonicPlaylist> {
  const params: Record<string, unknown> = { name };
  if (songIds && songIds.length > 0) {
    params.songId = songIds;
  }
  const data = await api<{ playlist: SubsonicPlaylist }>('createPlaylist.view', params);
  return data.playlist;
}

export async function updatePlaylist(id: string, songIds: string[], prevCount = 0): Promise<void> {
  if (songIds.length > 0) {
    // createPlaylist with playlistId replaces the existing playlist's songs (Subsonic API 1.14+)
    await api('createPlaylist.view', { playlistId: id, songId: songIds });
  } else if (prevCount > 0) {
    // Axios serialises empty arrays as no params — createPlaylist.view would leave songs unchanged.
    // Use updatePlaylist.view with explicit index removal to clear the list instead.
    await api('updatePlaylist.view', {
      playlistId: id,
      songIndexToRemove: Array.from({ length: prevCount }, (_, i) => i),
    });
  }
}

export async function updatePlaylistMeta(
  id: string,
  name: string,
  comment: string,
  isPublic: boolean,
): Promise<void> {
  await api('updatePlaylist.view', { playlistId: id, name, comment, public: isPublic });
}

export async function uploadPlaylistCoverArt(id: string, file: File): Promise<void> {
  // Navidrome-specific endpoint — handled in Rust to bypass browser CORS restrictions.
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const buffer = await file.arrayBuffer();
  const fileBytes = Array.from(new Uint8Array(buffer));
  await invoke('upload_playlist_cover', {
    serverUrl: baseUrl,
    playlistId: id,
    username: server?.username ?? '',
    password: server?.password ?? '',
    fileBytes,
    mimeType: file.type || 'image/jpeg',
  });
}

export async function uploadArtistImage(id: string, file: File): Promise<void> {
  // Navidrome-specific endpoint — handled in Rust to bypass browser CORS restrictions.
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const buffer = await file.arrayBuffer();
  const fileBytes = Array.from(new Uint8Array(buffer));
  await invoke('upload_artist_image', {
    serverUrl: baseUrl,
    artistId: id,
    username: server?.username ?? '',
    password: server?.password ?? '',
    fileBytes,
    mimeType: file.type || 'image/jpeg',
  });
}

export async function deletePlaylist(id: string): Promise<void> {
  await api('deletePlaylist.view', { id });
}

// ─── Play Queue Sync ──────────────────────────────────────────
export async function getPlayQueue(): Promise<{ current?: string; position?: number; songs: SubsonicSong[] }> {
  try {
    const data = await api<{ playQueue: { current?: string; position?: number; entry?: SubsonicSong[] } }>('getPlayQueue.view');
    const pq = data.playQueue;
    return { current: pq?.current, position: pq?.position, songs: pq?.entry ?? [] };
  } catch {
    return { songs: [] };
  }
}

export async function savePlayQueue(songIds: string[], current?: string, position?: number): Promise<void> {
  const params: Record<string, unknown> = {};
  if (songIds.length > 0) params.id = songIds;
  if (current !== undefined) params.current = current;
  if (position !== undefined) params.position = position;
  await api('savePlayQueue.view', params);
}

// ─── Now Playing ──────────────────────────────────────────────
export async function getNowPlaying(): Promise<SubsonicNowPlaying[]> {
  try {
    const data = await api<{ nowPlaying: { entry?: SubsonicNowPlaying[] } | '' }>('getNowPlaying.view');
    if (!data.nowPlaying || typeof data.nowPlaying === 'string') return [];
    return data.nowPlaying.entry ?? [];
  } catch {
    return [];
  }
}


// ─── Internet Radio ───────────────────────────────────────────
export async function getInternetRadioStations(): Promise<InternetRadioStation[]> {
  try {
    const data = await api<{ internetRadioStations?: { internetRadioStation?: InternetRadioStation[] } }>(
      'getInternetRadioStations.view'
    );
    return data.internetRadioStations?.internetRadioStation ?? [];
  } catch {
    return [];
  }
}

export async function createInternetRadioStation(
  name: string, streamUrl: string, homepageUrl?: string
): Promise<void> {
  const params: Record<string, unknown> = { name, streamUrl };
  if (homepageUrl) params.homepageUrl = homepageUrl;
  await api('createInternetRadioStation.view', params);
}

export async function updateInternetRadioStation(
  id: string, name: string, streamUrl: string, homepageUrl?: string
): Promise<void> {
  const params: Record<string, unknown> = { id, name, streamUrl };
  if (homepageUrl) params.homepageUrl = homepageUrl;
  await api('updateInternetRadioStation.view', params);
}

export async function deleteInternetRadioStation(id: string): Promise<void> {
  await api('deleteInternetRadioStation.view', { id });
}

export async function uploadRadioCoverArt(id: string, file: File): Promise<void> {
  // Navidrome-specific endpoint — handled in Rust to bypass browser CORS restrictions.
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  const buffer = await file.arrayBuffer();
  const fileBytes = Array.from(new Uint8Array(buffer));
  await invoke('upload_radio_cover', {
    serverUrl: baseUrl,
    radioId: id,
    username: server?.username ?? '',
    password: server?.password ?? '',
    fileBytes,
    mimeType: file.type || 'image/jpeg',
  });
}

export async function deleteRadioCoverArt(id: string): Promise<void> {
  // Navidrome-specific endpoint — handled in Rust to bypass browser CORS restrictions.
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  await invoke('delete_radio_cover', {
    serverUrl: baseUrl,
    radioId: id,
    username: server?.username ?? '',
    password: server?.password ?? '',
  });
}

export async function uploadRadioCoverArtBytes(id: string, fileBytes: number[], mimeType: string): Promise<void> {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  await invoke('upload_radio_cover', {
    serverUrl: baseUrl,
    radioId: id,
    username: server?.username ?? '',
    password: server?.password ?? '',
    fileBytes,
    mimeType,
  });
}

function parseRadioBrowserStations(raw: Array<Record<string, string>>): RadioBrowserStation[] {
  return raw.map(s => ({
    stationuuid: s.stationuuid ?? '',
    name: s.name ?? '',
    url: s.url ?? '',
    favicon: s.favicon ?? '',
    tags: s.tags ?? '',
  }));
}

export const RADIO_PAGE_SIZE = 25;

export async function searchRadioBrowser(query: string, offset = 0): Promise<RadioBrowserStation[]> {
  const raw = await invoke<Array<Record<string, string>>>('search_radio_browser', { query, offset });
  return parseRadioBrowserStations(raw);
}

export async function getTopRadioStations(offset = 0): Promise<RadioBrowserStation[]> {
  const raw = await invoke<Array<Record<string, string>>>('get_top_radio_stations', { offset });
  return parseRadioBrowserStations(raw);
}

export async function fetchUrlBytes(url: string): Promise<[number[], string]> {
  return invoke<[number[], string]>('fetch_url_bytes', { url });
}

// ─── Structured Lyrics (OpenSubsonic / getLyricsBySongId) ────────────────────

export interface SubsonicLyricLine {
  start?: number; // milliseconds — absent when unsynced
  value: string;
}

export interface SubsonicStructuredLyrics {
  /** OpenSubsonic spec field name (Navidrome ≥ 0.50.0 / any OpenSubsonic server). */
  synced?: boolean;
  /** Legacy / alternate casing used by some older Subsonic-compatible servers. */
  issynced?: boolean;
  lang?: string;
  offset?: number;
  displayArtist?: string;
  displayTitle?: string;
  line: SubsonicLyricLine[];
}

/**
 * Fetches structured lyrics from the server's embedded tags via the
 * OpenSubsonic `getLyricsBySongId` endpoint. Returns null when the
 * server doesn't support the endpoint or the track has no embedded lyrics.
 * Prefers synced lyrics over plain when both are present.
 */
export async function getLyricsBySongId(id: string): Promise<SubsonicStructuredLyrics | null> {
  try {
    const data = await api<{ lyricsList: { structuredLyrics?: SubsonicStructuredLyrics[] } }>(
      'getLyricsBySongId.view',
      { id },
    );
    const list = data.lyricsList?.structuredLyrics;
    if (!list || list.length === 0) return null;
    return list.find(l => l.synced || l.issynced) ?? list[0];
  } catch {
    // Server doesn't support the endpoint or track has no embedded lyrics
    return null;
  }
}
