import axios from 'axios';
import { getLuckyMixLibraryScopeOverride } from '@/lib/library/luckyMixScopeOverride';
import md5 from 'md5';
import { SUBSONIC_CLIENT_ID } from '@/generated/appVersion';
import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import type { ServerProfile } from '@/store/authStoreTypes';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import { headersForServerRequest, serverHttpContextWireForProbe } from '@/lib/server/serverHttpHeaders';
import { findServerByIdOrIndexKey, resolveServerIdForIndexKey } from '@/lib/server/serverLookup';

export const SUBSONIC_CLIENT = SUBSONIC_CLIENT_ID;

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

/**
 * Encode Subsonic REST params the same way axios does with `paramsSerializer: { indexes: null }`
 * (repeated keys for arrays: `id=a&id=b`). Used for OpenSubsonic form POST bodies.
 */
export function serializeSubsonicParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

function parseSubsonicResponse<T>(respData: unknown): T {
  const data = (respData as { ['subsonic-response']?: { status?: string; error?: { message?: string } } })?.[
    'subsonic-response'
  ];
  if (!data) throw new Error('Invalid response from server (possibly not a Subsonic server)');
  if (data.status !== 'ok') throw new Error(data.error?.message ?? 'Subsonic API error');
  return data as T;
}

/** True when a reverse proxy / server rejected the request because the URI was too long. */
export function isHttp414(err: unknown): boolean {
  if (err && typeof err === 'object' && 'response' in err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 414) return true;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('414') || msg.includes('uri too long') || msg.includes('request-uri too large');
  }
  return false;
}

function httpBaseFromUrl(serverUrl: string): string {
  return serverUrl.startsWith('http')
    ? serverUrl.replace(/\/$/, '')
    : `http://${serverUrl.replace(/\/$/, '')}`;
}

/**
 * Flatten Subsonic params into ordered `[key, value]` pairs the same way axios
 * does with `paramsSerializer: { indexes: null }` (arrays repeat the key:
 * `id=a&id=b`). Undefined / null values are dropped. Used as the wire payload
 * for the native `subsonic_proxy_request` command.
 */
function subsonicParamPairs(params: Record<string, unknown>): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        pairs.push([key, String(item)]);
      }
      continue;
    }
    pairs.push([key, String(value)]);
  }
  return pairs;
}

/**
 * Run a Subsonic REST call through the native reqwest command instead of the
 * WebView. Required for gate-header servers (Cloudflare Access, Pangolin): a
 * non-CORS-safelisted header makes the WebView send an `OPTIONS` preflight the
 * gate rejects, so browse/search/stats never leave. Native reqwest never
 * preflights and carries the header via the per-server http context. The raw
 * JSON body is parsed exactly like an axios response.
 */
async function requestViaRustProxy<T>(
  serverUrl: string,
  endpoint: string,
  params: Record<string, unknown>,
  headerProfile: ServerHttpHeaderProfile,
  timeout: number,
  postForm: boolean,
): Promise<T> {
  const res = await commands.subsonicProxyRequest(
    httpBaseFromUrl(serverUrl),
    endpoint,
    subsonicParamPairs(params),
    postForm,
    timeout,
    serverHttpContextWireForProbe(headerProfile),
  );
  if (res.status === 'error') throw new Error(res.error);
  let json: unknown;
  try {
    json = JSON.parse(res.data);
  } catch {
    throw new Error('Invalid response from server (possibly not a Subsonic server)');
  }
  return parseSubsonicResponse<T>(json);
}

/**
 * True when a request to `requestBaseUrl` would carry non-safelisted gate
 * headers — i.e. it must go through the native proxy, not the WebView. Reuses
 * `headersForServerRequest` so the endpoint-kind / apply-to logic stays in one
 * place: an empty header map means the WebView path is safe.
 */
