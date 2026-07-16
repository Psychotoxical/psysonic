import type { ServerProfile } from '@/store/authStoreTypes';
import { useAuthStore } from '@/store/authStore';
import { serverProfileBaseUrl } from '@/lib/server/serverBaseUrl';

/** Stable index key derived from a server URL (host + optional path, no scheme). */
export function serverIndexKeyFromUrl(urlRaw: string): string {
  const base = serverProfileBaseUrl({ url: urlRaw });
  return base.replace(/^https?:\/\//, '');
}

export function serverIndexKeyForProfile(server: Pick<ServerProfile, 'url'>): string {
  return serverIndexKeyFromUrl(server.url);
}

type ServerIndexProfile = Pick<ServerProfile, 'id' | 'url'> & Partial<Pick<
  ServerProfile,
  'username' | 'password' | 'alternateUrl' | 'customHeaders' | 'customHeadersApplyTo'
>>;

type ServerIndexOwnerState<T extends ServerIndexProfile = ServerIndexProfile> = {
  servers: T[];
  musicLibraryServerIds?: string[];
};

function aliasesCanShareSession(a: ServerIndexProfile, b: ServerIndexProfile): boolean {
  const leftHeaders = a.customHeaders ?? [];
  const rightHeaders = b.customHeaders ?? [];
  return a.username === b.username
    && a.password === b.password
    && (a.alternateUrl ?? '') === (b.alternateUrl ?? '')
    && (a.customHeadersApplyTo ?? 'public') === (b.customHeadersApplyTo ?? 'public')
    && leftHeaders.length === rightHeaders.length
    && leftHeaders.every((header, index) =>
      header.name === rightHeaders[index]?.name && header.value === rightHeaders[index]?.value);
}

export function assertSelectedIndexAliasesCompatible(state: ServerIndexOwnerState): void {
  const selected = new Set(state.musicLibraryServerIds ?? []);
  const ownerByIndexKey = new Map<string, ServerIndexProfile>();
  for (const server of state.servers) {
    if (!selected.has(server.id)) continue;
    const indexKey = serverIndexKeyForProfile(server) || server.id;
    const owner = ownerByIndexKey.get(indexKey);
    if (!owner) {
      ownerByIndexKey.set(indexKey, server);
      continue;
    }
    if (!aliasesCanShareSession(owner, server)) {
      throw new Error(
        `Selected server profiles "${owner.id}" and "${server.id}" share library index "${indexKey}" but use incompatible credentials or connection settings`,
      );
    }
  }
}

/** Selected scope wins, then common server order; activeServerId has no influence. */
export function serverIndexOwners<T extends ServerIndexProfile>(state: ServerIndexOwnerState<T>): T[] {
  assertSelectedIndexAliasesCompatible(state);
  const selected = new Set(state.musicLibraryServerIds ?? []);
  const ownerByIndexKey = new Map<string, T>();
  for (const server of state.servers) {
    const indexKey = serverIndexKeyForProfile(server) || server.id;
    const owner = ownerByIndexKey.get(indexKey);
    if (!owner || (!selected.has(owner.id) && selected.has(server.id))) {
      ownerByIndexKey.set(indexKey, server);
    }
  }
  return [...ownerByIndexKey.values()];
}

export function serverIndexOwnerForKey<T extends ServerIndexProfile>(
  state: ServerIndexOwnerState<T>,
  serverIdOrIndexKey: string,
): T | undefined {
  const direct = state.servers.find(server => server.id === serverIdOrIndexKey);
  const indexKey = direct
    ? serverIndexKeyForProfile(direct) || direct.id
    : serverIdOrIndexKey;
  return serverIndexOwners(state).find(server =>
    (serverIndexKeyForProfile(server) || server.id) === indexKey);
}

export function resolveIndexKey(serverIdOrKey: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverIdOrKey);
  if (!server) return serverIdOrKey;
  return serverIndexKeyFromUrl(server.url) || serverIdOrKey;
}

/**
 * Canonical key for queue-thin-state writers: returns the URL-derived index key
 * for any known server (whether the caller passed the UUID or the index key),
 * and leaves unknown / already-canonical values untouched. Idempotent.
 *
 * Use this on every write path that lands in `QueueItemRef.serverId` or
 * `PlayerState.queueServerId`. Reading sides may still receive legacy UUID
 * values from persisted blobs; `serverLookup` helpers accept both shapes.
 */
export function canonicalQueueServerKey(serverIdOrKey: string): string {
  if (!serverIdOrKey) return serverIdOrKey;
  // Defensive: tests sometimes stub `useAuthStore` without seeding `servers`.
  // Treat a missing list as "unknown server" rather than crashing the read.
  const servers = useAuthStore.getState().servers;
  if (!servers) return serverIdOrKey;
  const server = servers.find(s => s.id === serverIdOrKey);
  if (server) {
    return serverIndexKeyFromUrl(server.url) || serverIdOrKey;
  }
  return serverIdOrKey;
}
