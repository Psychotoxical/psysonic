import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import { ndLogin } from '@/lib/api/navidromeAdmin';
import { getCachedConnectBaseUrl } from '@/lib/server/serverEndpoint';
import { serverProfileBaseUrl } from '@/lib/server/serverBaseUrl';

export type SmartRuleOperator =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'lt'
  | 'inTheRange';

export interface SmartRuleCondition {
  field: string;
  operator: SmartRuleOperator;
  value: string | number | boolean | [number, number];
}

export interface NdSmartPlaylist {
  id: string;
  name: string;
  songCount: number;
  duration?: number;
  rules?: Record<string, unknown>;
  sync?: boolean;
  updatedAt?: string;
  comment?: string;
  owner?: string;
  public?: boolean;
  evaluatedAt?: string;
}

export interface NdSmartPlaylistWriteOptions {
  sync?: boolean;
  serverId?: string;
  comment?: string;
  owner?: string;
  public?: boolean;
}

function optionalString(value: unknown, fallback?: string): string | undefined {
  return typeof value === 'string' ? value : fallback;
}

function parseNdSmartPlaylist(raw: unknown, fallback: Partial<NdSmartPlaylist> = {}): NdSmartPlaylist {
  const o = (raw as Record<string, unknown>) ?? {};
  return {
    id: String(o.id ?? fallback.id ?? ''),
    name: String(o.name ?? fallback.name ?? ''),
    songCount: Number(o.songCount ?? fallback.songCount ?? 0),
    duration: typeof o.duration === 'number' ? o.duration : fallback.duration,
    rules: typeof o.rules === 'object' && o.rules ? (o.rules as Record<string, unknown>) : fallback.rules,
    sync: typeof o.sync === 'boolean' ? o.sync : fallback.sync,
    updatedAt: optionalString(o.updatedAt, fallback.updatedAt),
    comment: optionalString(o.comment, fallback.comment),
    owner: optionalString(o.owner ?? o.ownerName, fallback.owner),
    public: typeof o.public === 'boolean' ? o.public : fallback.public,
    evaluatedAt: optionalString(o.evaluatedAt ?? o.lastEvaluatedAt, fallback.evaluatedAt),
  };
}

function resolveWriteOptions(
  syncOrOptions?: boolean | NdSmartPlaylistWriteOptions,
  serverId?: string,
): NdSmartPlaylistWriteOptions {
  if (syncOrOptions && typeof syncOrOptions === 'object') {
    return { ...syncOrOptions, serverId: syncOrOptions.serverId ?? serverId };
  }
  return { sync: syncOrOptions, serverId };
}

function playlistWriteBody(
  name: string,
  rules: Record<string, unknown>,
  options: NdSmartPlaylistWriteOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { name, rules };
  if (options.sync === true) body.sync = true;
  if (typeof options.comment === 'string') body.comment = options.comment;
  if (typeof options.owner === 'string' && options.owner.trim()) body.owner = options.owner;
  if (typeof options.public === 'boolean') body.public = options.public;
  return body;
}

let authCache: {
  key: string;
  token: string;
  expiresAt: number;
} | null = null;

async function getNavidromeAuth(serverId?: string): Promise<{ serverUrl: string; token: string }> {
  const s = useAuthStore.getState();
  const server = serverId
    ? s.servers.find(profile => profile.id === serverId)
    : s.getActiveServer();
  const serverUrl = server
    ? getCachedConnectBaseUrl(server.id) || serverProfileBaseUrl({ url: server.url })
    : '';
  if (!serverUrl || !server?.username || !server?.password) {
    throw new Error('No active server credentials');
  }
  const key = `${serverUrl}|${server.username}|${server.password}`;
  if (authCache && authCache.key === key && Date.now() < authCache.expiresAt) {
    return { serverUrl, token: authCache.token };
  }
  const login = await ndLogin(serverUrl, server.username, server.password);
  authCache = {
    key,
    token: login.token,
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  return { serverUrl, token: login.token };
}

function conditionToRule(c: SmartRuleCondition): Record<string, unknown> {
  return { [c.operator]: { [c.field]: c.value } };
}

export function buildSmartRules(conditions: SmartRuleCondition[], opts?: { limit?: number; sort?: string }) {
  const all = conditions.map(conditionToRule);
  const rules: Record<string, unknown> = { all };
  if (typeof opts?.limit === 'number' && opts.limit > 0) rules.limit = opts.limit;
  if (opts?.sort) rules.sort = opts.sort;
  return rules;
}

/** List every native playlist. Supplying Navidrome's `smart` query excludes smart playlists. */
export async function ndListPlaylists(serverId?: string): Promise<NdSmartPlaylist[]> {
  const { serverUrl, token } = await getNavidromeAuth(serverId);
  const raw = await invoke<unknown>('nd_list_playlists', { serverUrl, token });
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items))
      ? (raw as { items: unknown[] }).items
      : [];
  return list.map((v) => parseNdSmartPlaylist(v));
}

