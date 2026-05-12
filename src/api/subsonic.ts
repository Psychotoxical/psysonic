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















/** How aggressively we assume `setRating` accepts album/artist ids (OpenSubsonic-style). */









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


