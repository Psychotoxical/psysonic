import { useAuthStore } from '@/store/authStore';
import {
  serverIndexKeyForProfile,
  serverIndexKeyFromUrl,
} from '@/lib/server/serverBaseUrl';

export { serverIndexKeyForProfile, serverIndexKeyFromUrl } from '@/lib/server/serverBaseUrl';

const SERVER_PROFILE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Shape of a server profile id minted by `generateId()`: `Date.now().toString(36)`
 * followed by `Math.random().toString(36).slice(2)`. Timestamp width grows over
 * time and the random suffix has no useful fixed maximum, so inspect every
 * plausible timestamp width instead of bounding the complete id.
 */
const GENERATED_PROFILE_ID_RE = /^[0-9a-z]+$/;
const EARLIEST_GENERATED_PROFILE_ID_MS = Date.UTC(2026, 2, 1);
const GENERATED_PROFILE_ID_CLOCK_SKEW_MS = 60 * 60 * 1000;
const EARLIEST_GENERATED_PROFILE_ID_TIMESTAMP_LENGTH =
  EARLIEST_GENERATED_PROFILE_ID_MS.toString(36).length;

export function looksLikeGeneratedProfileId(candidate: string, nowMs = Date.now()): boolean {
  if (!GENERATED_PROFILE_ID_RE.test(candidate)) return false;
  const latestGeneratedProfileIdMs = nowMs + GENERATED_PROFILE_ID_CLOCK_SKEW_MS;
  const latestTimestampLength = latestGeneratedProfileIdMs.toString(36).length;
  for (
    let timestampLength = EARLIEST_GENERATED_PROFILE_ID_TIMESTAMP_LENGTH;
    timestampLength <= latestTimestampLength && timestampLength <= candidate.length;
    timestampLength += 1
  ) {
    const mintedAtMs = parseInt(candidate.slice(0, timestampLength), 36);
    if (
      mintedAtMs >= EARLIEST_GENERATED_PROFILE_ID_MS
      && mintedAtMs <= latestGeneratedProfileIdMs
    ) return true;
  }
  return false;
}

/**
 * Resolve a durable storage key from a profile UUID, primary URL, or existing
 * index key. Unknown UUIDs are rejected rather than leaking ephemeral profile
 * identity into storage. Base36 profile ids cannot be distinguished safely
 * from valid single-label hostnames here, so callers with narrower acceptance
 * requirements must apply them at their domain boundary.
 */
export function resolveStorageServerIndexKey(serverIdOrKey: string): string | null {
  const candidate = serverIdOrKey.trim();
  if (!candidate) return null;
  const servers = useAuthStore.getState().servers;
  const server = servers?.find(s => s.id === candidate);
  if (server) return serverIndexKeyForProfile(server) || null;
  if (servers?.some(s => serverIndexKeyForProfile(s) === candidate)) return candidate;
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