export async function ndCreateSmartPlaylist(
  name: string,
  rules: Record<string, unknown>,
  syncOrOptions?: boolean | NdSmartPlaylistWriteOptions,
  serverId?: string,
): Promise<NdSmartPlaylist> {
  const options = resolveWriteOptions(syncOrOptions, serverId);
  const body = playlistWriteBody(name, rules, options);
  const { serverUrl, token } = await getNavidromeAuth(options.serverId);
  const raw = await invoke<unknown>('nd_create_playlist', {
    serverUrl,
    token,
    body,
  });
  return parseNdSmartPlaylist(raw, { name, rules, ...options });
}

export async function ndUpdateSmartPlaylist(
  id: string,
  name: string,
  rules: Record<string, unknown>,
  syncOrOptions?: boolean | NdSmartPlaylistWriteOptions,
  serverId?: string,
): Promise<NdSmartPlaylist> {
  const options = resolveWriteOptions(syncOrOptions, serverId);
  const body = playlistWriteBody(name, rules, options);
  const { serverUrl, token } = await getNavidromeAuth(options.serverId);
  const raw = await invoke<unknown>('nd_update_playlist', {
    serverUrl,
    token,
    id,
    body,
  });
  return parseNdSmartPlaylist(raw, { id, name, rules, ...options });
}

/** Partial native update — omit `rules`/`sync` so existing smart criteria stay intact. */
export async function ndUpdatePlaylistMeta(
  id: string,
  fields: { name?: string; comment?: string; public?: boolean },
  serverId?: string,
): Promise<NdSmartPlaylist> {
  const { serverUrl, token } = await getNavidromeAuth(serverId);
  const body: Record<string, unknown> = {};
  if (fields.name !== undefined) body.name = fields.name;
  if (fields.comment !== undefined) body.comment = fields.comment;
  if (fields.public !== undefined) body.public = fields.public;
  const raw = await invoke<unknown>('nd_update_playlist', {
    serverUrl,
    token,
    id,
    body,
  });
  return parseNdSmartPlaylist(raw, { id, name: fields.name, comment: fields.comment, public: fields.public });
}

export async function ndGetSmartPlaylist(id: string, serverId?: string): Promise<NdSmartPlaylist> {
  const { serverUrl, token } = await getNavidromeAuth(serverId);
  const raw = await invoke<unknown>('nd_get_playlist', { serverUrl, token, id });
  return parseNdSmartPlaylist(raw, { id });
}

export async function ndDeletePlaylist(id: string, serverId?: string): Promise<void> {
  const { serverUrl, token } = await getNavidromeAuth(serverId);
  const res = await commands.ndDeletePlaylist(serverUrl, token, id);
  if (res.status === 'error') throw new Error(res.error);
}

function asItemList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items)) {
    return (raw as { items: unknown[] }).items;
  }
  return [];
}

/** GET `/api/playlist/{id}/tracks` — first-page or ranged native track read. */
export async function ndGetPlaylistTracks(
  id: string,
  serverId?: string,
  range?: { start?: number; end?: number },
): Promise<unknown[]> {
  const { serverUrl, token } = await getNavidromeAuth(serverId);
  const raw = await invoke<unknown>('nd_get_playlist_tracks', {
    serverUrl,
    token,
    id,
    start: range?.start ?? 0,
    end: range?.end ?? 50,
  });
  return asItemList(raw);
}

/**
 * Evaluate unsaved rules: create a temporary playlist, read the first page of
 * tracks, then delete it. Used only for editor preview.
 */
export async function ndPreviewSmartPlaylist(
  payload: { owner: string; rules: Record<string, unknown>; name?: string },
  serverId?: string,
): Promise<unknown[]> {
  const { serverUrl, token } = await getNavidromeAuth(serverId);
  const raw = await invoke<unknown>('nd_preview_playlist', {
    serverUrl,
    token,
    body: {
      owner: payload.owner,
      rules: payload.rules,
      name: payload.name || `.psysonic-preview-${Date.now()}`,
      public: false,
    },
  });
  return asItemList(raw);
}
