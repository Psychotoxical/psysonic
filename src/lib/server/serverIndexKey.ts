import { useAuthStore } from '@/store/authStore';
import {
  serverIndexKeyForProfile,
  serverIndexKeyFromUrl,
} from '@/lib/server/serverBaseUrl';

export { serverIndexKeyForProfile, serverIndexKeyFromUrl } from '@/lib/server/serverBaseUrl';

const SERVER_PROFILE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Shape of a server profile id minted by `generateId()`: `Date.now().toString(36)`
 * (eight base36 digits until 2059) followed by `Math.random().toString(36).slice(2)`.
 * A candidate only counts as one when its first eight characters decode to a
 * time between Psysonic's first release (March 2026) and now, so a bare fixture
 * id or a single-label hostname is not mistaken for it. A configured server's
 * own index key is matched before this check runs.
 */
const GENERATED_PROFILE_ID_RE = /^[0-9a-z]{8,24}$/;
const EARLIEST_GENERATED_PROFILE_ID_MS = Date.UTC(2026, 2, 1);
const GENERATED_PROFILE_ID_CLOCK_SKEW_MS = 60 * 60 * 1000;

export function looksLikeGeneratedProfileId(candidate: string, nowMs = Date.now()): boolean {
  if (!GENERATED_PROFILE_ID_RE.test(candidate)) return false;
  const mintedAtMs = parseInt(candidate.slice(0, 8), 36);
  return mintedAtMs >= EARLIEST_GENERATED_PROFILE_ID_MS
    && mintedAtMs <= nowMs + GENERATED_PROFILE_ID_CLOCK_SKEW_MS;
}

/**
 * Resolve a durable storage key from a profile id, primary URL, or existing
 * index key. Unknown profile ids are rejected rather than leaking ephemeral
 * profile identity into library/cover/analysis storage.
 *
 * Server profiles are minted by `generateId()` as base36 strings, not UUIDs.
 * When the profile lookup missed, such an id used to fall through to
 * `serverIndexKeyFromUrl` and come back verbatim as a "host". The library keys
 * every row by the address-derived key, so the analysis layer then wrote
 * `track_fact` rows under a server the `track` table does not know and every
 * enrichment failed on the foreign key (issue #1434). Both id shapes are
 * rejected now; anything else keeps passing through unchanged.
 */
export function resolveStorageServerIndexKey(serverIdOrKey: string): string | null {
  const candidate = serverIdOrKey.trim();
  if (!candidate) return null;
  const servers = useAuthStore.getState().servers;
  const server = servers?.find(s => s.id === candidate);
  if (server) return serverIndexKeyForProfile(server) || null;
  if (servers?.some(s => serverIndexKeyForProfile(s) === candidate)) return candidate;
  if (SERVER_PROFILE_UUID_RE.test(candidate)) return null;
  if (looksLikeGeneratedProfileId(candidate)) return null;
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