function requiresNativeTransport(
  headerProfile: ServerHttpHeaderProfile | undefined,
  requestBaseUrl: string,
): boolean {
  if (!headerProfile) return false;
  return Object.keys(headersForServerRequest(headerProfile, requestBaseUrl)).length > 0;
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
  if (headerProfile && requiresNativeTransport(headerProfile, serverUrl)) {
    return requestViaRustProxy<T>(serverUrl, endpoint, params, headerProfile, timeout, false);
  }
  const headers = headerProfile ? headersForServerRequest(headerProfile, serverUrl) : {};
  const resp = await axios.get(`${restBaseFromUrl(serverUrl)}/${endpoint}`, {
    params,
    headers,
    paramsSerializer: { indexes: null },
    timeout,
  });
  return parseSubsonicResponse<T>(resp.data);
}

/**
 * OpenSubsonic `formPost`: send all API args in an `application/x-www-form-urlencoded` body
 * (path-only URL - no query string) so large multi-`id` calls avoid HTTP 414.
 */
export async function apiPostFormWithCredentials<T>(
  serverUrl: string,
  username: string,
  password: string,
  endpoint: string,
  extra: Record<string, unknown> = {},
  timeout = 15000,
  headerProfile?: ServerHttpHeaderProfile,
): Promise<T> {
  const params = { ...getAuthParams(username, password), ...extra };
  if (headerProfile && requiresNativeTransport(headerProfile, serverUrl)) {
    return requestViaRustProxy<T>(serverUrl, endpoint, params, headerProfile, timeout, true);
  }
  const headers = {
    ...(headerProfile ? headersForServerRequest(headerProfile, serverUrl) : {}),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const resp = await axios.post(
    `${restBaseFromUrl(serverUrl)}/${endpoint}`,
    serializeSubsonicParams(params),
    { headers, timeout },
  );
  return parseSubsonicResponse<T>(resp.data);
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

/** True when the server advertises the OpenSubsonic `formPost` extension. */
export function serverSupportsFormPost(serverId: string): boolean {
  const exts = useAuthStore.getState().openSubsonicExtensionsByServer[serverId] ?? [];
  return exts.includes('formPost');
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

/** Form-POST variant of `apiForServer` (OpenSubsonic `formPost`). */
export async function apiPostFormForServer<T>(
  serverId: string,
  endpoint: string,
  extra: Record<string, unknown> = {},
  timeout = 15000,
): Promise<T> {
  const server = getServerById(serverId);
  if (!server) throw new Error(`Unknown server: ${serverId}`);
  return apiPostFormWithCredentials(
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
  // Gate-header servers: route through the native proxy (no CORS preflight).
  // `signal` isn't forwarded — the underlying request can't be aborted mid-flight,
  // but the caller's promise still settles and stale results are ignored upstream.
  if (server && connectBase && requiresNativeTransport(server, connectBase)) {
    return requestViaRustProxy<T>(connectBase, endpoint, { ...params, ...extra }, server, timeout, false);
  }
  const headers =
    server && connectBase ? headersForServerRequest(server, connectBase) : {};
  const resp = await axios.get(`${baseUrl}/${endpoint}`, {
    params: { ...params, ...extra },
    headers,
    paramsSerializer: { indexes: null },
    timeout,
    signal,
  });
  return parseSubsonicResponse<T>(resp.data);
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
 * True when `selection` already covers every last-known library of the server,
 * so it is equivalent to "All libraries".
 */
function selectionCoversAllLibraries(
  state: AuthSnapshot,
  resolved: string,
  selection: string[],
): boolean {
  const folders = state.musicFoldersByServer[resolved]
    ?? (resolved === state.activeServerId ? state.musicFolders : []);
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

/** Ordered scope pairs for local index reads — `null` is the whole server. */
export function libraryScopePairsForServer(
  serverId: string,
): { serverId: string; libraryId: string | null }[] {
  const selection = librarySelectionForServer(serverId);
  if (selection.length === 0) return [{ serverId, libraryId: null }];
  return selection.map(libraryId => ({ serverId, libraryId }));
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
