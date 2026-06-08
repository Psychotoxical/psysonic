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
