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
  | 'unsupported'
  | 'error';

const NAVIDROME_MIN_FOR_PLUGINS: [number, number, number] = [0, 60, 0];
const NAVIDROME_MIN_FOR_SONIC_SIMILARITY: [number, number, number] = [0, 62, 0];

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

/** Navidrome ≥ 0.62 — `getOpenSubsonicExtensions` can list `sonicSimilarity`. */
export function isNavidromeSonicSimilarityEligible(identity: SubsonicServerIdentity | undefined): boolean {
  if (!isNavidromeServer(identity)) return false;
  const parsed = parseLeadingSemver(identity?.serverVersion);
  if (!parsed) return false;
  return semverGte(parsed, NAVIDROME_MIN_FOR_SONIC_SIMILARITY);
}

/** Navidrome ≥ 0.62 — AudioMuse is auto-enabled from the `sonicSimilarity` probe (no manual toggle). */
export function isAudiomusePluginAutoManaged(identity: SubsonicServerIdentity | undefined): boolean {
  return isNavidromeSonicSimilarityEligible(identity);
}

export type AudiomusePluginProbeUiStatus = 'checking' | 'active' | 'not_detected' | 'failed' | 'unknown';

export function resolveAudiomusePluginProbeUiStatus(
  probe: AudiomusePluginProbeResult | undefined,
): AudiomusePluginProbeUiStatus {
  switch (probe) {
    case 'present': return 'active';
    case 'probing': return 'checking';
    case 'absent': return 'not_detected';
    case 'error': return 'failed';
    default: return 'unknown';
  }
}

/**
 * Whether to show the per-server AudioMuse row in Settings.
 * Navidrome ≥ 0.62: always (status indicator). Older Navidrome: legacy Instant Mix probe gate.
 */
export function showAudiomuseNavidromeServerSetting(
  identity: SubsonicServerIdentity | undefined,
  instantMixProbe: InstantMixProbeResult | undefined,
  _pluginProbe: AudiomusePluginProbeResult | undefined,
): boolean {
  if (!isNavidromeAudiomuseSoftwareEligible(identity)) return false;
  if (isNavidromeSonicSimilarityEligible(identity)) return true;
  if (instantMixProbe === 'empty') return false;
  return true;
}
