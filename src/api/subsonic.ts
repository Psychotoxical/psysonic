import axios from 'axios';
import md5 from 'md5';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import {
  isNavidromeAudiomuseSoftwareEligible,
  type InstantMixProbeResult,
  type SubsonicServerIdentity,
} from '../utils/subsonicServerIdentity';
import {
  SUBSONIC_CLIENT,
  api,
  getAuthParams,
  getClient,
  libraryFilterParams,
  secureRandomSalt,
} from './subsonicClient';
import { getAlbumList, getRandomSongs } from './subsonicLibrary';
import { getArtists } from './subsonicArtists';

/** Cache TTL for statistics page aggregates — same 7-minute window as
 *  the rating prefetch cache in subsonicRatings.ts. */
const RATING_CACHE_TTL = 7 * 60 * 1000;
import type {
  AlbumInfo,
  EntityRatingSupportLevel,
  InternetRadioStation,
  PingWithCredentialsResult,
  RadioBrowserStation,
  RandomSongsFilters,
  SearchResults,
  StarredResults,
  StatisticsFormatSample,
  StatisticsLibraryAggregates,
  StatisticsOverviewData,
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicArtistInfo,
  SubsonicDirectory,
  SubsonicDirectoryEntry,
  SubsonicGenre,
  SubsonicMusicFolder,
  SubsonicNowPlaying,
  SubsonicOpenArtistRef,
  SubsonicPlaylist,
  SubsonicSong,
  SubsonicStructuredLyrics,
} from './subsonicTypes';


/** OpenSubsonic `artists` / `albumArtists` entries on a child song (may include `userRating`). */



export async function ping(): Promise<boolean> {
  try {
    await api('ping.view');
    return true;
  } catch {
    return false;
  }
}


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
  } catch (err) {
    console.warn('[psysonic] pingWithCredentials failed:', serverUrl, err);
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


















/** Paginated album stats for Statistics (playtime, counts, genre breakdown). Same TTL as rating prefetch. */
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
  // Cached song lists keyed by rating (e.g. Tracks → Highly Rated rail) become
  // stale immediately. Lazy-import to keep the module dep direction
  // subsonic ← navidromeBrowse and avoid pulling Tauri internals into shared
  // type-only consumers.
  void import('./navidromeBrowse').then(m => m.ndInvalidateSongsCache()).catch(() => {});
}

/** How aggressively we assume `setRating` accepts album/artist ids (OpenSubsonic-style). */

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

// ─── Album Info (public image URLs from Last.fm/MusicBrainz) ──
export async function getAlbumInfo2(albumId: string): Promise<AlbumInfo | null> {
  try {
    const data = await api<{ albumInfo: AlbumInfo }>('getAlbumInfo2.view', { id: albumId });
    return data.albumInfo ?? null;
  } catch {
    return null;
  }
}

// ─── Playlists ────────────────────────────────────────────────
export async function getPlaylists(includeOrbit = false): Promise<SubsonicPlaylist[]> {
  const data = await api<{ playlists: { playlist: SubsonicPlaylist[] } }>('getPlaylists.view', { _t: Date.now() });
  const all = data.playlists?.playlist ?? [];
  // Orbit session + outbox playlists are technical internals. They're `public`
  // so guests can reach them, which means they leak into every UI picker and
  // even into the Navidrome web client. Filter them out of every UI call;
  // orbit's own sweep passes `includeOrbit=true`.
  return includeOrbit ? all : all.filter(p => !p.name.startsWith('__psyorbit_'));
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
