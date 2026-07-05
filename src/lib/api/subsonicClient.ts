import axios from 'axios';
import { getLuckyMixLibraryScopeOverride } from '@/lib/library/luckyMixScopeOverride';
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
export function libraryFilterParams(): Record<string, string | number | string[]> {
  const { activeServerId } = useAuthStore.getState();
  return activeServerId ? libraryFilterParamsForServer(activeServerId) : {};
}

type AuthSnapshot = ReturnType<typeof useAuthStore.getState>;

function rawLibrarySelection(state: AuthSnapshot, resolved: string): string[] {
  const selection = state.musicLibrarySelectionByServer[resolved];
  if (selection !== undefined) return selection;
  const legacy = state.musicLibraryFilterByServer[resolved];
  if (legacy === undefined || legacy === 'all') return [];
  return [legacy];
}

/**
 * True when `selection` already covers every library of the active server, so it
 * is equivalent to "All libraries". Only checked for the active server, since
 * `musicFolders` is the folder list of that server.
 */
function selectionCoversAllLibraries(
  state: AuthSnapshot,
  resolved: string,
  selection: string[],
): boolean {
  if (resolved !== state.activeServerId) return false;
  const folders = state.musicFolders;
  if (folders.length === 0 || selection.length < folders.length) return false;
  const selected = new Set(selection);
  return folders.every(folder => selected.has(folder.id));
}

/** Ordered library folder ids for a server; empty = all libraries. */
export function librarySelectionForServer(serverId: string): string[] {
  const resolved = resolveServerIdForIndexKey(serverId);
  const state = useAuthStore.getState();
  const selection = rawLibrarySelection(state, resolved);
  // Selecting every library one-by-one is the same as "All libraries": collapse
  // to the empty/all scope so browse and search take the faster unscoped path
  // (no per-library `IN` filter, no cross-library merge) and share the "all"
  // cache — identical to picking the All-libraries option. The sidebar picker
  // reads raw state, so its per-library checkmarks are unaffected.
  if (selection.length > 0 && selectionCoversAllLibraries(state, resolved, selection)) {
    return [];
  }
  return selection;
}

/** Ordered, resolved library folder ids for Subsonic / local index scope. */
export function libraryScopesForServer(serverId: string): string[] {
  return librarySelectionForServer(serverId);
}

/** Ordered scope pairs for local index reads — profile `serverId` space; empty when all libraries. */
export function libraryScopePairsForServer(serverId: string): { serverId: string; libraryId: string }[] {
  return librarySelectionForServer(serverId).map(libraryId => ({ serverId, libraryId }));
}

/** Navidrome/Subsonic music folder id for the local library index, or undefined for all libraries. */
export function libraryScopeForServer(serverId: string): string | undefined {
  const selection = librarySelectionForServer(serverId);
  return selection.length === 1 ? selection[0] : undefined;
}

/** True when the user narrowed browsing to one or more libraries (not "all"). */
export function libraryScopeIsActive(serverId: string): boolean {
  return librarySelectionForServer(serverId).length > 0;
}

/** Stable cache-key segment for scoped reads (`all` or comma-joined library ids). */
export function libraryScopeCacheKeyForServer(serverId: string): string {
  const selection = librarySelectionForServer(serverId);
  if (selection.length === 0) return 'all';
  return selection.join(',');
}

/** Library folder filter for an explicit saved server (e.g. Now Playing while browsing another). */
export function libraryFilterParamsForServer(
  serverId: string,
): Record<string, string | number | string[]> {
  const luckyMixScope = getLuckyMixLibraryScopeOverride();
  if (luckyMixScope) return { musicFolderId: luckyMixScope };

  const scopes = libraryScopesForServer(serverId);
  if (scopes.length === 0) return {};
  if (scopes.length === 1) return { musicFolderId: scopes[0] };
  return { musicFolderId: scopes };
}
