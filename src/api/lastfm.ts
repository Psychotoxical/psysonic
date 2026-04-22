import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';

const API_KEY = '9917fb39049225a13bec225ad6d49054';
const API_SECRET = '03817dda02bee87a178aab7581abae3b';

export function lastfmIsConfigured(): boolean {
  return Boolean(API_KEY && API_SECRET);
}

function errMsg(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function call(params: Record<string, string>, sign = false, get = false): Promise<any> {
  const entries = Object.entries(params) as [string, string][];
  try {
    const result = await invoke('lastfm_request', {
      params: entries,
      sign,
      get,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    });
    // Clear session error on any successful authenticated call
    if (sign) useAuthStore.getState().setLastfmSessionError(false);
    return result;
  } catch (e) {
    // Last.fm error codes 4, 9, 14 = auth/session invalid
    if (sign && /^Last\.fm (4|9|14)\b/.test(errMsg(e))) {
      useAuthStore.getState().setLastfmSessionError(true);
    }
    throw e;
  }
}

export async function lastfmGetToken(): Promise<string> {
  try {
    const data = await call({ method: 'auth.getToken' }, false, true);
    return data.token as string;
  } catch (e) {
    throw new Error(errMsg(e));
  }
}

export function lastfmAuthUrl(token: string): string {
  return `https://www.last.fm/api/auth/?api_key=${API_KEY}&token=${token}`;
}

export async function lastfmGetSession(token: string): Promise<{ key: string; name: string }> {
  try {
    const data = await call({ method: 'auth.getSession', token }, true, false);
    return { key: data.session.key as string, name: data.session.name as string };
  } catch (e) {
    throw new Error(errMsg(e));
  }
}

export async function lastfmGetSimilarArtists(artistName: string): Promise<string[]> {
  try {
    const data = await call({ method: 'artist.getSimilar', artist: artistName, limit: '50' }, false, true);
    const artists = data?.similarartists?.artist;
    if (!artists) return [];
    const arr = Array.isArray(artists) ? artists : [artists];
    return arr.map((a: any) => a.name as string);
  } catch {
    return [];
  }
}

export async function lastfmGetAllLovedTracks(
  username: string,
  sessionKey: string,
): Promise<Array<{ title: string; artist: string }>> {
  const results: Array<{ title: string; artist: string }> = [];
  let page = 1;
  const limit = 200;

  while (true) {
    try {
      const data = await call({
        method: 'user.getLovedTracks',
        user: username,
        sk: sessionKey,
        limit: String(limit),
        page: String(page),
      }, false, true);

      const tracks = data?.lovedtracks?.track;
      if (!tracks) break;
      const arr = Array.isArray(tracks) ? tracks : [tracks];
      for (const t of arr) {
        results.push({ title: t.name, artist: t.artist?.name ?? '' });
      }

      const totalPages = Number(data?.lovedtracks?.['@attr']?.totalPages ?? 1);
      if (page >= totalPages || page >= 10) break; // max 10 pages = 2000 tracks
      page++;
    } catch {
      break;
    }
  }

  return results;
}

export async function lastfmGetTrackLoved(
  title: string,
  artist: string,
  sessionKey: string,
): Promise<boolean> {
  try {
    const data = await call({ method: 'track.getInfo', track: title, artist, sk: sessionKey }, false, true);
    return data?.track?.userloved === '1' || data?.track?.userloved === 1;
  } catch {
    return false;
  }
}

export async function lastfmUpdateNowPlaying(
  track: { title: string; artist: string; album: string; duration: number },
  sessionKey: string,
): Promise<void> {
  try {
    await call({
      method: 'track.updateNowPlaying',
      track: track.title,
      artist: track.artist,
      album: track.album,
      duration: String(Math.round(track.duration)),
      sk: sessionKey,
    }, true, false);
  } catch {
    // best effort
  }
}

export async function lastfmLoveTrack(
  track: { title: string; artist: string },
  sessionKey: string,
): Promise<void> {
  try {
    await call({ method: 'track.love', track: track.title, artist: track.artist, sk: sessionKey }, true, false);
  } catch {
    // best effort
  }
}

export async function lastfmUnloveTrack(
  track: { title: string; artist: string },
  sessionKey: string,
): Promise<void> {
  try {
    await call({ method: 'track.unlove', track: track.title, artist: track.artist, sk: sessionKey }, true, false);
  } catch {
    // best effort
  }
}

export interface LastfmUserInfo {
  playcount: number;
  registeredAt: number; // unix timestamp
}

export async function lastfmGetUserInfo(
  username: string,
  sessionKey: string,
): Promise<LastfmUserInfo | null> {
  try {
    const data = await call({ method: 'user.getInfo', user: username, sk: sessionKey }, false, true);
    const u = data?.user;
    if (!u) return null;
    return {
      playcount: Number(u.playcount),
      registeredAt: Number(u.registered?.unixtime ?? 0),
    };
  } catch {
    return null;
  }
}

export interface LastfmRecentTrack {
  name: string;
  artist: string;
  album: string;
  timestamp: number | null; // null = currently playing
  nowPlaying: boolean;
}

export async function lastfmGetRecentTracks(
  username: string,
  sessionKey: string,
  limit = 20,
): Promise<LastfmRecentTrack[]> {
  try {
    const data = await call({ method: 'user.getRecentTracks', user: username, sk: sessionKey, limit: String(limit) }, false, true);
    const items = data?.recenttracks?.track;
    if (!items) return [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.map((t: any) => ({
      name: t.name,
      artist: t.artist?.['#text'] ?? t.artist?.name ?? '',
      album: t.album?.['#text'] ?? '',
      timestamp: t.date?.uts ? Number(t.date.uts) : null,
      nowPlaying: t['@attr']?.nowplaying === 'true',
    }));
  } catch {
    return [];
  }
}

export type LastfmPeriod = 'overall' | '7day' | '1month' | '3month' | '6month' | '12month';

export interface LastfmTopArtist {
  name: string;
  playcount: string;
}

export interface LastfmTopAlbum {
  name: string;
  playcount: string;
  artist: string;
}

export interface LastfmTopTrack {
  name: string;
  playcount: string;
  artist: string;
}

export async function lastfmGetTopArtists(
  username: string,
  sessionKey: string,
  period: LastfmPeriod,
  limit = 10,
): Promise<LastfmTopArtist[]> {
  try {
    const data = await call({ method: 'user.getTopArtists', user: username, sk: sessionKey, period, limit: String(limit) }, false, true);
    const items = data?.topartists?.artist;
    if (!items) return [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.map((a: any) => ({ name: a.name, playcount: a.playcount }));
  } catch {
    return [];
  }
}

export async function lastfmGetTopAlbums(
  username: string,
  sessionKey: string,
  period: LastfmPeriod,
  limit = 10,
): Promise<LastfmTopAlbum[]> {
  try {
    const data = await call({ method: 'user.getTopAlbums', user: username, sk: sessionKey, period, limit: String(limit) }, false, true);
    const items = data?.topalbums?.album;
    if (!items) return [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.map((a: any) => ({ name: a.name, playcount: a.playcount, artist: a.artist?.name ?? '' }));
  } catch {
    return [];
  }
}

export async function lastfmGetTopTracks(
  username: string,
  sessionKey: string,
  period: LastfmPeriod,
  limit = 10,
): Promise<LastfmTopTrack[]> {
  try {
    const data = await call({ method: 'user.getTopTracks', user: username, sk: sessionKey, period, limit: String(limit) }, false, true);
    const items = data?.toptracks?.track;
    if (!items) return [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.map((t: any) => ({ name: t.name, playcount: t.playcount, artist: t.artist?.name ?? '' }));
  } catch {
    return [];
  }
}

export async function lastfmScrobble(
  track: { title: string; artist: string; album: string; duration: number },
  timestamp: number,
  sessionKey: string,
): Promise<void> {
  try {
    await call({
      method: 'track.scrobble',
      track: track.title,
      artist: track.artist,
      album: track.album,
      duration: String(Math.round(track.duration)),
      timestamp: String(Math.floor(timestamp / 1000)),
      sk: sessionKey,
    }, true, false);
  } catch {
    // best effort
  }
}

export interface LastfmTrackInfo {
  listeners: number;
  playcount: number;
  userPlaycount: number | null;
  userLoved: boolean;
  tags: string[];
  url: string | null;
}

export async function lastfmGetTrackInfo(
  artist: string,
  track: string,
  username?: string,
): Promise<LastfmTrackInfo | null> {
  try {
    const params: Record<string, string> = { method: 'track.getInfo', artist, track };
    if (username) params.username = username;
    const data = await call(params, false, true);
    const t = data?.track;
    if (!t) return null;
    const rawTags = t.toptags?.tag;
    const tags = rawTags
      ? (Array.isArray(rawTags) ? rawTags : [rawTags]).map((tg: any) => String(tg.name)).slice(0, 5)
      : [];
    const userPc = t.userplaycount != null ? Number(t.userplaycount) : null;
    return {
      listeners: Number(t.listeners) || 0,
      playcount: Number(t.playcount) || 0,
      userPlaycount: Number.isFinite(userPc) ? userPc : null,
      userLoved: t.userloved === '1' || t.userloved === 1,
      tags,
      url: t.url ?? null,
    };
  } catch {
    return null;
  }
}

export interface LastfmArtistStats {
  listeners: number;
  playcount: number;
  userPlaycount: number | null;
  tags: string[];
  url: string | null;
  bio: string | null;
}

export async function lastfmGetArtistStats(
  artist: string,
  username?: string,
): Promise<LastfmArtistStats | null> {
  try {
    const params: Record<string, string> = { method: 'artist.getInfo', artist };
    if (username) params.username = username;
    const data = await call(params, false, true);
    const a = data?.artist;
    if (!a) return null;
    const rawTags = a.tags?.tag;
    const tags = rawTags
      ? (Array.isArray(rawTags) ? rawTags : [rawTags]).map((tg: any) => String(tg.name)).slice(0, 5)
      : [];
    const userPc = a.stats?.userplaycount != null ? Number(a.stats.userplaycount) : null;
    const bioRaw = (a.bio?.content || a.bio?.summary || '').trim();
    return {
      listeners: Number(a.stats?.listeners) || 0,
      playcount: Number(a.stats?.playcount) || 0,
      userPlaycount: Number.isFinite(userPc) ? userPc : null,
      tags,
      url: a.url ?? null,
      bio: bioRaw || null,
    };
  } catch {
    return null;
  }
}
