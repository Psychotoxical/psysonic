import axios from 'axios';
import md5 from 'md5';
import { useAuthStore } from '../store/authStore';

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
  return { u: username, t: token, s: salt, v: '1.16.1', c: 'psysonic', f: 'json' };
}

function getClient() {
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

// ─── Types ────────────────────────────────────────────────────
export interface SubsonicAlbum {
  id: string;
  name: string;
  artist: string;
  artistId: string;
  coverArt?: string;
  songCount: number;
  duration: number;
  year?: number;
  genre?: string;
  starred?: string;
  recordLabel?: string;
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
  // Audio technical info
  bitRate?: number;
  suffix?: string;
  contentType?: string;
  size?: number;
  samplingRate?: number;
  channelCount?: number;
  starred?: string;
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
}

export interface SubsonicGenre {
  value: string;
  songCount: number;
  albumCount: number;
}

export interface SubsonicArtistInfo {
  biography?: string;
  musicBrainzId?: string;
  lastFmUrl?: string;
  smallImageUrl?: string;
  mediumImageUrl?: string;
  largeImageUrl?: string;
}

// ─── API Methods ──────────────────────────────────────────────
export async function ping(): Promise<boolean> {
  try {
    await api('ping.view');
    return true;
  } catch {
    return false;
  }
}

/** Test a connection with explicit credentials — does NOT depend on store state. */
export async function pingWithCredentials(serverUrl: string, username: string, password: string): Promise<boolean> {
  try {
    const base = serverUrl.startsWith('http') ? serverUrl.replace(/\/$/, '') : `http://${serverUrl.replace(/\/$/, '')}`;
    const salt = secureRandomSalt();
    const token = md5(password + salt);
    const resp = await axios.get(`${base}/rest/ping.view`, {
      params: { u: username, t: token, s: salt, v: '1.16.1', c: 'psysonic', f: 'json' },
      paramsSerializer: { indexes: null },
      timeout: 15000,
    });
    const data = resp.data?.['subsonic-response'];
    return data?.status === 'ok';
  } catch {
    return false;
  }
}

export async function getRandomAlbums(size = 6): Promise<SubsonicAlbum[]> {
  const data = await api<{ albumList2: { album: SubsonicAlbum[] } }>('getAlbumList2.view', { type: 'random', size });
  return data.albumList2?.album ?? [];
}

export async function getAlbumList(
  type: 'random' | 'newest' | 'alphabeticalByName' | 'alphabeticalByArtist' | 'byYear' | 'recent' | 'starred' | 'frequent' | 'highest',
  size = 30,
  offset = 0,
  extra: Record<string, unknown> = {}
): Promise<SubsonicAlbum[]> {
  const data = await api<{ albumList2: { album: SubsonicAlbum[] } }>('getAlbumList2.view', { type, size, offset, ...extra });
  return data.albumList2?.album ?? [];
}

export async function getRandomSongs(size = 50): Promise<SubsonicSong[]> {
  const data = await api<{ randomSongs: { song: SubsonicSong[] } }>('getRandomSongs.view', { size });
  return data.randomSongs?.song ?? [];
}

export async function getAlbum(id: string): Promise<{ album: SubsonicAlbum; songs: SubsonicSong[] }> {
  const data = await api<{ album: SubsonicAlbum & { song: SubsonicSong[] } }>('getAlbum.view', { id });
  const { song, ...album } = data.album;
  return { album, songs: song ?? [] };
}

export async function getArtists(): Promise<SubsonicArtist[]> {
  const data = await api<{ artists: { index: Array<{ artist: SubsonicArtist[] }> } }>('getArtists.view');
  const indices = data.artists?.index ?? [];
  return indices.flatMap(i => i.artist ?? []);
}

export async function getArtist(id: string): Promise<{ artist: SubsonicArtist; albums: SubsonicAlbum[] }> {
  const data = await api<{ artist: SubsonicArtist & { album: SubsonicAlbum[] } }>('getArtist.view', { id });
  const { album, ...artist } = data.artist;
  return { artist, albums: album ?? [] };
}

export async function getArtistInfo(id: string): Promise<SubsonicArtistInfo> {
  const data = await api<{ artistInfo2: SubsonicArtistInfo }>('getArtistInfo2.view', { id, count: 5 });
  return data.artistInfo2 ?? {};
}

export async function getTopSongs(artist: string): Promise<SubsonicSong[]> {
  try {
    const data = await api<{ topSongs: { song: SubsonicSong[] } }>('getTopSongs.view', { artist, count: 5 });
    return data.topSongs?.song ?? [];
  } catch {
    return [];
  }
}

export async function getSimilarSongs2(id: string, count = 50): Promise<SubsonicSong[]> {
  try {
    const data = await api<{ similarSongs2: { song: SubsonicSong[] } }>('getSimilarSongs2.view', { id, count });
    return data.similarSongs2?.song ?? [];
  } catch {
    return [];
  }
}

export async function getGenres(): Promise<SubsonicGenre[]> {
  const data = await api<{ genres: { genre: SubsonicGenre[] } }>('getGenres.view');
  return data.genres?.genre ?? [];
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
  }>('getStarred2.view');
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
  });
  const r = data.searchResult3 ?? {};
  return { artists: r.artist ?? [], albums: r.album ?? [], songs: r.song ?? [] };
}

export async function setRating(id: string, rating: number): Promise<void> {
  await api('setRating.view', { id, rating });
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
    t: token, s: salt, v: '1.16.1', c: 'psysonic', f: 'json',
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
    t: token, s: salt, v: '1.16.1', c: 'psysonic', f: 'json',
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
    t: token, s: salt, v: '1.16.1', c: 'psysonic', f: 'json',
  });
  return `${baseUrl}/rest/download.view?${p.toString()}`;
}

// ─── Playlists ────────────────────────────────────────────────
export async function getPlaylists(): Promise<SubsonicPlaylist[]> {
  const data = await api<{ playlists: { playlist: SubsonicPlaylist[] } }>('getPlaylists.view');
  return data.playlists?.playlist ?? [];
}

export async function getPlaylist(id: string): Promise<{ playlist: SubsonicPlaylist; songs: SubsonicSong[] }> {
  const data = await api<{ playlist: SubsonicPlaylist & { entry: SubsonicSong[] } }>('getPlaylist.view', { id });
  const { entry, ...playlist } = data.playlist;
  return { playlist, songs: entry ?? [] };
}

export async function createPlaylist(name: string, songIds?: string[]): Promise<void> {
  const params: Record<string, unknown> = { name };
  if (songIds && songIds.length > 0) {
    params.songId = songIds;
  }
  await api('createPlaylist.view', params);
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
