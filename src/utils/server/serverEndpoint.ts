import type { ServerProfile } from '../../store/authStoreTypes';
import { serverProfileBaseUrl } from './serverBaseUrl';

export type ServerEndpointKind = 'local' | 'public';

export type ServerEndpoint = {
  /** Normalized base URL, no trailing slash. */
  url: string;
  kind: ServerEndpointKind;
};

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
