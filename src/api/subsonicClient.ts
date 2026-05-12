import axios from 'axios';
import md5 from 'md5';
import { version } from '../../package.json';
import { useAuthStore } from '../store/authStore';

export const SUBSONIC_CLIENT = `psysonic/${version}`;

export function secureRandomSalt(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

export function getAuthParams(username: string, password: string) {
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

export async function api<T>(endpoint: string, extra: Record<string, unknown> = {}, timeout = 15000): Promise<T> {
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
