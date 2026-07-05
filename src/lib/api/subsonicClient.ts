import axios from 'axios';
import md5 from 'md5';
import { version } from '@/../package.json';
import { useAuthStore } from '@/store/authStore';
import type { ServerProfile } from '@/store/authStoreTypes';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import { headersForServerRequest } from '@/lib/server/serverHttpHeaders';
import { findServerByIdOrIndexKey, resolveServerIdForIndexKey } from '@/lib/server/serverLookup';

export const SUBSONIC_CLIENT = `psysonic/${version}`;

/** Subset of `ServerProfile` needed to attach gate headers on credential-based REST calls. */
export type ServerHttpHeaderProfile = Pick<
  ServerProfile,
  'url' | 'alternateUrl' | 'customHeaders' | 'customHeadersApplyTo'
>;

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

export function restBaseFromUrl(serverUrl: string): string {
  const base = serverUrl.startsWith('http') ? serverUrl.replace(/\/$/, '') : `http://${serverUrl.replace(/\/$/, '')}`;
  return `${base}/rest`;
}

export async function apiWithCredentials<T>(
  serverUrl: string,
  username: string,
  password: string,
  endpoint: string,
  extra: Record<string, unknown> = {},
  timeout = 15000,
  headerProfile?: ServerHttpHeaderProfile,
): Promise<T> {
  const params = { ...getAuthParams(username, password), ...extra };
  const headers = headerProfile ? headersForServerRequest(headerProfile, serverUrl) : {};
  const resp = await axios.get(`${restBaseFromUrl(serverUrl)}/${endpoint}`, {
    params,
    headers,
    paramsSerializer: { indexes: null },
    timeout,
  });
  const data = resp.data?.['subsonic-response'];
  if (!data) throw new Error('Invalid response from server (possibly not a Subsonic server)');
  if (data.status !== 'ok') throw new Error(data.error?.message ?? 'Subsonic API error');
  return data as T;
}

export function getClient() {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  if (!baseUrl) throw new Error('No server configured');
  const params = getAuthParams(server?.username ?? '', server?.password ?? '');
  return { baseUrl: `${baseUrl}/rest`, params };
}

export function getServerById(serverId: string): ServerProfile | undefined {
  return findServerByIdOrIndexKey(serverId);
}

/** Subsonic REST call against an explicit saved server (not necessarily the active one). */
export async function apiForServer<T>(
  serverId: string,
  endpoint: string,
  extra: Record<string, unknown> = {},
  timeout = 15000,
): Promise<T> {
  const server = getServerById(serverId);
  if (!server) throw new Error(`Unknown server: ${serverId}`);
  // Dual-address: route through the cached connect URL when one has been
  // probed for this profile; otherwise the normalized primary url is the
  // same string the legacy code path used, so single-address profiles are
  // byte-identical to before.
  return apiWithCredentials(
    connectBaseUrlForServer(server),
    server.username,
    server.password,
    endpoint,
    extra,
    timeout,
    server,
  );
}

export async function api<T>(
  endpoint: string,
  extra: Record<string, unknown> = {},
  timeout = 15000,
  signal?: AbortSignal,
): Promise<T> {
  const { baseUrl, params } = getClient();
  const server = useAuthStore.getState().getActiveServer();
  const connectBase = useAuthStore.getState().getBaseUrl();
  const headers =
    server && connectBase ? headersForServerRequest(server, connectBase) : {};
  const resp = await axios.get(`${baseUrl}/${endpoint}`, {
    params: { ...params, ...extra },
    headers,
    paramsSerializer: { indexes: null },
    timeout,
    signal,
  });
  const data = resp.data?.['subsonic-response'];
  if (!data) throw new Error('Invalid response from server (possibly not a Subsonic server)');
  if (data.status !== 'ok') throw new Error(data.error?.message ?? 'Subsonic API error');
  return data as T;
}

/** Optional `musicFolderId` when the user narrowed browsing to one Subsonic library (see `getMusicFolders`). */
export function libraryFilterParams(): Record<string, string | number> {
  const { activeServerId } = useAuthStore.getState();
  return activeServerId ? libraryFilterParamsForServer(activeServerId) : {};
}

/** Navidrome/Subsonic music folder id for the local library index, or undefined for all libraries. */
export function libraryScopeForServer(serverId: string): string | undefined {
  const resolved = resolveServerIdForIndexKey(serverId);
  const f = useAuthStore.getState().musicLibraryFilterByServer[resolved];
  if (f === undefined || f === 'all') return undefined;
  return f;
}

/** Library folder filter for an explicit saved server (e.g. Now Playing while browsing another). */
export function libraryFilterParamsForServer(serverId: string): Record<string, string | number> {
  const scope = libraryScopeForServer(serverId);
  if (!scope) return {};
  return { musicFolderId: scope };
}
