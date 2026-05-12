import axios from 'axios';
import md5 from 'md5';
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
  secureRandomSalt,
} from './subsonicClient';
import type { PingWithCredentialsResult, SubsonicSong } from './subsonicTypes';

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
