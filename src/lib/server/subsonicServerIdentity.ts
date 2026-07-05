/** Fields from Subsonic `ping` / any `subsonic-response` root (Navidrome sets type + serverVersion). */
export type SubsonicServerIdentity = {
  type?: string;
  serverVersion?: string;
  openSubsonic?: boolean;
};

/** Result of `getRandomSongs` + `getSimilarSongs` probe (Instant Mix / agent chain). */
export type InstantMixProbeResult = 'ok' | 'empty' | 'error' | 'skipped';

/**
 * Navidrome ≥ 0.62 exposes the OpenSubsonic `sonicSimilarity` extension when an audio-similarity
 * plugin (e.g. AudioMuse-AI) is active — the first reliable plugin signal.
 */
export type AudiomusePluginProbeResult =
  | 'probing'
  | 'present'
  | 'absent'
  | 'error';

const NAVIDROME_MIN_FOR_PLUGINS: [number, number, number] = [0, 60, 0];

export function parseLeadingSemver(version: string | undefined): [number, number, number] | null {
  if (!version) return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function semverGte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

export function isNavidromeServer(identity: SubsonicServerIdentity | undefined): boolean {
  if (!identity?.type?.trim()) return false;
  return identity.type.trim().toLowerCase() === 'navidrome';
}

/**
 * Human-facing server software label from a ping identity — e.g. `Navidrome 0.62.0`.
 * Capitalises the leading word of `type` (OpenSubsonic reports it lower-case) and
 * appends the leading version token. Navidrome reports `serverVersion` with a build
 * hash (`0.62.0 (1b46b977)`); only the version up to the first space/paren is kept.
 * Returns `null` when the server reported no `type` (e.g. plain Subsonic without
 * OpenSubsonic), so callers can omit the line.
 */
export function formatServerSoftware(identity: SubsonicServerIdentity | undefined): string | null {
  const type = identity?.type?.trim();
  if (!type) return null;
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  const rawVersion = identity?.serverVersion?.trim();
  const version = rawVersion ? rawVersion.split(/[\s(]/)[0] : undefined;
  return version ? `${label} ${version}` : label;
}

/**
 * Navidrome version from ping supports the plugin system (≥ 0.60). Unknown `type` stays permissive
 * until the first successful ping with metadata.
 */
export function isNavidromeAudiomuseSoftwareEligible(identity: SubsonicServerIdentity | undefined): boolean {
  if (!identity?.type?.trim()) return true;
  if (!isNavidromeServer(identity)) return false;
  const parsed = parseLeadingSemver(identity.serverVersion);
  if (!parsed) return true;
  return semverGte(parsed, NAVIDROME_MIN_FOR_PLUGINS);
}
