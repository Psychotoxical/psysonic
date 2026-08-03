import { useAuthStore } from '@/store/authStore';
import {
  serverIndexKeyForProfile,
  serverIndexKeyFromUrl,
} from '@/lib/server/serverBaseUrl';

export { serverIndexKeyForProfile, serverIndexKeyFromUrl } from '@/lib/server/serverBaseUrl';

const SERVER_PROFILE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve a durable storage key from a profile UUID, primary URL, or existing
 * index key. Unknown UUIDs are rejected rather than leaking ephemeral profile
 * identity into library/cover/analysis storage.
 */
export function resolveStorageServerIndexKey(serverIdOrKey: string): string | null {
  const candidate = serverIdOrKey.trim();
  if (!candidate) return null;
  const servers = useAuthStore.getState().servers;
  const server = servers?.find(s => s.id === candidate);
  if (server) return serverIndexKeyForProfile(server) || null;
  if (SERVER_PROFILE_UUID_RE.test(candidate)) return null;
  return serverIndexKeyFromUrl(candidate) || null;
}

export function resolveIndexKey(serverIdOrKey: string): string {
  const servers = useAuthStore.getState().servers;
  if (!servers) return serverIdOrKey;
  const server = servers.find(s => s.id === serverIdOrKey);
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
