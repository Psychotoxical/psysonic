import { pingWithCredentialsForProfile } from '@/lib/api/subsonic';
import type { PingWithCredentialsResult } from '@/lib/api/subsonicTypes';
import type { ServerProfile } from '@/store/authStoreTypes';
import { serverProfileBaseUrl } from '@/lib/server/serverBaseUrl';

export type ServerEndpointKind = 'local' | 'public';

export type ServerEndpoint = {
  /** Normalized base URL, no trailing slash. */
  url: string;
  kind: ServerEndpointKind;
};

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

/**
 * Aligned with `serverProfileBaseUrl` so connect / share / index helpers all
 * agree on the canonical form of an address (`http://` default, no trailing
 * slash). Exposed separately so non-profile-shaped callers can normalize a
 * raw string.
 */
export function normalizeServerBaseUrl(raw: string): string {
  return serverProfileBaseUrl({ url: raw });
}

function isIpv4LanLiteral(ip: string): boolean {
  return (
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

function isIpv6LanHostname(hostname: string): boolean {
  if (hostname === '::1') return true;
  // fe80::/10 — link-local (first 10 bits 1111 1110 10..)
  if (/^fe[89ab][0-9a-f]:/.test(hostname)) return true;
  // fc00::/7 — ULA (includes fd00::/8)
  if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true;
  // IPv4-mapped IPv6 — accept dot-decimal (`::ffff:1.2.3.4`, raw user input)
  // and the URL-API-normalized hex form (`::ffff:HHHH:HHHH`, which `new URL`
  // produces from any dot-decimal input).
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(hostname);
  if (dotted) return isIpv4LanLiteral(dotted[1]!);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  if (hexMapped) {
    const v1 = parseInt(hexMapped[1]!, 16);
    const v2 = parseInt(hexMapped[2]!, 16);
    const ipv4 = `${(v1 >> 8) & 0xff}.${v1 & 0xff}.${(v2 >> 8) & 0xff}.${v2 & 0xff}`;
    return isIpv4LanLiteral(ipv4);
  }
  return false;
}

/**
 * True when `url`'s hostname falls in a private / link-local range, or is a
 * loopback / `.local` / `localhost`. IPv4 + IPv6 (incl. IPv4-mapped). Empty /
 * malformed inputs return `false`.
 *
 * Mirrors the prior `isLanUrl` in `useConnectionStatus.ts` for IPv4 — the
 * additions are the IPv6 cases. UI hints, endpoint ordering, and the
 * share-link LAN warning all read this.
 */
export function isLanUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `http://${url}`);
    const raw = parsed.hostname;
    // `URL().hostname` keeps IPv6 brackets — strip before pattern matches.
    const hostname = raw.replace(/^\[|\]$/g, '').toLowerCase();
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
    if (hostname.includes(':')) return isIpv6LanHostname(hostname);
    return isIpv4LanLiteral(hostname);
  } catch {
    return false;
  }
}

/**
 * Deduped normalized addresses for a profile (`url` plus optional
 * `alternateUrl`). Both fields are passed through `normalizeServerBaseUrl`
 * before dedupe so `https://x.example/` and `https://x.example` collapse.
 * Order is preserved (`url` first); empty entries are dropped.
 */
export function allNormalizedAddresses(
  profile: Pick<ServerProfile, 'url' | 'alternateUrl'>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of [profile.url, profile.alternateUrl]) {
    if (!raw) continue;
    const normalized = normalizeServerBaseUrl(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Endpoint list for connect probing — LAN-first, stable within each class.
 * Single-address profiles return one entry; dual-address returns up to two.
 */
export function serverAddressEndpoints(
  profile: Pick<ServerProfile, 'url' | 'alternateUrl'>,
): ServerEndpoint[] {
  const endpoints: ServerEndpoint[] = allNormalizedAddresses(profile).map(url => ({
    url,
    kind: isLanUrl(url) ? 'local' : 'public',
  }));
  return [
    ...endpoints.filter(e => e.kind === 'local'),
    ...endpoints.filter(e => e.kind === 'public'),
  ];
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

const connectCache = new Map<string, string>();

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
const inFlightProbes = new Map<string, Promise<PickReachableResult>>();

/**
 * Last resolved connect URL for the profile, if a probe has succeeded in this
 * session. `null` means "no probe yet" — sync `getBaseUrl()` callers should
 * fall back to the normalized primary `url`.
 */
export function getCachedConnectBaseUrl(profileId: string): string | null {
  return connectCache.get(profileId) ?? null;
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
  if (cached) return cached;
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
    // Don't clear in-flight slots — they're already racing against the
    // network, letting their own `finally` clean up keeps the dedup
    // invariant. Their results will still write to the (now empty) cache,
    // which is the right behaviour: the freshest probe wins.
    if (connectCache.size > 0) {
      connectCache.clear();
      notifyConnectCacheChanged();
    }
    return;
  }
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
 * Each endpoint is probed with {@link pingWithConnectRetries} (initial ping +
 * {@link CONNECT_PING_RETRIES} retries, {@link CONNECT_PING_RETRY_DELAY_MS} apart).
 *
 * Single-address profiles: one endpoint sequence, identical intent to legacy
 * behavior aside from the retry cushion.
 */
export async function pickReachableBaseUrl(
  profile: ServerProfile,
): Promise<PickReachableResult> {
  // Dedupe concurrent calls for the same profile — see `inFlightProbes`.
  const existing = inFlightProbes.get(profile.id);
  if (existing) return existing;

  const promise = (async (): Promise<PickReachableResult> => {
    const ordered = serverAddressEndpoints(profile);
    if (ordered.length === 0) return { ok: false, reason: 'unreachable' };

    // Apply sticky: move the cached endpoint (if still in the list) to the front.
    const cached = connectCache.get(profile.id);
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
        const prev = connectCache.get(profile.id);
        connectCache.set(profile.id, endpoint.url);
        if (prev !== endpoint.url) notifyConnectCacheChanged();
        return { ok: true, baseUrl: endpoint.url, endpoint, ping };
      }
    }

    // Every endpoint failed — drop any stale cache entry so the next probe
    // starts from the natural LAN-first order.
    if (connectCache.delete(profile.id)) notifyConnectCacheChanged();
    return { ok: false, reason: 'unreachable' };
  })();

  inFlightProbes.set(profile.id, promise);
  try {
    return await promise;
  } finally {
    // Always clear the in-flight slot when this promise settles — the next
    // call (after a real boundary in time) starts a fresh probe.
    inFlightProbes.delete(profile.id);
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
