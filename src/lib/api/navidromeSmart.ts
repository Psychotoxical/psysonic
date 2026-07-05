import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/generated/bindings';
import { useAuthStore } from '@/store/authStore';
import { ndLogin } from '@/lib/api/navidromeAdmin';

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
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : fallback.updatedAt,
  };
}

let authCache: {
  key: string;
  token: string;
  expiresAt: number;
} | null = null;

async function getNavidromeAuth(): Promise<{ serverUrl: string; token: string }> {
  const s = useAuthStore.getState();
  const server = s.getActiveServer();
  const serverUrl = s.getBaseUrl();
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

export async function ndListSmartPlaylists(): Promise<NdSmartPlaylist[]> {
  const { serverUrl, token } = await getNavidromeAuth();
  const raw = await invoke<unknown>('nd_list_playlists', { serverUrl, token, smart: true });
  const list = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items))
      ? (raw as { items: unknown[] }).items
      : [];
  return list.map((v) => parseNdSmartPlaylist(v));
}

export async function ndCreateSmartPlaylist(name: string, rules: Record<string, unknown>, sync = true): Promise<NdSmartPlaylist> {
  const { serverUrl, token } = await getNavidromeAuth();
  const raw = await invoke<unknown>('nd_create_playlist', {
    serverUrl,
    token,
    body: { name, rules, sync },
  });
  return parseNdSmartPlaylist(raw, { name, rules, sync });
}

export async function ndUpdateSmartPlaylist(
  id: string,
  name: string,
  rules: Record<string, unknown>,
  sync = true,
): Promise<NdSmartPlaylist> {
  const { serverUrl, token } = await getNavidromeAuth();
  const raw = await invoke<unknown>('nd_update_playlist', {
    serverUrl,
    token,
    id,
    body: { name, rules, sync },
  });
  return parseNdSmartPlaylist(raw, { id, name, rules, sync });
}

export async function ndGetSmartPlaylist(id: string): Promise<NdSmartPlaylist> {
  const { serverUrl, token } = await getNavidromeAuth();
  const raw = await invoke<unknown>('nd_get_playlist', { serverUrl, token, id });
  return parseNdSmartPlaylist(raw, { id });
}

export async function ndDeletePlaylist(id: string): Promise<void> {
  const { serverUrl, token } = await getNavidromeAuth();
  const res = await commands.ndDeletePlaylist(serverUrl, token, id);
  if (res.status === 'error') throw new Error(res.error);
}
