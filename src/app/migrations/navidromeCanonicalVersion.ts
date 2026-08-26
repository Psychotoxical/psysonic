export const NAVIDROME_CANONICAL_PROVISIONAL_LEGACY_MAX = '0.63.2';

export type SuccessfulPingIdentity = Readonly<{
  type?: string | null;
  serverVersion?: string | null;
}>;

export type NavidromeCanonicalVersionClassification =
  | 'not-applicable'
  | 'legacy'
  | 'canonical'
  | 'retryable';

type StableVersion = readonly [major: number, minor: number, patch: number];

const PROVISIONAL_LEGACY_MAX: StableVersion = [0, 63, 2];
const EXACT_STABLE_VERSION_RE = /^\s*v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\s+\([0-9a-fA-F]{7,40}\))?\s*$/;

function parseExactStableVersion(value: string | null | undefined): StableVersion | null {
  if (!value) return null;
  const match = EXACT_STABLE_VERSION_RE.exec(value);
  if (!match) return null;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return version.every(Number.isSafeInteger) ? version : null;
}

function compareVersions(left: StableVersion, right: StableVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Only an exact stable Navidrome release may select a destructive migration path. */
export function classifyNavidromeCanonicalVersion(
  identity: SuccessfulPingIdentity,
): NavidromeCanonicalVersionClassification {
  if (identity.type?.trim().toLowerCase() !== 'navidrome') return 'not-applicable';
  const version = parseExactStableVersion(identity.serverVersion);
  if (!version) return 'retryable';
  return compareVersions(version, PROVISIONAL_LEGACY_MAX) <= 0 ? 'legacy' : 'canonical';
}
