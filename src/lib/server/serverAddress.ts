import { serverProfileBaseUrl } from '@/lib/server/serverBaseUrl';

type ServerAddressProfile = {
  url: string;
  alternateUrl?: string;
};

export type ServerEndpointKind = 'local' | 'public';

export type ServerEndpoint = {
  url: string;
  kind: ServerEndpointKind;
};

/** Normalize an address to the Subsonic root URL shape used by saved profiles. */
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
  if (/^fe[89ab][0-9a-f]:/.test(hostname)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true;

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

/** True for loopback, private, link-local, and `.local` endpoint hosts. */
export function isLanUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `http://${url}`);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname.endsWith('.local')) return true;
    if (hostname.includes(':')) return isIpv6LanHostname(hostname);
    return isIpv4LanLiteral(hostname);
  } catch {
    return false;
  }
}

/** Deduped normalized primary and alternate addresses, preserving input order. */
export function allNormalizedAddresses(
  profile: ServerAddressProfile,
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

/** Connect endpoints in LAN-first order, stable within each address class. */
export function serverAddressEndpoints(
  profile: ServerAddressProfile,
): ServerEndpoint[] {
  const endpoints: ServerEndpoint[] = allNormalizedAddresses(profile).map(url => ({
    url,
    kind: isLanUrl(url) ? 'local' : 'public',
  }));
  return [
    ...endpoints.filter(endpoint => endpoint.kind === 'local'),
    ...endpoints.filter(endpoint => endpoint.kind === 'public'),
  ];
}
