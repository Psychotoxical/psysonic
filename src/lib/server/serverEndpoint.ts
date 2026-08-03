import { pingWithCredentialsForProfile } from '@/lib/api/subsonic';
import type { PingWithCredentialsResult } from '@/lib/api/subsonicTypes';
import type { ServerProfile } from '@/store/authStoreTypes';
import { setServerReachability } from '@/lib/network/serverReachability';
import { serverProfileBaseUrl } from '@/lib/server/serverBaseUrl';
import {
  allNormalizedAddresses,
  isLanUrl,
  normalizeServerBaseUrl,
  serverAddressEndpoints,
  type ServerEndpoint,
} from '@/lib/server/serverAddress';

export {
  allNormalizedAddresses,
  isLanUrl,
  normalizeServerBaseUrl,
  serverAddressEndpoints,
  type ServerEndpoint,
  type ServerEndpointKind,
} from '@/lib/server/serverAddress';

export type PickReachableResult =
  | {
      ok: true;
      baseUrl: string;
      endpoint: ServerEndpoint;
      /**
       * The successful ping response — exposed so callers like
       * `switchActiveServer` don't need to issue a second `pingWithCredentials`
       * just to read `type` / `serverVersion` / `openSubsonic`.
       */
      ping: PingWithCredentialsResult;
    }
  | { ok: false; reason: 'unreachable' };

/** Whether either normalized profile address matches a shared server base URL. */
export function profileServesShareBase(
  profile: Pick<ServerProfile, 'url' | 'alternateUrl'>,
  shareBase: string,
): boolean {
  const wantedBase = normalizeServerBaseUrl(shareBase);
  return Boolean(wantedBase) && allNormalizedAddresses(profile).includes(wantedBase);
}

/**
 * URL to embed in **shares** (Orbit invites, entity / queue share payloads,
 * magic strings). Different from the connect URL: a guest opening the share
 * link is not on the host's LAN, so the public address is the right default
 * when both are configured. `shareUsesLocalUrl` flips that for the rare
 * "share into a LAN-only group" case (spec §5).
 *
 * Single-address profiles return their one normalized address; empty
 * profiles still return a normalized form of `url` (possibly empty).
 */
