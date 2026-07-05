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
