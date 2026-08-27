import { serverIndexKeyFromUrl } from '@/lib/server/serverBaseUrl';
import type { ServerProfile } from '@/store/authStoreTypes';

export const AUTH_PERSISTENCE_KEY = 'psysonic-auth';

export type RawAuthServerProfileGroup = {
  serverIndexKey: string;
  profiles: ServerProfile[];
};

export type RawAuthStorage = Pick<Storage, 'getItem'>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeCustomHeaders(value: unknown): ServerProfile['customHeaders'] | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const headers: NonNullable<ServerProfile['customHeaders']> = [];
  for (const header of value) {
    if (!isPlainObject(header) || typeof header.name !== 'string' || typeof header.value !== 'string') {
      return null;
    }
    headers.push({ name: header.name, value: header.value });
  }
  return headers;
}

function decodeServerProfile(value: unknown): ServerProfile | null {
  if (!isPlainObject(value)
    || typeof value.id !== 'string' || !value.id || value.id.trim() !== value.id
    || typeof value.name !== 'string'
    || typeof value.url !== 'string' || !value.url || value.url.trim() !== value.url
    || typeof value.username !== 'string'
    || typeof value.password !== 'string') {
    return null;
  }
  if (value.alternateUrl !== undefined
    && (typeof value.alternateUrl !== 'string'
      || !value.alternateUrl
      || value.alternateUrl.trim() !== value.alternateUrl)) return null;
  if (value.shareUsesLocalUrl !== undefined && typeof value.shareUsesLocalUrl !== 'boolean') return null;
  if (value.customHeadersApplyTo !== undefined
    && value.customHeadersApplyTo !== 'local'
    && value.customHeadersApplyTo !== 'public'
    && value.customHeadersApplyTo !== 'both') return null;
  const customHeaders = decodeCustomHeaders(value.customHeaders);
  if (customHeaders === null) return null;

  return {
    id: value.id,
    name: value.name,
    url: value.url,
    username: value.username,
    password: value.password,
    ...(value.alternateUrl === undefined ? {} : { alternateUrl: value.alternateUrl }),
    ...(value.shareUsesLocalUrl === undefined ? {} : { shareUsesLocalUrl: value.shareUsesLocalUrl }),
    ...(customHeaders === undefined ? {} : { customHeaders }),
    ...(value.customHeadersApplyTo === undefined
      ? {}
      : { customHeadersApplyTo: value.customHeadersApplyTo }),
  };
}

/** Reads persisted profiles without instantiating the Zustand auth store. */
export function readRawAuthServerProfileGroups(
  storage: RawAuthStorage = localStorage,
): RawAuthServerProfileGroup[] {
  const raw = storage.getItem(AUTH_PERSISTENCE_KEY);
  if (raw === null) return [];
  let root: unknown;
  try {
    root = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Malformed psysonic-auth JSON');
  }
  if (!isPlainObject(root) || !isPlainObject(root.state) || !Array.isArray(root.state.servers)) {
    return [];
  }
  const activeServerId = typeof root.state.activeServerId === 'string'
    ? root.state.activeServerId
    : null;
  const groups = new Map<string, ServerProfile[]>();
  for (const rawProfile of root.state.servers) {
    const profile = decodeServerProfile(rawProfile);
    if (!profile) continue;
    const serverIndexKey = serverIndexKeyFromUrl(profile.url).trim();
    if (!serverIndexKey) continue;
    const profiles = groups.get(serverIndexKey) ?? [];
    profiles.push(profile);
    groups.set(serverIndexKey, profiles);
  }

  return [...groups].map(([serverIndexKey, originalProfiles]) => {
    let profiles = originalProfiles;
    const activeIndex = activeServerId
      ? profiles.findIndex(profile => profile.id === activeServerId)
      : -1;
    if (activeIndex > 0) {
      profiles = [profiles[activeIndex]!, ...profiles.slice(0, activeIndex), ...profiles.slice(activeIndex + 1)];
    }
    return { serverIndexKey, profiles };
  });
}