export function serverShareBaseUrl(
  profile: Pick<ServerProfile, 'url' | 'alternateUrl' | 'shareUsesLocalUrl'>,
): string {
  const endpoints = allNormalizedAddresses(profile);
  if (endpoints.length === 0) return normalizeServerBaseUrl(profile.url);
  if (endpoints.length === 1) return endpoints[0]!;

  const local = endpoints.find(isLanUrl);
  const publicEndpoint = endpoints.find(u => !isLanUrl(u));

  if (profile.shareUsesLocalUrl) return local ?? endpoints[0]!;
  return publicEndpoint ?? endpoints[0]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect cache (in-memory, per-session)
//
// `pickReachableBaseUrl` probes the LAN-first endpoint list with the existing
// `pingWithCredentials`, sequentially (not parallel) so LAN wins over public
// without racing. The first OK URL is cached against the profile id so the
// next sync `getBaseUrl()` lookup is instant. Cache is **session only** —
// never persisted; cleared on profile edit / credentials change / online
// event / manual retry via `invalidateReachableEndpointCache`.
// ─────────────────────────────────────────────────────────────────────────────

interface ProbeToken {
  fingerprint: string;
}

interface ConnectCacheEntry {
  url: string;
  token: ProbeToken;
}

const connectCache = new Map<string, ConnectCacheEntry>();
const currentProbeTokenByProfile = new Map<string, ProbeToken>();

export function profileProbeFingerprint(profile: ServerProfile): string {
  return JSON.stringify([
    ...allNormalizedAddresses(profile),
    profile.username,
    profile.password,
    profile.customHeaders ?? [],
    profile.customHeadersApplyTo ?? '',
  ]);
}

function currentProbeToken(profile: ServerProfile): ProbeToken {
  const fingerprint = profileProbeFingerprint(profile);
  const current = currentProbeTokenByProfile.get(profile.id);
  if (current?.fingerprint === fingerprint) return current;
  const token = { fingerprint };
  currentProbeTokenByProfile.set(profile.id, token);
  if (connectCache.delete(profile.id)) notifyConnectCacheChanged();
  return token;
}

function probeIsCurrent(profileId: string, token: ProbeToken): boolean {
  return currentProbeTokenByProfile.get(profileId) === token;
}

// ── Connect-cache change notifications ───────────────────────────────────────
// The sticky connect URL flips silently (120-s probe tick / online event /
// switch). Long-lived consumers that snapshot the URL once — notably the native
// **library cover backfill**, which is configured with a fixed `rest_base_url`
// — need to react when a laptop moves off the LAN, or they keep hammering the
// now-unreachable local address. UI/playback rebuild the URL per request and
// don't need this. Listeners are notified only when a profile's cached URL
// actually changes value (set to a different endpoint, dropped, or cleared).
const connectCacheListeners = new Set<() => void>();
let connectCacheVersion = 0;

function notifyConnectCacheChanged(): void {
  connectCacheVersion += 1;
  connectCacheListeners.forEach(cb => cb());
}

/** Subscribe to connect-URL flips (any profile). Returns an unsubscribe fn. */
export function subscribeConnectCache(cb: () => void): () => void {
  connectCacheListeners.add(cb);
  return () => connectCacheListeners.delete(cb);
}

/** Monotonic version, bumped on every effective connect-cache change. */
export function getConnectCacheVersion(): number {
  return connectCacheVersion;
}

/**
 * In-flight probes keyed by `profile.id`. Three call sites (useConnectionStatus
 * 120-s tick, switchActiveServer, bindIndexedServer, plus retry / online
 * handlers) can fire near-simultaneously; without this map two probes would
 * each see an empty cache, both ping every endpoint, and race to set the
 * sticky URL — the loser's `connectCache.set` would stomp the winner.
 * Returning the existing promise dedupes them so every caller gets the
 * same result.
 */
const inFlightProbes = new Map<string, {
  token: ProbeToken;
  promise: Promise<PickReachableResult>;
}>();

/**
 * Last resolved connect URL for the profile, if a probe has succeeded in this
 * session. `null` means "no probe yet" — sync `getBaseUrl()` callers should
 * fall back to the normalized primary `url`.
 */
export function getCachedConnectBaseUrl(profileId: string): string | null {
  return connectCache.get(profileId)?.url ?? null;
}

/**
 * Synchronous connect URL for any saved profile (active or not). Reads the
 * cached probe result; falls back to the normalized primary `url` when no
 * probe has run yet for that profile. **Use this** everywhere HTTP traffic
 * is built against an explicit `server.url` — never read the raw `url`
 * straight for HTTP.
 */
export function connectBaseUrlForServer(
  server: Pick<ServerProfile, 'id' | 'url'>,
): string {
  const cached = connectCache.get(server.id);
  if (cached) return cached.url;
  return serverProfileBaseUrl({ url: server.url });
}

/**
 * Drop one or all cached connect URLs. Call when:
 * - profile was edited (url / alternateUrl / credentials changed)
 * - network went online (re-check sticky)
 * - user explicitly retried the connection
 */
export function invalidateReachableEndpointCache(profileId?: string): void {
  if (profileId === undefined) {
    // Dropping the current tokens makes every existing probe stale. They may
    // still settle for their original callers, but cannot write cache or
    // reachability state and cannot be joined by a later profile generation.
    currentProbeTokenByProfile.clear();
    if (connectCache.size > 0) {
      connectCache.clear();
      notifyConnectCacheChanged();
    }
    return;
  }
  currentProbeTokenByProfile.delete(profileId);
  if (connectCache.delete(profileId)) notifyConnectCacheChanged();
}

/** Retries after a failed connect ping before trying the next endpoint / unreachable. */
const CONNECT_PING_RETRIES = 2;
const CONNECT_PING_RETRY_DELAY_MS = 2000;

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * `pingWithCredentials` for connect probing — retries flaky links (packet loss,
 * proxy TLS flakes) before the connection indicator marks the server down.
 */
async function pingWithConnectRetries(
  profile: ServerProfile,
  endpointUrl: string,
): Promise<PingWithCredentialsResult> {
  let ping = await pingWithCredentialsForProfile(profile, endpointUrl);
  if (ping.ok) return ping;
  for (let retry = 0; retry < CONNECT_PING_RETRIES; retry++) {
    await sleepMs(CONNECT_PING_RETRY_DELAY_MS);
    ping = await pingWithCredentialsForProfile(profile, endpointUrl);
    if (ping.ok) return ping;
  }
  return ping;
}

/**
 * Sequentially ping the profile's endpoints (LAN-first), return the first one
 * that answers OK. Sticky: if a cached endpoint exists and is still in the
 * list, it's tried first; on failure, the cache entry is cleared and the full
 * sequence runs.
 *
 * LAN reclaim: a sticky *public* endpoint would otherwise pin the whole session
 * to the public address (public keeps answering, so LAN-first is never retried).
 * When a higher-priority LAN endpoint is configured, each call first attempts a
 * single, no-retry probe of it — so a laptop returning to the LAN upgrades back
 * on the next reachability tick, while staying off-LAN costs only one probe
 * (its natural timeout) rather than the full retry cushion. The probe uses the
 * normal ping timeout, so a slow-but-reachable LAN still upgrades.
 *
 * Each endpoint is probed with {@link pingWithConnectRetries} (initial ping +
 * {@link CONNECT_PING_RETRIES} retries, {@link CONNECT_PING_RETRY_DELAY_MS} apart).
 *
 * Single-address profiles: one endpoint sequence, identical intent to legacy
 * behavior aside from the retry cushion.
 */
export async function pickReachableBaseUrl(
  profile: ServerProfile,
): Promise<PickReachableResult> {
  const token = currentProbeToken(profile);
  // Dedupe concurrent calls for the same profile — see `inFlightProbes`.
  const existing = inFlightProbes.get(profile.id);
  if (existing?.token === token) return existing.promise;

  const promise = (async (): Promise<PickReachableResult> => {
    const ordered = serverAddressEndpoints(profile);
    if (ordered.length === 0) {
      if (probeIsCurrent(profile.id, token)) {
        setServerReachability(profile.id, 'unavailable');
      }
      return { ok: false, reason: 'unreachable' };
    }

    const cachedEntry = connectCache.get(profile.id);
    const cached = cachedEntry?.token === token ? cachedEntry.url : undefined;

    // LAN reclaim (see doc): when stuck on a *public* sticky endpoint but a
    // higher-priority LAN endpoint is configured, try to reclaim LAN first with
    // a single, no-retry probe. A dead LAN address fails and falls straight
    // through to the sticky sequence below; a reachable one upgrades the session.
    const preferred = ordered[0]!;
    if (
      cached &&
      cached !== preferred.url &&
      preferred.kind === 'local' &&
      ordered.some(e => e.url === cached)
    ) {
      const ping = await pingWithCredentialsForProfile(profile, preferred.url);
      if (ping.ok) {
        if (probeIsCurrent(profile.id, token)) {
          connectCache.set(profile.id, { url: preferred.url, token });
          notifyConnectCacheChanged();
          setServerReachability(profile.id, 'available');
        }
        return { ok: true, baseUrl: preferred.url, endpoint: preferred, ping };
      }
    }

    // Apply sticky: move the cached endpoint (if still in the list) to the front.
    const endpoints =
      cached && ordered.some(e => e.url === cached)
        ? [
            ordered.find(e => e.url === cached)!,
            ...ordered.filter(e => e.url !== cached),
          ]
        : ordered;

    for (const endpoint of endpoints) {
      const ping = await pingWithConnectRetries(profile, endpoint.url);
      if (ping.ok) {
        if (probeIsCurrent(profile.id, token)) {
          const prev = connectCache.get(profile.id)?.url;
          connectCache.set(profile.id, { url: endpoint.url, token });
          if (prev !== endpoint.url) notifyConnectCacheChanged();
          setServerReachability(profile.id, 'available');
        }
        return { ok: true, baseUrl: endpoint.url, endpoint, ping };
      }
    }

    // Every endpoint failed — drop any stale cache entry so the next probe
    // starts from the natural LAN-first order.
    if (probeIsCurrent(profile.id, token)) {
      if (connectCache.delete(profile.id)) notifyConnectCacheChanged();
      setServerReachability(profile.id, 'unavailable');
    }
    return { ok: false, reason: 'unreachable' };
  })();

  const flight = { token, promise };
  inFlightProbes.set(profile.id, flight);
  try {
    return await promise;
  } finally {
    // Always clear the in-flight slot when this promise settles — the next
    // call (after a real boundary in time) starts a fresh probe.
    if (inFlightProbes.get(profile.id) === flight) inFlightProbes.delete(profile.id);
  }
}

/**
 * Boot / switch / online-event entry point: same mechanism as
 * `pickReachableBaseUrl` but named for intent at the call site.
 */
export async function ensureConnectUrlResolved(
  profile: ServerProfile,
): Promise<PickReachableResult> {
  return pickReachableBaseUrl(profile);
}
