/** Fields from Subsonic `ping` / any `subsonic-response` root (Navidrome sets type + serverVersion). */
export type SubsonicServerIdentity = {
  type?: string;
  serverVersion?: string;
  openSubsonic?: boolean;
};

/** Result of `getRandomSongs` + `getSimilarSongs` probe (Instant Mix / agent chain). */
export type InstantMixProbeResult = 'ok' | 'empty' | 'error' | 'skipped';

const NAVIDROME_MIN_FOR_PLUGINS: [number, number, number] = [0, 60, 0];

function parseLeadingSemver(version: string | undefined): [number, number, number] | null {
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

/**
 * Navidrome version from ping supports the plugin system (≥ 0.60). Unknown `type` stays permissive
 * until the first successful ping with metadata.
 */
export function isNavidromeAudiomuseSoftwareEligible(identity: SubsonicServerIdentity | undefined): boolean {
  if (!identity?.type?.trim()) return true;
  const t = identity.type.trim().toLowerCase();
  if (t !== 'navidrome') return false;
  const parsed = parseLeadingSemver(identity.serverVersion);
  if (!parsed) return true;
  return semverGte(parsed, NAVIDROME_MIN_FOR_PLUGINS);
}

/**
 * Whether to show the per-server AudioMuse (Navidrome plugin) toggle in Settings.
 * Uses software eligibility from ping plus an optional Instant Mix probe: if the server returns no
 * similar tracks for several random songs, the row stays hidden (typical when no plugin / no agents).
 */
export function showAudiomuseNavidromeServerSetting(
  identity: SubsonicServerIdentity | undefined,
  instantMixProbe: InstantMixProbeResult | undefined,
): boolean {
  if (!isNavidromeAudiomuseSoftwareEligible(identity)) return false;
  if (instantMixProbe === 'empty') return false;
  return true;
}
